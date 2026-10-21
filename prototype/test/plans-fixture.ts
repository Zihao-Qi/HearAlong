// Shared test data for the plan domain (test/plans*.test.ts): a small meeting's notes, a materials folder, and tool results
// shaped as Pi returns them. Invented content only; nothing from an evaluation meeting.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NoteItem, Section } from '../src/notes.ts';
import type { ToolResult } from '../src/pi-task.ts';
import { EvidenceRecorder, buildPlanInput, materialLocator, planRoots, type NotesLike, type PlanInput, type PlanPins } from '../src/plans/index.ts';

export const LINES = Array.from({ length: 40 }, (_, i) => `Log entry ${i + 1} records the cupboard inventory and cleaning supplies.`);
LINES[11] = 'Reopen the kiln room at quarter past two after the latch inspection.';
LINES[13] = 'The spare shelf rests on a padded trolley beside the blue cupboard.';
LINES[29] = 'The caretaker collects the used access cards in a brass tray each evening.';
export const PAGE_TEXT = 'The kiln room door must remain locked until the caretaker has inspected the latch and signed the green access card.';
export const LINE_TEXT = ['', 'is the kiln room reopening before the afternoon pottery class', 'Vesper will photograph the cracked shelf before the caretaker arrives', 'the pottery class needs a safe place to leave its coats'];

const note = (section: Section, text: string, cites: string[], owner: string | null = null): NoteItem =>
  ({ text, cites, startMs: 0, quote: '', quoteIn: 'corrected', section, ...(section === 'actions' ? { owner } : {}) });
export function notes(extra: Partial<Record<'openQuestions' | 'actions' | 'decisions' | 'summary', NoteItem[]>> = {}): NotesLike & { title: string } {
  return {
    title: 'Kiln room handover',
    notes: {
      suggestedTitle: null, otherMatters: [], needsReview: [], otherTalk: [],
      openQuestions: extra.openQuestions ?? [note('openQuestions', 'When can the kiln room reopen?', ['seg2'])],
      actions: extra.actions ?? [note('actions', 'Photograph the cracked shelf before the caretaker arrives', ['seg3'], 'Vesper')],
      decisions: extra.decisions ?? [],
      summary: extra.summary ?? [note('summary', 'The class needs coat storage away from the kiln room', ['seg1'])],
    },
    sources: {
      seg1: { startMs: 60_000, endMs: 64_000, text: LINE_TEXT[3], originalText: LINE_TEXT[3], revision: 0 },
      seg2: { startMs: 10_000, endMs: 14_000, text: LINE_TEXT[1], originalText: LINE_TEXT[1], revision: 0 },
      seg3: { startMs: 30_000, endMs: 34_000, text: LINE_TEXT[2], originalText: 'ves per will photograph the cracked shelf before the caretaker arrives', revision: 0 },
    },
  };
}
export { note };
export const PINS: PlanPins = { notesVersion: 1, notesWarnings: [], memoryStamp: 'm1', manifest: 'digest-1', project: 'project-a' };

let calls = 0;
export const tool = (name: string, args: unknown, text: string, extra: Partial<ToolResult> = {}): ToolResult => ({ id: `call-${++calls}`, name, args, text, isError: false, ...extra });
/** A read as Pi returns it: the lines from `offset`, then its notice when lines are left. */
export function readResult(path: string, offset: number, limit: number, lines = LINES) {
  const shown = lines.slice(offset - 1, offset - 1 + limit);
  const left = lines.length - (offset - 1 + shown.length);
  return tool('read', { path, offset, limit }, `${shown.join('\n')}${left > 0 ? `\n\n[${left} more lines in file. Use offset=${offset + shown.length} to continue.]` : ''}`);
}
export const fetchResult = (url: string, content = PAGE_TEXT) => tool('fetch_content', { url }, content, { structured: { urls: [{ url, title: 'Kiln room access handbook', content }] } });
export const pythonResult = (run: number, ok = true) => tool('run_python', { code: `print(${run})` }, ok ? `${run}` : 'exit 1\nTraceback', {
  isError: !ok, details: { runNumber: run, script: `run-${run}.py`, status: ok ? 'exit 0' : 'exit 1', stdout: ok ? `${run}\n` : '', stderr: ok ? '' : 'Traceback' } });

export type Fixture = { folder: string; materials: string; file: string; run: string; cwd: string; input: PlanInput; evidence: EvidenceRecorder; close(): Promise<void> };
export async function fixture(options: { limits?: ConstructorParameters<typeof EvidenceRecorder>[1]['limits']; notes?: NotesLike } = {}): Promise<Fixture> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'meeting-plans-')));
  const materials = join(folder, 'materials');
  await mkdir(join(materials, 'notes'), { recursive: true });
  const file = join(materials, 'notes', 'plan.md');
  await writeFile(file, LINES.join('\n'));
  const run = join(folder, 'run'), cwd = join(folder, 'scratch');
  await mkdir(run); await mkdir(cwd);
  const roots = planRoots([{ id: 'root-a', scope: 'meeting:m1', path: materials, kind: 'folder', label: 'materials' }]);
  const input = buildPlanInput({ notes: options.notes ?? notes(), roots });
  if ('refused' in input) throw new Error(input.refused);
  const evidence = new EvidenceRecorder(run, { cwd, locate: materialLocator({ roots }), limits: options.limits });
  return { folder, materials, file, run, cwd, input, evidence, close: () => rm(folder, { recursive: true, force: true }) };
}

/** A raw plan as the model writes it (prompt v1.7), with the parts a test changes. */
export function rawPlan(over: Record<string, unknown> = {}) {
  return {
    label: 'Room access', answerLine: 'After the latch inspection, at 14:15', stepLine: 'Hang the signed access card', question: 'When can the kiln room reopen?',
    from: ['N1', 'S1'], owner: null,
    stateNow: [{ id: 'k1', text: 'The handover log sets a reopening time after inspection', source: { type: 'file', path: 'R1/notes/plan.md', line: 12, quote: 'reopen the kiln room at quarter past two after the latch inspection' } }],
    answer: { text: 'At 14:15, after the latch inspection', complete: true, open: null, basis: ['k1'] },
    next: { text: 'Hang the green access card beside the kiln room door', basis: ['k1'] },
    followOn: [], changeIf: 'A red fault light on the latch', checks: [], waitingOn: [], decideAfter: [], further: null,
    ...over,
  };
}
