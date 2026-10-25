// Glossary-based transcript correction: the model proposes span edits, code decides what is allowed.
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Edit, MeetingStore, Segment } from './store.ts';
import { extractJson } from './pi-task.ts';

/** `heard`: how the local recognizer actually rendered the term (voice probe), as opposed to guessed `spokenVariants`. */
export type GlossaryTerm = { term: string; spokenVariants: string[]; heard?: string[]; note?: string };
export type Glossary = { version: number; origin: 'generated' | 'user'; builtAt: number; terms: GlossaryTerm[]; model?: string };
export type Proposal = { id: string; from: string; to: string };
export type CorrectionStats = {
  calls: number; accepted: number; rejected: number; noop: number; failed: number; stale: number;
  /** Cost accounting: lines sent to the model, filler lines checked without a call, and tokens as the provider reported them. */
  linesSent?: number; linesSkipped?: number; tokensIn?: number; tokensOut?: number; tokensCached?: number; callsWithoutUsage?: number;
};
/** `learned`: misheard spans from accepted corrections in this meeting, by term; later occurrences are fixed without a model call. */
export type CorrectionState = { lastCallAt: number; glossaryVersion: number; stats: CorrectionStats; lastError?: string; learned?: Record<string, string[]>; failures: number; retryAfter: number };

const NEGATIONS = new Set(['no', 'not', 'never', 'none', 'nothing', 'nor', 'neither', 'cannot', "can't", "don't", "doesn't", "didn't",
  "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't", "shouldn't", "couldn't", 'without']);
const UNITS = new Set(['kg', 'g', 'mg', 'km', 'cm', 'mm', 'ms', 'sec', 'secs', 'seconds', 'min', 'mins', 'minutes', 'hours', 'hz', 'khz',
  'mhz', 'db', 'kb', 'mb', 'gb', 'tb', 'percent', 'percentage', 'degree', 'degrees']);
const normalizeText = (text: string) => text.normalize('NFKC').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u2212\u2013\u2014]/g, '-');
/** Tokens whose change would alter a claim: numbers, signs, units, negations. Both sides must match exactly. */
export function protectedTokens(text: string): string {
  const t = normalizeText(text).toLowerCase();
  const out = [...t.matchAll(/\d+(?:[.,]\d+)*/g)].map(m => `n:${m[0]}`);
  // A minus anywhere except as a hyphen inside a word ("blue-green"), plus other math signs.
  for (const m of t.matchAll(/(?<![\p{L}\p{N}])-|-(?![\p{L}\p{N}])|[+=<>≤≥±×÷%]/gu)) out.push(`s:${m[0]}`);
  for (const word of t.split(/[^a-z']+/)) {
    if (NEGATIONS.has(word)) out.push(`neg:${word}`);
    if (UNITS.has(word)) out.push(`u:${word}`);
  }
  return out.sort().join('|');
}
/** Single-letter words in the heard text are usually variables ("r labels this shelf"); never drop one. */
const variables = (text: string) => normalizeText(text).toLowerCase().split(/[^a-z]+/).filter(w => w.length === 1 && w !== 'a' && w !== 'i');
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
/** First whole-word occurrence at or after `from`; a span inside a longer word never matches. */
function findWord(text: string, needle: string, from = 0): number {
  for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + 1)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + needle.length])) return at;
  }
  return -1;
}
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'this', 'that', 'it', 'we', 'with', 'as', 'be', 'by',
  'your', 'my', 'our', 'their', 'his', 'her', 'its', 'these', 'those']);
/** Words that cannot be a misheard project term: a line made only of these is checked without a model call. */
const FILLER = new Set([...STOP, 'so', 'uh', 'um', 'uhm', 'hmm', 'mm', 'okay', 'ok', 'yeah', 'yes', 'yep', 'no', 'not', 'right', 'well', 'then', 'now',
  'i', 'you', 'he', 'she', 'they', 'me', 'him', 'them', 'us', 'just', 'like', 'mean', 'know', 'think', 'but', 'if', 'oh', 'ah', 'actually', 'also',
  'here', 'there', 'what', 'how', 'why', 'when', 'do', 'did', 'does', 'was', 'were', 'have', 'has', 'had', 'will', 'can', 'could', 'would', 'should',
  'all', 'some', 'one', 'two', 'thing', 'things', 'very', 'really', 'good', 'great', 'thanks', 'thank', 'sure', 'exactly', 'maybe', 'because']);
