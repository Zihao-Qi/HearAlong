// Word error rate for the AMI benchmark. WER = (S + D + I) / N, with N the reference length after normalization.
//
// Normalizer, applied to both sides, in order:
// 1. Unicode NFKC. Curly apostrophes (U+2018, U+2019, U+201A, U+201B, U+2032, U+2035, U+02BC)
//    become "'". Hyphens U+2010 and U+2011 become "-". NFKC does not fold those, and transcripts use them.
// 2. Join AMI letter sequences (T_V_ → tv, T_V_s → tvs) before lowercasing, then split other "-" and "_".
//    Map lowercase tokens through Whisper's UK→US spelling dictionary (vendor/README.md).
// 3. Every other character that is not a letter, digit, or word-internal apostrophe becomes a space.
//    An apostrophe with a letter or digit on both sides stays ("don't", "90's"); one at the edge is removed.
//    Neighbors split rather than glue ("hello,world", "3.14", "2,000").
// 4. A token that is only digits and whose integer value is 0–9999 becomes English words, so "2" and "two" match.
//    The spelling uses no "and" ("101" → "one hundred one", "2024" → "two thousand twenty four"). "0" is "zero".
//    Leading zeros use the integer value ("007" → "seven"). Any larger digit string is kept unchanged ("10000").
// 5. Fillers are removed: uh, um, hmm, mm, mhm, ah, eh, oh. Hyphenated uh-huh and mm-hmm have already split;
//    the pairs "uh huh" and "mm hmm" are removed together, so a leftover "huh" is not scored. A lone "huh" stays.
// 6. Whitespace collapses. The result is the list of words, or an empty list when nothing remains.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Alignment {
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
}

export interface WerResult extends Alignment {
  /** (substitutions + deletions + insertions) / referenceWords. See `wer`. */
  wer: number;
  /** N, the reference length after normalization. */
  referenceWords: number;
}

export const NORMALIZER = 'hearalong-2';
export type Normalizer = 'hearalong-1' | typeof NORMALIZER;
const SPELLING: Record<string, string> = {
  ...JSON.parse(readFileSync(new URL('./vendor/english.json', import.meta.url), 'utf8')),
  // AMI uses these forms, which are absent from Whisper's otherwise vendored-unchanged dictionary.
  recogniser: 'recognizer', recognisers: 'recognizers',
};

