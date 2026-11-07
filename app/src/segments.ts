// Turns one chunk's recognition into readable, timed transcript segments.
import type { Word } from './recovery.ts';

export type Timing = 'word' | 'segment' | 'chunk';
export type DraftSegment = { startMs: number; endMs: number; text: string; timing: Timing; words?: Timed[] };
type Timed = { text: string; t0Ms: number; t1Ms: number };

const PAUSE_MS = 700; // Maximum inter-word pause for a grouped sentence.
// A 1–2 word sentence ("Okay.") stays with the next one unless this pause follows it. Word ends no longer absorb the silence after
// them (word-ends.ts), so short pauses that used to be hidden are visible; at 150 ms they turned many short sentences into their own rows.
const SHORT_SENTENCE_PAUSE_MS = 400;
const SOFT_WORDS = 30; // past this, end at the next comma
const HARD_WORDS = 45;

const DRIFT_MS = 250; // tolerated boundary drift; anything worse means the timings are not trustworthy

/**
 * Clamp small drift into the window; returns null (→ next fallback) when timings are clearly wrong.
 * Items without text are skipped: the recognizer occasionally emits an empty word among good ones.
 */
function usable(items: Timed[] | undefined, windowMs: number): Timed[] | null {
  if (!items?.length) return null;
  const out: Timed[] = [];
  let last = 0;
  let lastEnd = 0;
  for (const item of items) {
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    if (!Number.isFinite(item.t0Ms) || !Number.isFinite(item.t1Ms)) return null;
    if (item.t0Ms < -DRIFT_MS || item.t1Ms > windowMs + DRIFT_MS || item.t1Ms < item.t0Ms - DRIFT_MS
      || item.t0Ms < last - DRIFT_MS || item.t1Ms < lastEnd - DRIFT_MS) return null;
    lastEnd = Math.max(lastEnd, item.t1Ms);
    const t0 = Math.min(Math.max(item.t0Ms, last), windowMs);
    const t1 = Math.min(Math.max(item.t1Ms, t0), windowMs);
    out.push({ text: item.text.trim(), t0Ms: t0, t1Ms: t1 });
    last = t0;
  }
  return out.length ? out : null;
}

/** The short-sentence pause that saved lines published before SHORT_SENTENCE_PAUSE_MS; reconstruction of those chunks needs it. */
export const EARLIER_SHORT_SENTENCE_PAUSE_MS = 150;

function sentences(words: Timed[], keepWords = false, shortPauseMs = SHORT_SENTENCE_PAUSE_MS): DraftSegment[] {
  const out: DraftSegment[] = [];
  let current: Timed[] = [];
  const flush = () => {
    if (!current.length) return;
    out.push({ startMs: current[0].t0Ms, endMs: current.at(-1)!.t1Ms, text: current.map(w => w.text).join(' '), timing: 'word', ...(keepWords ? { words: current } : {}) });
    current = [];
  };
  words.forEach((word, index) => {
    current.push(word);
    const next = words[index + 1];
    if (!next) return;
    const gap = next.t0Ms - word.t1Ms;
    const ends = /[.?!]["')\]]*$/.test(word.text) && !/^\d+\.$/.test(word.text);
    if ((ends && (current.length >= 3 || gap >= shortPauseMs)) || gap >= PAUSE_MS
      || (current.length >= SOFT_WORDS && /[,;:]$/.test(word.text)) || current.length >= HARD_WORDS) flush();
  });
  flush(); // The chunk tail is always published, however short.
  return out;
}

/**
 * Reconstruct the original per-segment words from chunk.metrics.words, with the same clamping/grouping as publication.
 * `shortPauseMs` reproduces lines saved under an earlier short-sentence rule.
 */
export function wordSegments(windowMs: number, words: Word[] | undefined, shortPauseMs = SHORT_SENTENCE_PAUSE_MS): DraftSegment[] {
  const valid = usable(words, windowMs);
  return valid ? sentences(valid, true, shortPauseMs) : [];
}

/**
 * Preference order: word timings → native segment timings → one coarse segment for the chunk.
 * Times are relative to the chunk; callers add the chunk's start.
 */
export function buildSegments(windowMs: number, recognition: { text: string; words?: Word[]; segments?: Timed[] }): DraftSegment[] {
  const text = recognition.text.trim();
  if (!text) return [];
  const words = usable(recognition.words, windowMs);
  if (words) return sentences(words);
  const native = usable(recognition.segments, windowMs);
  if (native) return native.map(s => ({ startMs: s.t0Ms, endMs: s.t1Ms, text: s.text, timing: 'segment' }));
  return [{ startMs: 0, endMs: windowMs, text, timing: 'chunk' }];
}