/** A line of filler words only, holding no glossary term or known variant (a variant could itself be common words). */
export function fillerOnly(text: string, terms: GlossaryTerm[] = [], learned: Record<string, string[]> = {}): boolean {
  const lower = text.toLowerCase();
  if (!lower.split(/[^a-z']+/).filter(Boolean).every(w => FILLER.has(w.replace(/'/g, '')) || FILLER.has(w))) return false;
  const phrases = [...terms.flatMap(t => [t.term, ...t.spokenVariants, ...(t.heard ?? [])]), ...Object.values(learned).flat()];
  return !phrases.some(p => p.trim() && findWord(lower, p.toLowerCase()) >= 0);
}
const contentWords = (text: string) => text.toLowerCase().replace(/μ/g, 'mu').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
const sameStem = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))));

/** A rough consonant skeleton: similar-sounding consonants collapse, later vowels drop. */
export function skeleton(text: string): string {
  let t = text.toLowerCase().normalize('NFKD').replace(/μ/g, 'mu').replace(/ph/g, 'f').replace(/[^a-z]/g, '');
  t = t.replace(/[bp]/g, 'b').replace(/[dt]/g, 'd').replace(/[ckgq]/g, 'k').replace(/[sz]/g, 's').replace(/[fv]/g, 'f').replace(/[mn]/g, 'n');
  return (t[0] ?? '') + t.slice(1).replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
}
function lcs(a: string, b: string): number {
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
    previous = row;
  }
  return previous[b.length];
}
/** Sound-alike score against the term or its trailing words (a span may cover only part of a term). */
export function soundsLike(from: string, term: string): number {
  const tail = term.split(/\s+/).slice(-from.split(/\s+/).length).join(' ');
  return Math.max(...[term, tail].map(target => {
    const x = skeleton(from), y = skeleton(target);
    return lcs(x, y) / Math.max(x.length, y.length, 1);
  }));
}
/** True when the edit only rephrases words that were heard correctly (e.g. "the storage" → "storage cabinet"). */
export function onlyRephrases(from: string, term: string): boolean {
  const termWords = contentWords(term);
  const words = contentWords(from);
  // A span of filler words only ("their" → "theta") has nothing heard correctly, so it is not a rephrase.
  return words.length > 0 && words.every(word => termWords.some(t => sameStem(word, t)));
}

let dictionary: Set<string> | null | undefined;
/** Lowercase English words from the system word list; null when the list is unavailable. */
function englishWords(): Set<string> | null {
  if (dictionary === undefined) {
    try { dictionary = new Set(readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter(w => w && w === w.toLowerCase())); }
    catch { dictionary = null; }
  }
  return dictionary;
}
/**
 * Only distinctive spans are remembered: two or more words ("coral bay"), or one word that is not English ("Veluno").
 * A single real word ("painted", "packing") can be right elsewhere, so it is always left to the model, as is any
 * span that differs from the term only by a negating prefix. Without the system word list, single words are not learned.
 */