const APOSTROPHE = /[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g;
const HYPHEN = /[\u2010\u2011]/g;
const FILLERS = new Set(['uh', 'um', 'hmm', 'mm', 'mhm', 'ah', 'eh', 'oh']);
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

/** English spelling of an integer in 0–9999, with spaces and without "and". */
function spell(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error(`Cannot spell ${n}.`);
  if (n < 20) return SMALL[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${SMALL[n % 10]}` : '');
  if (n < 1000) {
    const rest = n % 100;
    return `${SMALL[Math.floor(n / 100)]} hundred${rest ? ` ${spell(rest)}` : ''}`;
  }
  const rest = n % 1000;
  return `${spell(Math.floor(n / 1000))} thousand${rest ? ` ${spell(rest)}` : ''}`;
}

function expandToken(token: string): string[] {
  if (!/^\d+$/.test(token)) return [token];
  const value = BigInt(token);
  if (value > 9999n) return [token];
  return spell(Number(value)).split(' ');
}

function dropFillers<T>(tokens: T[], text: (token: T) => string): T[] {
  const out: T[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = text(tokens[i]);
    const next = tokens[i + 1] === undefined ? undefined : text(tokens[i + 1]);
    // "uh-huh" / "mm-hmm" have already been split on the hyphen. "huh" is not a filler on its own.
    if ((token === 'uh' && next === 'huh') || (token === 'mm' && next === 'hmm')) {
      i++;
      continue;
    }
    if (!FILLERS.has(token)) out.push(tokens[i]);
  }
  return out;
}

/** Tokenize before filler removal, so reference word attribution survives expansion and paired fillers. */
function tokens(text: string, version: Normalizer): string[] {
  let folded = text.normalize('NFKC').replace(APOSTROPHE, "'").replace(HYPHEN, '-');
  if (version !== 'hearalong-1') {
    // Whole lexical tokens only: never partially join an underscore word such as uh_huh or T_V_set.
    folded = folded.replace(/[\p{L}\p{N}_]+/gu, token => /^(?:[A-Za-z]_)+s?$/.test(token) ? token.replaceAll('_', '') : token);
  }
  folded = folded.toLowerCase();
  const chars = [...folded];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "'") {
      const prev = chars[i - 1] ?? '';
      const next = chars[i + 1] ?? '';
      out += isWordChar(prev) && isWordChar(next) ? "'" : ' ';
    } else if (char === '-' || char === '_') {
      out += ' ';
    } else if (isWordChar(char)) {
      out += char;
    } else {
      out += ' ';
    }
  }
  return out.trim().split(/\s+/u).filter(word => word.length > 0)
    .map(word => version === 'hearalong-1' ? word : (Object.hasOwn(SPELLING, word) ? SPELLING[word] : word)).flatMap(expandToken);
}

export function normalize(text: string, version: Normalizer = NORMALIZER): string[] {
  return dropFillers(tokens(text, version), word => word);
}

export function normalizeReference<T extends { text: string }>(words: T[]): (T & { text: string })[] {
  return dropFillers(words.flatMap(word => tokens(word.text, NORMALIZER).map(text => ({ ...word, text }))), word => word.text);
}

/**
 * Minimum-edit alignment of already-tokenized words. Substitution, deletion, and insertion each cost 1.
 * On a tie, take a diagonal step (hit or substitution), then a deletion, then an insertion.
 * The counts always satisfy hits + substitutions + deletions = reference.length and
 * hits + substitutions + insertions = hypothesis.length.
 */
export function align(reference: string[], hypothesis: string[]): Alignment {
  const counts: Alignment = { substitutions: 0, deletions: 0, insertions: 0, hits: 0 };
  for (const step of backtrace(reference, hypothesis)) counts[step.kind]++;
  return counts;
}

export type AlignmentStep = { kind: keyof Alignment; referenceIndex: number | null; hypothesisIndex: number | null };

/** Rolling cost rows plus byte-sized directions; deterministic diagonal > deletion > insertion ties. */
export function backtrace(reference: string[], hypothesis: string[]): AlignmentStep[] {
  const n = reference.length, m = hypothesis.length, width = m + 1;
  const directions = new Uint8Array((n + 1) * width);
  let previous = Uint32Array.from({ length: width }, (_, j) => j);
  let current = new Uint32Array(width);
  for (let j = 1; j <= m; j++) directions[j] = 2;
  for (let i = 1; i <= n; i++) {
    current[0] = i;
    directions[i * width] = 1;
    for (let j = 1; j <= m; j++) {
      const diagonal = previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1, insertion = current[j - 1] + 1;
      const best = Math.min(diagonal, deletion, insertion);
      current[j] = best;
      directions[i * width + j] = best === diagonal ? 0 : best === deletion ? 1 : 2;
    }
    [previous, current] = [current, previous];
  }
  const steps: AlignmentStep[] = [];
  for (let i = n, j = m; i || j;) {
    const direction = directions[i * width + j];
    if (direction === 0) {
      steps.push({ kind: reference[i - 1] === hypothesis[j - 1] ? 'hits' : 'substitutions', referenceIndex: --i, hypothesisIndex: --j });
    } else if (direction === 1) {
      steps.push({ kind: 'deletions', referenceIndex: --i, hypothesisIndex: null });
    } else {
      // clean.ts convention: leading insertions attach to the first word; empty references have no owner.
      steps.push({ kind: 'insertions', referenceIndex: n ? Math.max(0, i - 1) : null, hypothesisIndex: --j });
    }
  }
  return steps.reverse();
}

export function score(counts: Alignment, referenceWords: number, hypothesisWords: number): number {
  if (referenceWords !== 0) return (counts.substitutions + counts.deletions + counts.insertions) / referenceWords;
  // N = 0 has no ratio. Both empty is a perfect empty transcript; any hypothesis word is Infinity.
  return hypothesisWords === 0 ? 0 : Infinity;
}

/**
 * Word error rate of one pair, after `normalize`.
 * `wer` is (S + D + I) / N, where N is `referenceWords`.
 * An empty reference (no words after normalization, including whitespace-only input) yields
 * `wer` 0 when the hypothesis is also empty, and `Infinity` otherwise.
 */
export function wer(reference: string, hypothesis: string, version: Normalizer = NORMALIZER): WerResult {
  const referenceTokens = normalize(reference, version);
  const hypothesisTokens = normalize(hypothesis, version);
  const counts = align(referenceTokens, hypothesisTokens);
  return {
    wer: score(counts, referenceTokens.length, hypothesisTokens.length),
    ...counts,
    referenceWords: referenceTokens.length,
  };
}

/** Sum S, D, I, hits, and N across pairs. Not the mean of the per-pair rates. */
export function corpusWer(pairs: { reference: string; hypothesis: string }[], version: Normalizer = NORMALIZER): WerResult {
  const totals: WerResult = { wer: 0, substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceWords: 0 };
  let hypothesisWords = 0;
  for (const pair of pairs) {
    const item = wer(pair.reference, pair.hypothesis, version);
    totals.substitutions += item.substitutions;
    totals.deletions += item.deletions;
    totals.insertions += item.insertions;
    totals.hits += item.hits;
    totals.referenceWords += item.referenceWords;
    hypothesisWords += item.hits + item.substitutions + item.insertions;
  }
  totals.wer = score(totals, totals.referenceWords, hypothesisWords);
  return totals;
}

interface Pair {
  id: string;
  reference: string;
  hypothesis: string;
}

function loadPairs(raw: string): Pair[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
  }
  if (!Array.isArray(data)) throw new Error('Expected a JSON array of { id, reference, hypothesis }.');
  return data.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`Item ${index} must be an object with string id, reference, and hypothesis.`);
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.reference !== 'string' || typeof row.hypothesis !== 'string') {
      throw new Error(`Item ${index} must have string id, reference, and hypothesis.`);
    }
    return { id: row.id, reference: row.reference, hypothesis: row.hypothesis };
  });
}

function printJson(value: unknown): void {
  const text = JSON.stringify(value, (_key, nested) => nested === Infinity ? 'Infinity' : nested, 2);
  process.stdout.write(`${text}\n`);
}

function main(): void {
  const file = process.argv[2];
  if (process.argv.length !== 3 || !file) {
    throw new Error('Usage: node --experimental-strip-types app/scripts/bench/wer.ts <file.json>');
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const pairs = loadPairs(raw);
  const items = pairs.map(pair => ({ id: pair.id, ...wer(pair.reference, pair.hypothesis) }));
  printJson({ normalizer: NORMALIZER, items, corpus: corpusWer(pairs) });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
