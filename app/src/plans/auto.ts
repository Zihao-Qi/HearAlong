// Automatic planning (M7b §1 decision 1, §2b "Out of date, and automatic planning"): per project, "plan after the notes", off
// by default. One automatic attempt per notes version, recorded durably before it is submitted; a newer notes version replaces
// a waiting automatic run; a manual Plan replaces a waiting automatic one and is never cancelled by turning the setting off.
// Changes to the notes, memory or materials only label plans out of date; they never start a run by themselves.
// The decisions are pure; the caller cancels and submits through Explorations.
import type { MeetingStore } from '../store.ts';

export type PlanRun = { id: string; state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'stopped' | 'interrupted'; origin: 'auto' | 'manual'; notesVersion: number | null };
export type AutoDecision = { cancel: string[]; submit: boolean; reason: string };

const waiting = (runs: PlanRun[], origin?: PlanRun['origin']) => runs.filter(r => r.state === 'waiting' && (!origin || r.origin === origin));

/**
 * New notes were saved (or a plan run ended, so a deferred attempt may go now). `attempted`: this notes version already had
 * its automatic attempt. A running plan run is left alone; the attempt waits for it (one plan run per meeting at a time).
 */
export function onNotes(input: { enabled: boolean; notesVersion: number; attempted: boolean; runs: PlanRun[] }): AutoDecision {
  const none = (reason: string): AutoDecision => ({ cancel: [], submit: false, reason });
  if (!input.enabled) return none('automatic planning is off');
  if (input.attempted) return none('this notes version was already planned automatically');
  if (waiting(input.runs, 'manual').length) return none('a Plan the user asked for is waiting, and reads the newest notes');
  if (input.runs.some(r => r.state === 'running')) return none('a plan run is running; try again when it ends');
  const older = waiting(input.runs, 'auto').filter(r => r.notesVersion !== input.notesVersion);
  if (waiting(input.runs, 'auto').some(r => r.notesVersion === input.notesVersion)) return none('already waiting for these notes');
  return { cancel: older.map(r => r.id), submit: true, reason: older.length ? 'newer notes replace the waiting automatic run' : 'plan after the notes' };
}
/** The user pressed Plan: a waiting automatic run gives way to it. */
export function onManualPlan(runs: PlanRun[]): { cancel: string[] } { return { cancel: waiting(runs, 'auto').map(r => r.id) }; }
/** The setting was turned off: only waiting automatic runs are cancelled; a running one and the user's own go on. */
export function onSettingOff(runs: PlanRun[]): { cancel: string[] } { return { cancel: waiting(runs, 'auto').map(r => r.id) }; }

/** The durable record of automatic attempts, one per meeting and notes version. */
export class AutoPlanning {
  private store: MeetingStore;
  private clock: () => number;
  constructor(store: MeetingStore, clock: () => number = Date.now) {
    this.store = store; this.clock = clock;
    store.db.exec(`CREATE TABLE IF NOT EXISTS plan_auto_attempts (meetingId TEXT NOT NULL, notesVersion INTEGER NOT NULL, run TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (meetingId, notesVersion))`);
  }
  attempted(meetingId: string, notesVersion: number) {
    return Boolean(this.store.db.prepare('SELECT 1 FROM plan_auto_attempts WHERE meetingId=? AND notesVersion=?').get(meetingId, notesVersion));
  }
  /** Claims the attempt for this notes version before submitting; false when it was already claimed (never twice, even across restarts). */
  claim(meetingId: string, notesVersion: number): boolean {
    const result = this.store.db.prepare('INSERT OR IGNORE INTO plan_auto_attempts (meetingId, notesVersion, run, at) VALUES (?,?,NULL,?)').run(meetingId, notesVersion, this.clock());
    return Number(result.changes) === 1;
  }
  /** A submission that failed before it had a run can be tried again. Never release an actual run. */
  release(meetingId: string, notesVersion: number) {
    this.store.db.prepare('DELETE FROM plan_auto_attempts WHERE meetingId=? AND notesVersion=? AND run IS NULL').run(meetingId, notesVersion);
  }
  /** The run the attempt submitted, once it has an id. */
  started(meetingId: string, notesVersion: number, run: string) {
    this.store.db.prepare('UPDATE plan_auto_attempts SET run=? WHERE meetingId=? AND notesVersion=?').run(run, meetingId, notesVersion);
  }
  attempts(meetingId: string) {
    return this.store.db.prepare('SELECT notesVersion, run, at FROM plan_auto_attempts WHERE meetingId=? ORDER BY notesVersion').all(meetingId)
      .map(r => ({ ...r }) as { notesVersion: number; run: string | null; at: number });
  }
}