export function learnable(span: string, term: string): boolean {
  // "painted sign" → "unpainted sign" was right once, but reusing it blindly could reverse a later, correct claim.
  const spanWords = span.toLowerCase().split(/[^a-z]+/).filter(Boolean), termWords = term.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const reversal = (a: string, b: string) => ['a', 'an', 'non', 'un', 'in', 'im', 'ir', 'il', 'dis'].some(p => b === p + a);
  if (spanWords.some(a => termWords.some(b => reversal(a, b) || reversal(b, a)))) return false;
  const words = span.trim().split(/\s+/);
  if (words.length >= 2) return true;
  const word = words[0].toLowerCase().replace(/'s$/, '');
  const known = englishWords();
  if (known === null || !/^[a-z]+$/.test(word)) return false;
  // The word list has base forms only: also try the word without a common ending ("packing" → "pack", "making" → "make").
  const stems = [word, ...['ing', 'ed', 'es', 's', 'er', 'ers', 'ly'].filter(e => word.endsWith(e)).flatMap(e => [word.slice(0, -e.length), `${word.slice(0, -e.length)}e`])];
  return !stems.some(stem => known.has(stem));
}

/** Learned memory as a null-prototype dictionary, so term names like "constructor" are ordinary keys. */
export function learnedMemory(saved?: Record<string, string[]>): Record<string, string[]> {
  const memory: Record<string, string[]> = Object.create(null);
  // Saved memory is re-checked, so spans learned under older rules are dropped.
  for (const [term, spans] of Object.entries(saved ?? {})) {
    if (Array.isArray(spans)) memory[term] = spans.filter(s => typeof s === 'string' && learnable(s, term));
  }
  return memory;
}

/**
 * Proposals for exact repeats of mishearings already confirmed in this meeting ("coral bay" → "Coralbay").
 * Only terms still in the glossary are used. They still pass validateEdits. Probe results are not used here:
 * they were never checked in context.
 */
export function knownMishearings(segments: Segment[], learned: Record<string, string[]>, terms: GlossaryTerm[]): Proposal[] {
  const current = new Set(terms.map(t => t.term));
  const out: Proposal[] = [];
  for (const segment of segments) {
    for (const [term, spans] of Object.entries(learned)) {
      if (!current.has(term)) continue;
      for (const span of spans) {
        let at = findWord(segment.text.toLowerCase(), span.toLowerCase());
        for (; at >= 0; at = findWord(segment.text.toLowerCase(), span.toLowerCase(), at + 1)) out.push({ id: segment.id, from: segment.text.slice(at, at + span.length), to: term });
      }
    }
  }
  return out;
}

/** Validate untrusted glossary JSON (generated or user-edited) into a bounded shape. */
export function cleanGlossary(raw: unknown): GlossaryTerm[] {
  const terms = (raw as { terms?: unknown })?.terms;
  if (!Array.isArray(terms)) throw new Error('Glossary needs a "terms" array.');
  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];
  for (const item of terms.slice(0, 200)) {
    const term = typeof item?.term === 'string' ? item.term.trim().slice(0, 80) : '';
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const spokenVariants = Array.isArray(item.spokenVariants)
      ? item.spokenVariants.filter((v: unknown) => typeof v === 'string' && v.trim()).map((v: string) => v.trim().slice(0, 80)).slice(0, 8) : [];
    const heard = Array.isArray(item.heard)
      ? item.heard.filter((v: unknown) => typeof v === 'string' && v.trim()).map((v: string) => v.trim().slice(0, 80)).slice(0, 12) : [];
    out.push({ term, spokenVariants, ...(heard.length ? { heard } : {}), ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim().slice(0, 160) } : {}) });
  }
  return out;
}

const saveLocks = new Map<string, Promise<unknown>>();
export class GlossaryFile {
  path: string;
  constructor(path: string) { this.path = path; }
  /** Load-check-write is one critical section per path, across instances: no lost or duplicate versions. */
  save(terms: GlossaryTerm[], origin: Glossary['origin'], model?: string, expectedVersion?: number): Promise<Glossary> {
    const previous = saveLocks.get(this.path) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.saveNow(terms, origin, model, expectedVersion));
    saveLocks.set(this.path, run);
    void run.finally(() => { if (saveLocks.get(this.path) === run) saveLocks.delete(this.path); }).catch(() => {});
    return run;
  }
  async load(): Promise<Glossary | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  /** A generated glossary never overwrites a user's edit; versions only move forward. */
  private async saveNow(terms: GlossaryTerm[], origin: Glossary['origin'], model?: string, expectedVersion?: number): Promise<Glossary> {
    const current = await this.load();
    if (origin === 'generated' && current?.origin === 'user') throw new Error('The glossary was edited by the user; rebuild would overwrite it.');
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) throw new Error('The glossary changed while it was being rebuilt.');
    const glossary: Glossary = { version: (current?.version ?? 0) + 1, origin, builtAt: Date.now(), terms, ...(model ? { model } : {}) };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(glossary, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    return glossary;
  }
}

/** `pdfTexts`: where the text of the materials' PDFs is (Pi cannot read a PDF itself). */
export function glossaryPrompt(roots: string[], pdfTexts: string[] = []): string {
  return [
    'Build a speech-recognition glossary for upcoming research meetings about the project in these READ-ONLY folders:',
    ...roots.map(root => `- ${root}`),
    ...(pdfTexts.length ? ['PDF files cannot be read directly; read their text instead (one .txt per PDF, at the PDF\'s relative path plus .txt):', ...pdfTexts.map(path => `- ${path}`)] : []),
    'Read only; never modify anything. Start from top-level maps (README, CONTENTS, INDEX, study guides) and the paper source;',
    'do not scan thousands of result files. Include technical terms, method and theorem names, symbols as people say them',
    '(e.g. a variable written shelf_total), dataset and model names, and people named in the documents.',
    'For each term give spokenVariants: ONLY sound-alike mishearings a speech recognizer might produce (e.g. "cool back" for Kullback)',
    'or how a symbol is read aloud (e.g. "sigma hat"). Never list synonyms, paraphrases or related terms as variants.',
    'Answer with JSON only: {"terms":[{"term":"Kullback-Leibler divergence","spokenVariants":["cool back Leibler divergence","full back lie blur"],"note":"distance between distributions"}]}',
    'Give 30 to 80 terms, most important first.',
  ].join('\n');
}

