// Word categories are diagnostic, not disjoint. Only singleSpeaker excludes overlap and short turns.
import type { ReferenceWord } from './ami.ts';
import { backtrace, normalize, normalizeReference, score, type WerResult } from './wer.ts';

export type WordFlags = { overlap: boolean; shortTurn: boolean; chunkEdge: boolean };
export type Breakdown = {
  singleSpeaker: WerResult;
  overlap: WerResult;
  shortTurn: WerResult;
  chunkEdge: WerResult;
  overlapDeletionShare: number;
};

/** Strict temporal overlap, same-speaker gaps <1.5 s form a turn, inclusive 1 s edge radius. */
export function classifyWords(words: ReferenceWord[]): WordFlags[] {
  const flags = words.map(word => ({
    overlap: words.some(other => other.speaker !== word.speaker && other.start < word.end && other.end > word.start),
    shortTurn: false,
    chunkEdge: Math.min(word.start % 20, 20 - word.start % 20) <= 1,
  }));
  for (const speaker of new Set(words.map(word => word.speaker))) {
    const indices = words.flatMap((word, i) => word.speaker === speaker ? [i] : []).sort((a, b) => words[a].start - words[b].start);
    let start = 0;
    for (let k = 1; k <= indices.length; k++) {
      if (k === indices.length || words[indices[k]].start - words[indices[k - 1]].end >= 1.5) {
        for (let q = start; q < k; q++) flags[indices[q]].shortTurn = k - start <= 2;
        start = k;
      }
    }
  }
  return flags;
}

export function scoreBreakdown(reference: ReferenceWord[], hypothesis: string): { overall: WerResult; breakdown: Breakdown } {
  const words = normalizeReference(reference);
  const flags = classifyWords(words);
  const empty = (): WerResult => ({ substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceWords: 0, wer: 0 });
  const overall = empty();
  const categories = { singleSpeaker: empty(), overlap: empty(), shortTurn: empty(), chunkEdge: empty() };
  for (const step of backtrace(words.map(word => word.text), normalize(hypothesis))) {
    overall[step.kind]++;
    if (step.kind !== 'insertions') overall.referenceWords++;
    if (step.referenceIndex === null) continue;
    const flag = flags[step.referenceIndex];
    const belongs = { ...flag, singleSpeaker: !flag.overlap && !flag.shortTurn };
    for (const key of Object.keys(categories) as (keyof typeof categories)[]) {
      if (!belongs[key]) continue;
      categories[key][step.kind]++;
      if (step.kind !== 'insertions') categories[key].referenceWords++;
    }
  }
  for (const item of [overall, ...Object.values(categories)]) item.wer = score(item, item.referenceWords, item.hits + item.substitutions + item.insertions);
  return { overall, breakdown: { ...categories, overlapDeletionShare: overall.deletions ? categories.overlap.deletions / overall.deletions : 0 } };
}

export function sumScores(items: WerResult[]): WerResult {
  const total: WerResult = { substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceWords: 0, wer: 0 };
  for (const item of items) for (const key of ['substitutions', 'deletions', 'insertions', 'hits', 'referenceWords'] as const) total[key] += item[key];
  total.wer = score(total, total.referenceWords, total.hits + total.substitutions + total.insertions);
  return total;
}
