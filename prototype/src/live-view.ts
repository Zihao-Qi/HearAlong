// What the mini view knows about the recording beyond its audio (docs/design/M7-native-mini.md §3–5): a Stop asked from either
// window, whether the meeting tab's share ended, how far saving is behind, a card to open in the app, and whether the mini window
// is open. Kept per recording: each frame names its recording (a new id at every Start), so a reload or a new Start is never
// taken for the recording before it.
import { NOTICES, SAVING_BEHIND_FRAMES, type Notice } from '../public/live-shared.js';

export type MiniState = 'auto' | 'open' | 'closed';
export type MiniAction = 'away' | 'open' | 'closed';
type Session = { id: number; recording: string | null; sources: Set<string>; state: MiniState; tabEnded: boolean; stop: Set<string> | null; clockStart: number | null };

export class LiveView {
  private session: Session = { id: 0, recording: null, sources: new Set(), state: 'auto', tabEnded: false, stop: null, clockStart: null };
  private pending = new Map<string, number>();
  private helperSeenAt = -Infinity;
  private reveals = new Map<string, { cardId: string; n: number; at: number }>();
  private revealCount = 0;
  private clock: () => number;
  constructor(clock: () => number = Date.now) { this.clock = clock; }

  private seen = new Set<string>(); // recordings that have had their turn: a late frame of one never brings it back
  /** Whether a source belongs to the recording now. */
  has(source: string): boolean { return this.session.sources.has(source); }
  /**
   * Whether a request names the recording now: by its number (the mini view, the helper) or by sources of it (the app's page).
   * A request about an earlier recording, which may arrive late, never touches a new one.
   */
  current(request: { session?: unknown; sources?: unknown }): boolean {
    if (typeof request.session === 'number') return request.session === this.session.id && this.session.sources.size > 0;
    return Array.isArray(request.sources) && request.sources.some(s => typeof s === 'string' && this.session.sources.has(s));
  }
  /** A Stop asked from either window, for the sources live now: their frames' replies say stop until the page has stopped. */
  stop(live: string[]) {
    this.session.stop = new Set([...(this.session.stop ?? []), ...live]);
  }
  /** The sources asked to stop (the app's page also reads them from its transcript poll, in case its uploads are stuck). */
  stopped(): string[] { return [...this.session.stop ?? []]; }
  /** Which recording this is: changes with each new recording. */
  sessionId(): number { return this.session.id; }
  stopping(): boolean { return Boolean(this.session.stop); }
  /** For a frame's reply: whether its page should stop (a Stop was asked while this source was live). */
  stopFor(source: string): boolean { return Boolean(this.session.stop?.has(source)); }
  /**
   * Each frame names its recording, says how many frames of its source wait in the page, and when the recording's time 0 was on
   * the wall clock (the page's start and the meeting's earlier audio), so the clock is the page's own, right even while frames
   * arrive late. A frame of a new recording starts a new session; a frame of an earlier one is not counted (it is late or stale).
   */
  frame(source: string, recording: string | null, pending: number | null, clockStart: number | null) {
    const id = recording ?? `source ${source}`; // a page that does not name its recording: each source on its own
    if (id !== this.session.recording) {
      if (this.seen.has(id)) return;
      if (this.session.recording) this.seen.add(this.session.recording);
      for (const old of this.session.sources) this.pending.delete(old);
      this.session = { id: this.session.id + 1, recording: id, sources: new Set(), state: 'auto', tabEnded: false, stop: null, clockStart: null };
    }
    this.session.sources.add(source);
    if (pending !== null) this.pending.set(source, pending);
    if (clockStart !== null) this.session.clockStart = clockStart;
  }
  /** The recording's time now, from the page's clock; null before a frame has said it. */
  clockMs(): number | null { return this.session.clockStart === null ? null : Math.max(0, this.clock() - this.session.clockStart); }
  /** A source's end; a meeting tab that ended while nothing asked to stop means its share ended. */
  ended(source: string, stopping: boolean) {
    this.pending.delete(source);
    if (source.startsWith('tab:') && !stopping && !this.session.stop && this.session.sources.has(source)) this.session.tabEnded = true;
  }
  /** Problems with the recording now, most urgent first (`live` as LiveCapture.liveSources). */
  notices(live: { source: string; quiet: boolean; late?: boolean }[]): Notice[] {
    const notices: Notice[] = [];
    const mine = live.filter(s => this.session.sources.has(s.source));
    if (this.session.tabEnded && !mine.some(s => s.source.startsWith('tab:'))) notices.push(NOTICES.tabEnded);
    // Behind by the page's own count, or by frames that stopped arriving (a stuck upload sends no new count).
    if (mine.some(s => s.late || (this.pending.get(s.source) ?? 0) >= SAVING_BEHIND_FRAMES)) notices.push(NOTICES.savingBehind);
    for (const s of mine) if (s.quiet) notices.push(s.source.startsWith('tab:') ? NOTICES.quietTab : NOTICES.quietMic);
    return notices;
  }

  /**
   * The window: opened by the app's button, or by itself when the user leaves the app (once per recording, and only when the
   * user allows it in Settings: the server then passes 'away' on), or closed by hand.
   */
  mini(action: MiniAction) {
    if (action === 'away') { if (this.session.state === 'auto') this.session.state = 'open'; }
    else this.session.state = action;
  }
  miniState(): MiniState { return this.session.state; }
  /** The helper asks about its window twice a second; while it does, the mini view is the helper's native window. */
  helperSeen() { this.helperSeenAt = this.clock(); }
  native(): boolean { return this.clock() - this.helperSeenAt < 3000; }

  /** A card clicked in the mini view, for the app page to open once (each request has its own number). */
  reveal(meetingId: string, cardId: string) { this.reveals.set(meetingId, { cardId, n: ++this.revealCount, at: this.clock() }); }
  /** The latest card to open for a meeting, if asked within the last 10 s (a page that comes later does not open an old one). */
  revealFor(meetingId: string): { cardId: string; n: number } | null {
    const r = this.reveals.get(meetingId);
    return r && this.clock() - r.at < 10_000 ? { cardId: r.cardId, n: r.n } : null;
  }
}
