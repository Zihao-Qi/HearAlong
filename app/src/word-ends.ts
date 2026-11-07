// End times of local recognizer words, so a word does not last through the silence after it.
import type { Pass, Word } from './recovery.ts';
import { usableTimes } from './segments.ts';

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

/**
 * A number or a spelled-out acronym is said one symbol or letter at a time, so a cap per written character is far too short:
 * "2.1.3" takes about 1 s to say. In real data, 66% of the capped words containing a digit had a real gap after their original end,
 * so a character cap invented pauses there and split lines mid-sentence. These words get about 300 ms per spoken symbol.
 */
export const MS_PER_SPOKEN_SYMBOL = 300;
export const MAX_NUMBER_MS = 2500;
export const MAX_ACRONYM_MS = 2000;
const SPOKEN_SYMBOLS = /[0-9%$€£#&+@]/gu;

const clamp = (ms: number, max: number) => Math.min(max, Math.max(MIN_WORD_MS, ms));

/**
 * Longest plausible duration of one spoken word. A word with a digit: 300 ms per digit or symbol (`0-9 % $ € £ # & + @`), within
 * 400–2500 ms. An acronym (2–6 letters once non-letters are removed, all uppercase): 300 ms per letter, within 400–2000 ms.
 * Anything else: 90 ms per character of the trimmed text, within 400–1200 ms.
 */
export function wordCapMs(text: string): number {
  const trimmed = text.trim();
  if (/\d/u.test(trimmed)) return clamp(MS_PER_SPOKEN_SYMBOL * Math.max(1, trimmed.match(SPOKEN_SYMBOLS)?.length ?? 0), MAX_NUMBER_MS);
  const letters = trimmed.replace(/\P{L}/gu, '');
  if (letters.length >= 2 && letters.length <= 6 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return clamp(MS_PER_SPOKEN_SYMBOL * letters.length, MAX_ACRONYM_MS);
  }
  return clamp(WORD_MS_PER_CHARACTER * [...trimmed].length, MAX_WORD_MS);
}

/** The word with its end at most its cap after its start. The start never moves; an end already before the cap is kept. */
export function capWordEnd<T extends Word>(word: T): T {
  if (!Number.isFinite(word.t0Ms) || !Number.isFinite(word.t1Ms) || typeof word.text !== 'string') return word;
  const end = word.t0Ms + wordCapMs(word.text);
  return word.t1Ms > end ? { ...word, t1Ms: end } : word;
}

const spoken = (word: Word) => typeof word.text === 'string' && word.text.trim() !== '';

/**
 * One recognition pass (of a `windowMs` long window) with capped word ends. A native segment ends at most at the latest capped
 * end of the spoken words that start inside it; a segment with no such words keeps its end. Segments are shortened only when
 * publication would use the word times (`usableTimes`): otherwise the segments are what it publishes, with their ends as recognized.
 */
export function capPass(pass: Pass, windowMs: number): Pass {
  const words = pass.words.map(capWordEnd);
  if (!pass.segments || !usableTimes(words, windowMs)) return { ...pass, words };
  const spokenWords = words.filter(spoken);
  const segments = pass.segments.map(segment => {
    if (!Number.isFinite(segment.t0Ms) || !Number.isFinite(segment.t1Ms)) return segment;
    let end = -Infinity;
    for (const word of spokenWords) {
      if (word.t0Ms >= segment.t0Ms && word.t0Ms < segment.t1Ms) end = Math.max(end, word.t1Ms);
    }
    return end > -Infinity && end < segment.t1Ms ? { ...segment, t1Ms: Math.max(end, segment.t0Ms) } : segment;
  });
  return { ...pass, words, segments };
}
