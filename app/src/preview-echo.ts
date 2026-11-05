import { composePreview } from '../public/preview-composition.js';
import type { Draft, PendingDraft } from './drafts.ts';
import { echoWords, commonWords, type EchoWord } from './echo-words.ts';

/** Presentation-only, per poll. Never mutates recognizer hypotheses or retires hidden pending words. */
export function filterPreviewEchoes<D extends Omit<Draft, 'meetingId'>, P extends Omit<PendingDraft, 'meetingId'>>(
  drafts: D[], pending: P[], callSources: string[], finals: EchoWord[], clockMs: number,
  failedChunks: ReadonlySet<string> = new Set()): { drafts: D[]; pending: P[] } {
  const usablePending = pending.filter(p => !failedChunks.has(p.chunkId));
  if (!callSources.length) return { drafts, pending: usablePending };
  const calls = new Set(callSources);
  const callRuns = composePreview(drafts.filter(d => calls.has(d.source)), usablePending.filter(p => calls.has(p.source)));
  const reference = [...finals.filter(w => w.endMs >= clockMs - 10000 && w.startMs <= clockMs),
    ...callRuns.flatMap(run => run.words)].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  // Each original block owns its own decision. A matching newer tail must not hide older, unrelated speech.
  const echoed = (block: D | P): boolean => {
    if (!block.source.startsWith('mic:')) return false;
    const own = block.words.flatMap(w => echoWords(w.text)).slice(-20);
    if (own.length < 3) return false;
    let end = block.coveredUntilMs;
    for (const word of block.words) end = Math.max(end, word.endMs);
    if ('cutMs' in block) end = Math.max(end, block.cutMs);
    const from = block.windowStartMs - 3000, until = end + 3000;
    const nearby = reference.filter(w => w.endMs >= from && w.startMs <= until).flatMap(w => echoWords(w.text));
    return commonWords(own, nearby) * 5 >= own.length * 4;
  };
  // Keep the active worker's metadata/heartbeat: omission would falsely report "no preview for the mic" after ten seconds.
  return { drafts: drafts.map(d => echoed(d) ? { ...d, text: '', words: [] } : d),
    pending: usablePending.filter(p => !echoed(p)) };
}
