import { composePreview } from '../public/preview-composition.js';
import type { Draft, PendingDraft } from './drafts.ts';
import { echoWords, commonWords, type EchoWord } from './echo-words.ts';

const RECENT_FINALS_MS = 10000;
const SLACK_MS = 3000;

type MicBlock = { source: string; windowStartMs: number; words: { text: string; startMs: number }[] };

/**
 * The words a mic block is judged by (its last twenty), and the earliest call time they are compared with: three seconds before
 * the later of the window start and the first checked word. Undefined when the block can never be judged an echo.
 */
function checked(block: MicBlock): { own: string[]; fromMs: number } | undefined {
  if (!block.source.startsWith('mic:')) return undefined;
  const tokens = block.words.flatMap(w => echoWords(w.text).map(text => ({ text, startMs: w.startMs }))).slice(-20);
  if (tokens.length < 3) return undefined;
  return { own: tokens.map(t => t.text), fromMs: Math.max(block.windowStartMs, tokens[0].startMs) - SLACK_MS };
}

/**
 * The earliest call-final end that can still matter: the last ten seconds, extended back to cover the checked words of every open or
 * pending mic window (a window stays open or pending 16–24 s, and call words now end when they are spoken, not at the next word).
 */
export function callFinalsFromMs(drafts: MicBlock[], pending: MicBlock[], clockMs: number): number {
  let from = clockMs - RECENT_FINALS_MS;
  for (const block of [...drafts, ...pending]) {
    const judged = checked(block);
    if (judged) from = Math.min(from, judged.fromMs);
  }
  return from;
}

/** Presentation-only, per poll. Never mutates recognizer hypotheses or retires hidden pending words. */
export function filterPreviewEchoes<D extends Omit<Draft, 'meetingId'>, P extends Omit<PendingDraft, 'meetingId'>>(
  drafts: D[], pending: P[], callSources: string[], finals: EchoWord[], clockMs: number,
  failedChunks: ReadonlySet<string> = new Set()): { drafts: D[]; pending: P[] } {
  const usablePending = pending.filter(p => !failedChunks.has(p.chunkId));
  if (!callSources.length) return { drafts, pending: usablePending };
  const calls = new Set(callSources);
  const callRuns = composePreview(drafts.filter(d => calls.has(d.source)), usablePending.filter(p => calls.has(p.source)));
  const fromMs = callFinalsFromMs(drafts, usablePending, clockMs);
  const reference = [...finals.filter(w => w.endMs >= fromMs && w.startMs <= clockMs),
    ...callRuns.flatMap(run => run.words)].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  // Each original block owns its own decision. A matching newer tail must not hide older, unrelated speech.
  const echoed = (block: D | P): boolean => {
    const judged = checked(block);
    if (!judged) return false;
    const { own, fromMs: from } = judged;
    let end = block.coveredUntilMs;
    for (const word of block.words) end = Math.max(end, word.endMs);
    if ('cutMs' in block) end = Math.max(end, block.cutMs);
    const until = end + SLACK_MS;
    const nearby = reference.filter(w => w.endMs >= from && w.startMs <= until).flatMap(w => echoWords(w.text));
    return commonWords(own, nearby) * 5 >= own.length * 4;
  };
  // Keep the active worker's metadata/heartbeat: omission would falsely report "no preview for the mic" after ten seconds.
  return { drafts: drafts.map(d => echoed(d) ? { ...d, text: '', words: [] } : d),
    pending: usablePending.filter(p => !echoed(p)) };
}