/**
 * The prompt starts with a part that is identical on every call of a meeting (instructions, then the glossary), so the
 * provider can serve it from its prompt cache; what changes (mishearings learned in this meeting, context, the lines to
 * edit) comes after it.
 */
/** System prompt for the correction lane; the task itself is in each request (see correctionPrompt). */
export const CORRECTION_SYSTEM_PROMPT = 'You are a careful assistant inside a research-meeting app. Follow the instructions in each request exactly.';
export function correctionPrompt(editable: Segment[], context: Segment[], terms: GlossaryTerm[], learned: Record<string, string[]> = {}): string {
  const glossary = terms.map(t => {
    const variants = [...new Set([...(Object.hasOwn(learned, t.term) ? learned[t.term] : []), ...(t.heard ?? []), ...t.spokenVariants])];
    return `- ${t.term}${variants.length ? ` (may be heard as: ${variants.join('; ')})` : ''}`;
  }).join('\n');
  return [
    'You fix speech-recognition errors in a research-meeting transcript, using ONLY this project glossary:',
    glossary,
    '',
    'Earlier context (do not edit):',
    ...context.map(s => `> ${s.text}`),
    '',
    'Segments you may edit:',
    ...editable.map(s => `[${s.id}] ${s.text}`),
    '',
    'Find words that make no sense as written because the speech recognizer misheard a glossary term, and replace just those words',
    'with the exact glossary term. Good (examples from another project): "cool back divergence" -> "Kullback-Leibler divergence";',
    '"the sheriff bound" -> "Chernoff bound"; "add a boost" -> "AdaBoost".',
    'Bad (never do this): rephrasing correct words into a glossary term ("the loss" -> "cross-entropy loss", "top five" -> "top-5 accuracy"),',
    'abbreviating ("directed acyclic graph" -> "DAG"), or anything that could change the meaning.',
    'Never change numbers or negations. If the words are plausibly what was said, leave them alone.',
    'Answer with JSON only: {"edits":[{"id":"<segment id>","from":"<exact words as they appear>","to":"<glossary term>"}]}',
    'Return {"edits":[]} if nothing clearly needs fixing.',
  ].join('\n');
}

/** Code-enforced rules; the model's output is untrusted. */
/** `limit` caps how many proposals are considered (model output is untrusted and unbounded). */
export function validateEdits(editable: Segment[], raw: unknown, terms: GlossaryTerm[], limit = 50) {
  const byId = new Map(editable.map(s => [s.id, s]));
  const canonical = new Map(terms.map(t => [t.term.toLowerCase(), t.term]));
  /** `edits` is the full stored list (earlier provenance kept); `added` counts only this batch's new edits. */
  const accepted = new Map<string, { segment: Segment; text: string; edits: Edit[]; added: number }>();
  const rejected: { proposal: unknown; reason: string }[] = [];
  const list = (raw as { edits?: unknown })?.edits;
  if (!Array.isArray(list)) return { accepted, rejected: [{ proposal: raw, reason: 'no edits array' }] };
  for (const proposal of list.slice(0, limit)) {
    const reject = (reason: string) => rejected.push({ proposal, reason });
    const { id, from, to } = (proposal ?? {}) as Partial<Proposal>;
    if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') { reject('malformed'); continue; }
    const segment = byId.get(id);
    if (!segment) { reject('segment not in the editable batch'); continue; }
    const term = canonical.get(to.trim().toLowerCase());
    if (!term) { reject('replacement is not a glossary term'); continue; }
    const source = from.trim();
    if (!source || source.split(/\s+/).length > 5 || term.split(/\s+/).length > 5) { reject('span must be 1-5 words'); continue; }
    if (source === term) continue;
    const termVariables = variables(term);
    if (protectedTokens(source) !== protectedTokens(term) || variables(source).some(v => !termVariables.includes(v))) { reject('would change numbers, signs, units, negation or a variable'); continue; }
    if (onlyRephrases(source, term)) { reject('rephrases correctly heard words'); continue; }
    if (soundsLike(source, term) < 0.25) { reject('does not sound like the term'); continue; }
    // Earlier corrections keep their provenance; new edits are added alongside them.
    const entry = accepted.get(id) ?? { segment, text: segment.text, edits: JSON.parse(segment.edits || '[]') as Edit[], added: 0 };
    // The first whole-word occurrence not already rewritten by an earlier edit in this batch.
    let start = findWord(entry.text, source);
    while (start >= 0 && entry.edits.some(e => start < e.end && start + source.length > e.start)) start = findWord(entry.text, source, start + 1);
    if (start < 0) { reject('span not found as whole words in the segment'); continue; }
    const end = start + source.length;
    const delta = term.length - source.length;
    entry.edits = entry.edits.map(e => (e.start >= end ? { ...e, start: e.start + delta, end: e.end + delta } : e));
    entry.edits.push({ start, end: start + term.length, from: source, to: term });
    entry.added++;
    entry.text = entry.text.slice(0, start) + term + entry.text.slice(end);
    accepted.set(id, entry);
  }
  return { accepted, rejected };
}

