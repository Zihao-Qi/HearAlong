// End times of local recognizer words, so a word does not last through the silence after it.
import type { Pass, Word } from './recovery.ts';

/**
 * The local recognizer (Parakeet TDT) ends a word with its last token, and that token's duration absorbs the blank frames
 * after it: a word before a pause lasts through the pause. Measured on one local database (21,590 words): most words last
 * 80 ms (median), but words that are not the last in their chunk reach p90 320 ms, p99 1.4 s, max 7.5 s, and 481 of the 489
 * such words over 1 s end a sentence, with the next word starting right after the stretched end. Last words in a chunk ran
 * up to 21 s (to the window end) in a call benchmark, while their audio energy ended a median 0.94 s after the word's start.
 * A cap scaled by length keeps real long words and drops the absorbed pause.
 */
export const WORD_MS_PER_CHARACTER = 90;
export const MIN_WORD_MS = 400;
export const MAX_WORD_MS = 1200;

/** Longest plausible duration of one spoken word: 90 ms per character of the trimmed text, within 400–1200 ms. */
export function wordCapMs(text: string): number {
  return Math.min(MAX_WORD_MS, Math.max(MIN_WORD_MS, WORD_MS_PER_CHARACTER * [...text.trim()].length));
}

/** The word with its end at most its cap after its start. The start never moves; an end already before the cap is kept. */
export function capWordEnd<T extends Word>(word: T): T {
  if (!Number.isFinite(word.t0Ms) || !Number.isFinite(word.t1Ms) || typeof word.text !== 'string') return word;
  const end = word.t0Ms + wordCapMs(word.text);
  return word.t1Ms > end ? { ...word, t1Ms: end } : word;
}

/**
 * One recognition pass with capped word ends. A native segment ends at most at the latest capped end of the words that
 * start inside it; a segment with no words keeps its end.
 */
export function capPass(pass: Pass): Pass {
  const words = pass.words.map(capWordEnd);
  if (!pass.segments) return { ...pass, words };
  const segments = pass.segments.map(segment => {
    if (!Number.isFinite(segment.t0Ms) || !Number.isFinite(segment.t1Ms)) return segment;
    let end = -Infinity;
    for (const word of words) {
      if (word.t0Ms >= segment.t0Ms && word.t0Ms < segment.t1Ms && Number.isFinite(word.t1Ms)) end = Math.max(end, word.t1Ms);
    }
    return end > -Infinity && end < segment.t1Ms ? { ...segment, t1Ms: Math.max(end, segment.t0Ms) } : segment;
  });
  return { ...pass, words, segments };
}
