import { composePreview } from '../public/preview-composition.js';
import type { Draft, PendingDraft } from './drafts.ts';
import { echoWords, commonWords, type EchoWord } from './echo-words.ts';

/** Presentation-only, per poll. Never mutates recognizer hypotheses or retires hidden pending words. */
export function filterPreviewEchoes<D extends Omit<Draft, 'meetingId'>, P extends Omit<PendingDraft, 'meetingId'>>(
  drafts: D[], pending: P[], callSources: string[], finals: EchoWord[], clockMs: number): { drafts: D[]; pending: P[] } {
  if (!callSources.length) return { drafts, pending };
  const calls = new Set(callSources);
  const callRuns = composePreview(drafts.filter(d => calls.has(d.source)), pending.filter(p => calls.has(p.source)));
  const reference = [...finals.filter(w => w.endMs >= clockMs - 10000 && w.startMs <= clockMs),
    ...callRuns.flatMap(run => run.words)]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs).flatMap(w => echoWords(w.text));
  if (!reference.length) return { drafts, pending };
  const mic = composePreview(drafts.filter(d => d.source.startsWith('mic:')), pending.filter(p => p.source.startsWith('mic:')));
  const bySource = new Map<string, EchoWord[]>();
  for (const run of mic) bySource.set(run.source, [...bySource.get(run.source) ?? [], ...run.words]);
  const hidden = new Set<string>();
  for (const [source, words] of bySource) {
    const own = words.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs).flatMap(w => echoWords(w.text)).slice(-20);
    if (own.length >= 3 && commonWords(own, reference) * 5 >= own.length * 4) hidden.add(source);
  }
  // Keep the active worker's metadata/heartbeat: omission would falsely report "no preview for the mic" after ten seconds.
  return { drafts: drafts.map(d => hidden.has(d.source) ? { ...d, text: '', words: [] } : d),
    pending: pending.filter(p => !hidden.has(p.source)) };
}