const ZERO: CorrectionStats = { calls: 0, accepted: 0, rejected: 0, noop: 0, failed: 0, stale: 0 };

/**
 * Runs the correction pass over visible segments not yet checked, at most once per interval per meeting.
 * "Checked" is per segment, so text recovered later by a retry of an earlier chunk is still corrected.
 */
export class Corrector {
  store: MeetingStore;
  ask: (prompt: string) => Promise<{ text: string; usage?: unknown; usages?: unknown[] }>;
  glossaryFor: (meetingId: string) => Promise<Glossary | null>;
  minIntervalMs: number;
  maxBatch: number;
  clock: () => number;
  /** Learned mishearings are reused in later batches of the same meeting. */
  learn: boolean;
  private busy = new Set<string>();
  constructor(options: {
    store: MeetingStore; ask: (prompt: string) => Promise<{ text: string; usage?: unknown; usages?: unknown[] }>; glossaryFor: (meetingId: string) => Promise<Glossary | null>;
    minIntervalMs?: number; maxBatch?: number; clock?: () => number; learn?: boolean;
  }) {
    this.store = options.store; this.ask = options.ask; this.glossaryFor = options.glossaryFor;
    // 24 lines at most once a minute (was 12 per 30 s): half the calls, so the fixed glossary part is sent half as often.
    this.minIntervalMs = options.minIntervalMs ?? 60_000; this.maxBatch = options.maxBatch ?? 24; this.clock = options.clock ?? Date.now;
    this.learn = options.learn ?? true;
  }
  /** A tick holds the meeting from before its first await until it finishes (moves, §8.2). */
  isBusy(meetingId: string) { return this.busy.has(meetingId); }
  state(meetingId: string): CorrectionState {
    const saved = this.store.correctionState<CorrectionState>(meetingId);
    return { lastCallAt: 0, glossaryVersion: 0, failures: 0, retryAfter: 0, ...saved, stats: { ...ZERO, ...saved?.stats } };
  }
  pending(meetingId: string): Segment[] {
    return this.store.visibleSegments(meetingId, this.clock()).filter(s => !s.correctionChecked);
  }
  /**
   * One batch if the interval has passed. `finished` (nothing more is coming) allows one immediate call
   * for a final tail that fits in a single batch; a larger backlog keeps the normal cadence.
   */
  async tick(meetingId: string, finished = false): Promise<'skipped' | 'done'> {
    if (this.busy.has(meetingId)) return 'skipped';
    this.busy.add(meetingId); // Taken before any await, so overlapping ticks cannot both proceed.
    try {
      const glossary = await this.glossaryFor(meetingId);
      if (!glossary?.terms.length) return 'skipped';
      const state = this.state(meetingId);
      const unchecked = this.pending(meetingId);
      // Filler-only lines ("So", "Okay, yeah") cannot hold a project term: checked now without a model call. Confirmed
      // mishearings are still fixed in them by code below, as in any line.
      const isFiller = (s: Segment) => fillerOnly(s.text, glossary.terms, state.learned);
      const filler = unchecked.filter(isFiller);
      if (filler.length) {
        const learnedNow = learnedMemory(state.learned);
        for (const proposal of this.learn ? knownMishearings(filler, learnedNow, glossary.terms) : []) {
          const { accepted } = validateEdits(filler, { edits: [proposal] }, glossary.terms, 1);
          for (const { segment, text, edits } of accepted.values()) this.store.applyEdits(segment.id, segment.revision, text, edits);
        }
        this.store.markCorrectionChecked(filler.map(s => s.id), glossary.version);
        state.stats.linesSkipped = (state.stats.linesSkipped ?? 0) + filler.length;
        this.store.setCorrectionState(meetingId, { ...state, stats: state.stats });
      }
      const pending = unchecked.filter(s => !isFiller(s));
      const due = this.clock() - state.lastCallAt >= this.minIntervalMs;
      if (!pending.length || this.clock() < state.retryAfter || !(due || (finished && pending.length <= this.maxBatch))) return filler.length ? 'done' : 'skipped';
      const editable = pending.slice(0, this.maxBatch);
      const visible = this.store.visibleSegments(meetingId, this.clock());
      const firstIndex = visible.findIndex(s => s.id === editable[0].id);
      const context = visible.slice(Math.max(0, firstIndex - 2), firstIndex);
      const stats = { ...state.stats };
      const learned = learnedMemory(state.learned);
      let lastError: string | undefined;
      // Known repeats are fixed even when the model call fails.
      const known = this.learn ? knownMishearings(editable, learned, glossary.terms) : [];
      let proposed: unknown[] = [];
      let malformed: unknown;
      let replied = false;
      try {
        stats.calls++;
        stats.linesSent = (stats.linesSent ?? 0) + editable.length;
        const reply = await this.ask(correctionPrompt(editable, context, glossary.terms, this.learn ? learned : {}));
        replied = true;
        // Token accounting per call, as the provider reported it (every attempt of a retried call); missing usage is counted, not zeroed.
        const usages = (reply.usages ?? (reply.usage ? [reply.usage] : [])) as { input?: number; output?: number; cacheRead?: number }[];
        if (!usages.length) stats.callsWithoutUsage = (stats.callsWithoutUsage ?? 0) + 1;
        for (const u of usages) {
          stats.tokensIn = (stats.tokensIn ?? 0) + (u?.input ?? 0);
          stats.tokensOut = (stats.tokensOut ?? 0) + (u?.output ?? 0);
          stats.tokensCached = (stats.tokensCached ?? 0) + (u?.cacheRead ?? 0);
        }
        const answer = extractJson(reply.text);
        const edits = (answer as { edits?: unknown })?.edits;
        if (Array.isArray(edits)) proposed = edits.slice(0, 50);
        else malformed = answer;
      } catch (error) {
        stats.failed++;
        lastError = (error as Error).message;
      }
      // The model sees the context, so its proposals are applied first. A known repeat whose words the model already
      // replaced then finds nothing; that is redundancy, not a rejection.
      const { accepted, rejected: all } = validateEdits(editable, { edits: [...proposed, ...known] }, glossary.terms, proposed.length + known.length);
      const cached = new Set<unknown>(known);
      const rejected = all.filter(r => !(cached.has(r.proposal) && r.reason.startsWith('span not found')));
      if (malformed !== undefined) rejected.push({ proposal: malformed, reason: 'no edits array' });
      stats.rejected += rejected.length;
      if ((await this.glossaryFor(meetingId))?.version !== glossary.version) {
        // A newer glossary arrived while the model was thinking: this result is stale.
        stats.stale += [...accepted.values()].reduce((n, a) => n + a.added, 0);
      } else {
        for (const { segment, text, edits, added } of accepted.values()) {
          if (!this.store.applyEdits(segment.id, segment.revision, text, edits)) { stats.stale += added; continue; }
          stats.accepted += added;
          // New edits are the last `added` entries; remember each misheard span for later batches.
          for (const edit of edits.slice(edits.length - added)) {
            if (!learnable(edit.from, edit.to)) continue;
            const spans = learned[edit.to] ?? [];
            if (!spans.some(k => k.toLowerCase() === edit.from.toLowerCase())) learned[edit.to] = [...spans, edit.from].slice(-20);
          }
        }
      }
      if (!lastError && !accepted.size && !rejected.length) stats.noop++;
      // A failed call leaves the batch unchecked; any reply, even malformed, finishes the check.
      if (replied) this.store.markCorrectionChecked(editable.map(s => s.id), glossary.version);
      const failures = replied ? 0 : state.failures + 1;
      const retryAfter = replied ? 0 : this.clock() + [60_000, 120_000, 300_000, 600_000][Math.min(failures - 1, 3)];
      this.store.setCorrectionState(meetingId, { lastCallAt: this.clock(), glossaryVersion: glossary.version, stats, learned, failures, retryAfter, ...(!replied && lastError ? { lastError } : {}) } satisfies CorrectionState);
      return 'done';
    } finally { this.busy.delete(meetingId); }
  }
}
