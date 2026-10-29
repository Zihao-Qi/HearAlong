// Word error rate for the AMI benchmark. WER = (S + D + I) / N, with N the reference length after normalization.
//
// Normalizer, applied to both sides, in order:
// 1. Unicode NFKC, then lower case. Curly apostrophes (U+2018, U+2019, U+201A, U+201B, U+2032, U+2035, U+02BC)
//    become "'". Hyphens U+2010 and U+2011 become "-". NFKC does not fold those, and transcripts use them.
// 2. "-" and "_" become a space, including a run ("well-known", "uh-huh", "uh_huh").
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

function dropFillers(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    // "uh-huh" / "mm-hmm" have already been split on the hyphen. "huh" is not a filler on its own.
    if ((token === 'uh' && next === 'huh') || (token === 'mm' && next === 'hmm')) {
      i++;
      continue;
    }
    if (!FILLERS.has(token)) out.push(token);
  }
  return out;
}

/** The normalizer above. Deterministic, no dictionary beyond 0–9999 and the filler list. */
export function normalize(text: string): string[] {
  const folded = text.normalize('NFKC').toLowerCase().replace(APOSTROPHE, "'").replace(HYPHEN, '-');
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
  const tokens = out.trim().split(/\s+/u).filter(word => word.length > 0).flatMap(expandToken);
  return dropFillers(tokens);
}

/**
 * Minimum-edit alignment of already-tokenized words. Substitution, deletion, and insertion each cost 1.
 * On a tie, take a diagonal step (hit or substitution), then a deletion, then an insertion.
 * The counts always satisfy hits + substitutions + deletions = reference.length and
 * hits + substitutions + insertions = hypothesis.length.
 */
export function align(reference: string[], hypothesis: string[]): Alignment {
  const n = reference.length;
  const m = hypothesis.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i;
  for (let j = 1; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    const refWord = reference[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = refWord === hypothesis[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j - 1] + cost, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let hits = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        if (cost === 0) hits++;
        else substitutions++;
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deletions++;
      i--;
      continue;
    }
    insertions++;
    j--;
  }
  return { substitutions, deletions, insertions, hits };
}

function score(counts: Alignment, referenceWords: number, hypothesisWords: number): number {
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
export function wer(reference: string, hypothesis: string): WerResult {
  const referenceTokens = normalize(reference);
  const hypothesisTokens = normalize(hypothesis);
  const counts = align(referenceTokens, hypothesisTokens);
  return {
    wer: score(counts, referenceTokens.length, hypothesisTokens.length),
    ...counts,
    referenceWords: referenceTokens.length,
  };
}

/** Sum S, D, I, hits, and N across pairs. Not the mean of the per-pair rates. */
export function corpusWer(pairs: { reference: string; hypothesis: string }[]): WerResult {
  const totals: WerResult = { wer: 0, substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceWords: 0 };
  let hypothesisWords = 0;
  for (const pair of pairs) {
    const item = wer(pair.reference, pair.hypothesis);
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
  printJson({ items, corpus: corpusWer(pairs) });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
