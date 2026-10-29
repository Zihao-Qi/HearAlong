// The checks on a plans run's answer (M7b §2b "Checks"): code, not the model. Quotes are checked against the pinned transcript
// lines and the run's saved evidence only; ids, bases and quick checks are checked as given, never repaired. Nothing is cut:
// an over-long row text is flagged. The checks show that the sources exist and say what is quoted, not that a plan is right.
import { contains, tokens } from '../notes.ts';
import { pageAt, pdfQuoteSpan, quoteReadings } from '../pdf-text.ts';
import { normUrl, type EvidenceItem, type MaterialEvidence, type PythonEvidence, type CalculationEvidence, type SavedEvidence, type WebEvidence } from './evidence.ts';
import type { InputRefs, NoteRef } from './input.ts';

export const MAX_PLANS = 8;
export const MAX_FOLLOW_ONS = 2;
/** A material quote counts when it starts within this many lines of the cited line. */
export const LINE_SLACK = 5;
/** Row texts: the label, the answer's line and the step's line, in words. Longer ones are shown whole and flagged. */
export const ROW_WORDS = { label: 5, answerLine: 18, stepLine: 15 };
const QUOTE_WORDS = { min: 5, max: 25 };
const MAX_SPAN = 41;

/** What a plan's run pinned: the inputs it was made from (§2b "Pins"). Each plan keeps its origin's. */
export type PlanPins = {
  notesVersion: number;
  /** The notes' own warnings (coverage, stale or incomplete notes), kept with what was planned from them. */
  notesWarnings: string[];
  /** The project memory's stamp (versions.ts `memoryStamp`), the materials manifest's digest, and the meeting's project then. */
  memoryStamp: string | null; manifest: string; project: string | null;
};
export type Origin = { run: string; version: number | null };
export type CheckState = 'checked' | 'proposal' | 'unchecked';
export type Source =
  | { type: 'transcript'; ref: string; segmentId: string | null; startMs: number | null; quote: string }
  | { type: 'file'; root: string | null; path: string; line: number | null; quote: string }
  | { type: 'web'; url: string; quote: string };
/** One entry of the evidence registry: the model's definition, what it was checked against, and the result. */
export type EvidenceEntry = {
  id: string; run: string; local: string; kind: 'state' | 'check'; plan: string;
  /** A state item's claim, or what a check showed (the model's words). */
  text: string;
  source: Source | null;
  /** For a check: the calculation call it names (1 for the first); field retained for saved plans. */
  pythonRun: number | null;
  /** The saved-evidence item it was checked against (`e3`, or `line:<segment>` for a transcript line). */
  evidence: string | null;
  result: {
    ok: boolean; reason?: string;
    /** Where the quote starts and ends (the line shown), its page in a PDF, and the text around it as saved. */
    line?: number; to?: number; page?: number | null; excerpt?: string; hash?: string;
    /** The file's manifest entry changed after it was read: the quote is checked against what was read. */
    changed?: boolean;
    script?: string; output?: string; status?: string; language?: 'javascript' | 'python';
  };
};
export type Registry = Record<string, EvidenceEntry>;
export type Step = { id: string; kind: 'next' | 'follow'; if: string | null; text: string; basis: string[]; check: CheckState; reason?: string };
export type Answer = { text: string; complete: boolean; open: string | null; basis: string[]; check: CheckState; reason?: string };
export type Further = { state: 'ready' | 'blocked'; what: string; why: string; minutes: number | null };
export type CheckedPlan = {
  id: string; origin: Origin; originPins: PlanPins;
  label: string | null; answerLine: string | null; stepLine: string | null;
  /** Row texts over their limits, or missing: shown whole, for review. */
  rowFlags: string[];
  question: string;
  /** Valid N and S references, and what each stands for (so a to-do's payload names the notes, not their numbers). */
  from: string[]; fromItems: { ref: string; section: string; text: string }[];
  /** The verified owner (from the notes the plan cites), and the model's own claim when it differs. */
  owner: string | null; ownerClaimed: string | null;
  stateNow: string[]; checks: string[];
  answer: Answer | null; steps: Step[];
  waitingOn: string[]; decideAfter: string[]; changeIf: string | null; further: Further | null;
  /** Items of this plan that failed (Needs review inside the plan), and dropped parts. */
  review: { item: string; reason: string }[];
};
export type RunStatus = 'plans' | 'nothing to plan' | 'all plans failed checks';
export type CheckedRun = {
  run: string; status: RunStatus; plans: CheckedPlan[]; evidence: Registry;
  deferred: { item: string; text: string | null; why: string }[];
  notCovered: { item: string; section: string; text: string }[];
  /** Plans not kept (no valid N or S reference, over the limit, malformed), and other parts of the answer that did not check. */
  dropped: { plan: number; question: string; reason: string }[];
  review: string[];
};
export type CheckContext = {
  run: string; refs: InputRefs; evidence: SavedEvidence; pins: PlanPins;
  /** Revalidating a historical run can specify its language even when its calculation evidence is missing. */
  calculationLanguage?: 'javascript' | 'python';
  /** Files whose manifest entry changed after the run started ("R1/path"), from compareManifests. */
  changed?: Set<string>;
};

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter((s): s is string => s !== null) : [];
/** Words for the row limits: whitespace-separated runs with a letter or digit. */
export const wordCount = (value: string) => value.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
const quoteWords = (quote: string) => tokens(quote).filter(t => /[\p{L}\p{N}]/u.test(t)).length;
const ID = /^[A-Za-z][\w.-]{0,31}$/;

/**
 * A citation's root and path: "R1/dir/file", an explicit root, or an absolute path inside a root. Only a citation that names
 * no root at all falls back to the one root there is; an unknown root, or two roots that disagree, is a problem, not a guess.
 */
function filePlace(source: Record<string, unknown>, refs: InputRefs): { root: string | null; path: string; abs: string | null; given: string | null; problem?: string } {
  let path = String(source.path ?? '').trim().replace(/^\.\//, '');
  const given = text(source.root) ?? text(source.rootId);
  const place = filePlaceOf(path, given, refs);
  return { ...place, given };
}
function filePlaceOf(path: string, given: string | null, refs: InputRefs): { root: string | null; path: string; abs: string | null; problem?: string } {
  const known = (ref: string) => refs.roots.some(r => r.ref === ref);
  if (given && !known(given)) return { root: null, path, abs: null, problem: `unknown material root ${given}` };
  if (path.startsWith('/')) {
    // An absolute path: the root that holds it, or (a PDF's text in the run's view) only the file Pi read.
    const root = refs.roots.find(r => r.kind === 'file' ? r.path === path : path.startsWith(`${r.path}/`));
    if (root && given && root.ref !== given) return { root: null, path, abs: path, problem: `the path is in ${root.ref}, not ${given}` };
    return root ? { root: root.ref, path: root.kind === 'file' ? root.label : path.slice(root.path.length + 1), abs: path } : { root: given, path, abs: path };
  }
  const prefix = /^(R\d+)\/(.*)$/.exec(path);
  if (prefix) {
    if (!known(prefix[1])) return { root: null, path: prefix[2], abs: null, problem: `unknown material root ${prefix[1]}` };
    if (given && given !== prefix[1]) return { root: null, path: prefix[2], abs: null, problem: `the citation names both ${given} and ${prefix[1]}` };
    return { root: prefix[1], path: prefix[2], abs: null };
  }
  const root = given ?? (refs.roots.length === 1 ? refs.roots[0].ref : null);
  const named = refs.roots.find(r => r.ref === root);
  if (named?.kind === 'file' && (path === '' || path === '.')) path = named.label;
  return { root, path, abs: null };
}

/** The smallest span of the block's lines that holds the quote, starting within LINE_SLACK of the cited line. */
function quoteIn(item: MaterialEvidence, line: number, quote: string): { from: number; to: number } | null {
  const generated = new Set(item.pdf?.generated ?? []);
  const cut = new Set(item.cutLines ?? []);
  // A shortened line's unseen suffix is a gap, not whitespace (PDF wrapping must not bridge it either).
  const blocks = item.blocks.flatMap(block => {
    const parts: typeof item.blocks = [];
    let from = block.from, lines: string[] = [];
    block.lines.forEach((line, i) => {
      lines.push(line);
      if (cut.has(block.from + i)) { parts.push({ from, lines }); from = block.from + i + 1; lines = []; }
    });
    if (lines.length) parts.push({ from, lines });
    return parts;
  });
  for (const block of blocks) {
    const end = block.from + block.lines.length - 1;
    const lo = Math.max(block.from, line - LINE_SLACK), hi = Math.min(end, line + LINE_SLACK + MAX_SPAN);
    if (lo > Math.min(end, line + LINE_SLACK) || lo > hi) continue;
    if (item.pdf) {
      // The file's lines as an array by line number; only this block's lines are filled (nothing else was read).
      const lines: string[] = [];
      block.lines.forEach((l, i) => { lines[block.from + i - 1] = l; });
      const readings = quoteReadings(quote);
      let top = hi;
      for (;;) {
        const span = top >= lo ? pdfQuoteSpan(lines, generated, lo, top, readings) : null;
        if (!span) break;
        if (span[0] <= line + LINE_SLACK && span[1] - span[0] < MAX_SPAN) return { from: span[0], to: span[1] };
        top = span[1] - 1;
      }
      continue;
    }
    const q = tokens(quote);
    const at = (a: number, b: number) => contains(tokens(block.lines.slice(a - block.from, b - block.from + 1).join(' ')), q);
    if (!at(lo, hi)) continue;
    for (let length = 1; length <= Math.min(hi - lo + 1, MAX_SPAN); length++) {
      // Of the spans of one length, the one starting nearest the cited line.
      const starts = [];
      for (let a = lo; a <= Math.min(line + LINE_SLACK, hi - length + 1); a++) starts.push(a);
      starts.sort((a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b);
      for (const a of starts) if (at(a, a + length - 1)) return { from: a, to: a + length - 1 };
    }
  }
  return null;
}
const lineText = (item: MaterialEvidence, from: number, to: number) => item.blocks.flatMap(b => b.lines.map((l, i) => [b.from + i, l] as const))
  .filter(([n]) => n >= from && n <= to && !(item.pdf?.generated ?? []).includes(n)).map(([, l]) => l).join('\n').slice(0, 2_000);
/** About 600 characters of page text around the quote's first words. */
function around(page: string, quote: string): string {
  const words = (quote.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = words.length ? new RegExp(words.join('[^\\p{L}\\p{N}]+'), 'iu').exec(page) : null;
  const start = Math.max(0, (m?.index ?? 0) - 200);
  return page.slice(start, start + 800).replace(/\s+/g, ' ').trim();
}

function checkSource(raw: unknown, context: CheckContext): { source: Source | null; evidence: string | null; result: EvidenceEntry['result'] } {
  const s = (raw ?? {}) as Record<string, unknown>;
  const quote = typeof s.quote === 'string' ? s.quote.trim() : '';
  const failed = (source: Source | null, reason: string, evidence: string | null = null) => ({ source, evidence, result: { ok: false, reason } });
  const words = quoteWords(quote);
  const quoteProblem = !quote ? 'no quote' : words < QUOTE_WORDS.min ? 'quote too short to support the item' : words > QUOTE_WORDS.max ? 'quote too long' : null;
  if (s.type === 'transcript') {
    const ref = String(s.ref ?? '').trim();
    const line = context.refs.lines.find(l => l.ref === ref);
    const source: Source = { type: 'transcript', ref, segmentId: line?.segmentId ?? null, startMs: line?.startMs ?? null, quote };
    if (!line) return failed(source, `no transcript line ${ref || '(none given)'} in the input`);
    if (quoteProblem) return failed(source, quoteProblem, `line:${line.segmentId}`);
    const q = tokens(quote);
    const as = contains(tokens(line.text), q) ? line.text : contains(tokens(line.originalText), q) ? line.originalText : null;
    if (!as) return failed(source, 'quote not found in that line', `line:${line.segmentId}`);
    return { source, evidence: `line:${line.segmentId}`, result: { ok: true, excerpt: as } };
  }
  if (s.type === 'file') {
    const place = filePlace(s, context.refs);
    const line = Number.isInteger(s.line) && Number(s.line) >= 1 ? Number(s.line) : null;
    const items = context.evidence.items.filter((i): i is MaterialEvidence => (i.tool === 'read' || i.tool === 'grep') && ((place.abs !== null && i.abs === place.abs)
      || (i.root === place.root && (i.path === place.path || (Boolean(i.pdf) && `${i.path}.txt` === place.path)))));
    const first = items[0];
    const source: Source = { type: 'file', root: first?.root ?? place.root, path: first?.path ?? place.path, line, quote };
    if (!place.path) return failed(source, 'no file given');
    if (place.problem) return failed(source, place.problem);
    // An absolute path names its file, and so its root (a PDF's text in the run's view too): an explicit root must agree.
    const elsewhere = place.given ? items.find(i => i.root !== place.given) : undefined;
    if (elsewhere) return failed(source, `the path is in ${elsewhere.root}, not ${place.given}`);
    if (!items.length && !place.root) return failed(source, 'unknown material root');
    if (line === null) return failed(source, 'no line number');
    if (!items.length) return failed(source, 'not read in this run');
    if (quoteProblem) return failed(source, quoteProblem, first.id);
    const usable = items.filter(i => !i.pdf?.missing);
    if (!usable.length) return failed(source, 'no page lines were recorded for this PDF\'s text, so its quotes are not counted', first.id);
    for (const item of usable) {
      const span = quoteIn(item, line, quote);
      if (!span) continue;
      const changed = context.changed?.has(`${item.root}/${item.path}`) || undefined;
      return { source: { ...source, root: item.root, path: item.path }, evidence: item.id, result: { ok: true, line: span.from, to: span.to,
        ...(item.pdf ? { page: pageAt(item.pdf.pageStarts, span.from) } : {}), excerpt: lineText(item, span.from - 2, span.to + 2), hash: item.hash, ...(changed ? { changed } : {}) } };
    }
    const cut = items.some(i => i.cut);
    return failed(source, `quote not found within ${LINE_SLACK} lines of line ${line} in what was read${cut ? ' (the saved text was cut)' : ''}`, first.id);
  }
  if (s.type === 'web') {
    const url = String(s.url ?? '').trim();
    const source: Source = { type: 'web', url, quote };
    const pages = context.evidence.items.filter((i): i is WebEvidence => i.tool === 'fetch' && i.url === normUrl(url));
    if (!url) return failed(source, 'no address given');
    if (!pages.length) return failed(source, 'not fetched in this run');
    if (quoteProblem) return failed(source, quoteProblem, pages[0].id);
    const page = pages.find(p => contains(tokens(p.text), tokens(quote)));
    if (!page) return failed(source, `quote not found in the fetched page${pages.some(p => p.cut) ? ' (the saved text was cut)' : ''}`, pages[0].id);
    return { source, evidence: page.id, result: { ok: true, excerpt: around(page.text, quote), hash: page.hash } };
  }
  return failed(null, `unknown source type ${JSON.stringify(s.type ?? null)}`);
}

/** A basis as given: an array of known, distinct ids. Missing, malformed, unknown or repeated ids are never "empty". */
function basisOf(raw: unknown, kind: 'answer' | 'step', registry: Registry, run: string, defined: Map<string, number>): Pick<Answer, 'basis' | 'check' | 'reason'> {
  if (!Array.isArray(raw)) return { basis: [], check: 'unchecked', reason: 'no basis given' };
  if (!raw.every(id => typeof id === 'string' && ID.test(id))) return { basis: [], check: 'unchecked', reason: 'malformed basis' };
  const ids = raw as string[];
  const basis = ids.map(id => `${run}:${id}`);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) return { basis, check: 'unchecked', reason: `${twice} is listed twice` };
  const unknown = ids.find(id => !registry[`${run}:${id}`]);
  if (unknown) return { basis, check: 'unchecked', reason: `unknown id ${unknown}` };
  const doubled = ids.find(id => (defined.get(id) ?? 0) > 1);
  if (doubled) return { basis, check: 'unchecked', reason: `${doubled} is defined more than once` };
  const bad = ids.find(id => !registry[`${run}:${id}`].result.ok);
  if (bad) return { basis, check: 'unchecked', reason: `${bad} did not check out` };
  if (!ids.length) return kind === 'answer' ? { basis, check: 'unchecked', reason: 'an answer needs at least one checked source' } : { basis, check: 'proposal' };
  return { basis, check: 'checked' };
}

/** The verified owner: the one owner the notes confirmed for the action items the plan cites; none when they name none or several. */
function ownerOf(from: string[], notes: NoteRef[]): string | null {
  const owners = new Set(from.map(ref => notes.find(n => n.ref === ref)?.owner).filter((o): o is string => Boolean(o)));
  return owners.size === 1 ? [...owners][0] : null;
}

/**
 * Checks a run's raw answer (the model's JSON, parsed) against its input and saved evidence. Evidence ids are qualified by the
 * run (`<run>:k1`). Returns the checked plans with their registry, coverage and status; the caller adds pins and publishes.
 */
export function checkPlans(raw: unknown, context: CheckContext): CheckedRun {
  const run = context.run;
  const answer = (raw ?? {}) as { plans?: unknown; deferred?: unknown };
  const rawPlans = Array.isArray(answer.plans) ? answer.plans : [];
  const known = new Set([...context.refs.notes.map(n => n.ref), ...context.refs.lines.map(l => l.ref)]);
  const dropped: CheckedRun['dropped'] = [];
  const review: string[] = [];
  if (!Array.isArray(answer.plans)) review.push('The answer has no list of plans.');
  // Ids are unique across all plans; one defined twice is invalid wherever it is used, counting plans past the limit too.
  const defined = new Map<string, number>();
  for (const p of rawPlans) {
    const plan = (p ?? {}) as { stateNow?: unknown; checks?: unknown };
    for (const item of [...(Array.isArray(plan.stateNow) ? plan.stateNow : []), ...(Array.isArray(plan.checks) ? plan.checks : [])]) {
      const id = (item as { id?: unknown })?.id;
      if (typeof id === 'string' && ID.test(id)) defined.set(id, (defined.get(id) ?? 0) + 1);
    }
  }
  const registry: Registry = {};
  const plans: CheckedPlan[] = [];
  const pending: { out: CheckedPlan; plan: Record<string, unknown> }[] = [];
  rawPlans.forEach((p, index) => {
    const plan = (p ?? {}) as Record<string, unknown>;
    const question = text(plan.question) ?? '';
    if (index >= MAX_PLANS) { dropped.push({ plan: index + 1, question, reason: `more than ${MAX_PLANS} plans` }); return; }
    if (typeof p !== 'object' || p === null || Array.isArray(p)) { dropped.push({ plan: index + 1, question, reason: 'malformed plan' }); return; }
    if (!question) { dropped.push({ plan: index + 1, question, reason: 'no question' }); return; }
    const fromGiven = strings(plan.from);
    const from = [...new Set(fromGiven.filter(ref => known.has(ref)))];
    if (!from.length) { dropped.push({ plan: index + 1, question, reason: 'no valid N or S reference in "from"' }); return; }
    const field = (value: unknown) => value && typeof value === 'object' ? text((value as Record<string, unknown>).text) : null;
    if (!field(plan.answer) && !(typeof plan.next === 'string' ? text(plan.next) : field(plan.next))) { dropped.push({ plan: index + 1, question, reason: 'neither an answer nor a next step' }); return; }
    const id = `p${plans.length + 1}`;
    const planReview: CheckedPlan['review'] = [];
    const invalidFrom = fromGiven.filter(ref => !known.has(ref));
    if (invalidFrom.length) planReview.push({ item: 'from', reason: `unknown references ${invalidFrom.join(', ')} left out` });
    // State now and checks: each checked, each in the registry under its qualified id (the first definition of a repeated id).
    const register = (kind: 'state' | 'check', item: unknown): string | null => {
      const it = (item ?? {}) as Record<string, unknown>;
      const local = typeof it.id === 'string' && ID.test(it.id) ? it.id : null;
      if (!local) { planReview.push({ item: kind === 'state' ? 'state now' : 'check', reason: 'an item without a valid id' }); return null; }
      const key = `${run}:${local}`;
      if ((defined.get(local) ?? 0) > 1) {
        planReview.push({ item: key, reason: `${local} is defined more than once` });
        if (registry[key]) return null;
      }
      let entry: EvidenceEntry;
      if (kind === 'state') {
        const checked = checkSource(it.source, context);
        entry = { id: key, run, local, kind, plan: id, text: text(it.text) ?? '', source: checked.source, pythonRun: null, evidence: checked.evidence, result: checked.result };
        if (!entry.text) entry.result = { ...entry.result, ok: false, reason: 'no text' };
      } else {
        const n = Number.isInteger(it.run) ? Number(it.run) : null;
        const call = n === null ? undefined : context.evidence.items.find((e): e is PythonEvidence | CalculationEvidence => (e.tool === 'python' || e.tool === 'calc') && e.run === n);
        const language = call?.tool === 'calc' ? { language: 'javascript' as const } : {};
        const legacy = call?.tool === 'python' || (!call && (context.calculationLanguage === 'python' || (context.evidence.items.some(e => e.tool === 'python') && !context.evidence.items.some(e => e.tool === 'calc'))));
        const tool = legacy ? 'run_python' : 'calculate';
        const result: EvidenceEntry['result'] = n === null ? { ok: false, reason: 'no run number' }
          : !call ? { ok: false, reason: `no ${tool} call ${n} was recorded` }
          : !call.ok ? { ok: false, reason: `${tool} call ${n} did not finish without error (${call.status})`, script: call.script, output: call.output, status: call.status, ...language }
          : { ok: true, script: call.script, output: call.output, status: call.status, ...language };
        entry = { id: key, run, local, kind, plan: id, text: text(it.showed) ?? '', source: null, pythonRun: n, evidence: call?.id ?? null, result };
      }
      if ((defined.get(local) ?? 0) > 1) entry.result = { ...entry.result, ok: false, reason: `${local} is defined more than once` };
      registry[key] = entry;
      if (!entry.result.ok && !planReview.some(r => r.item === key)) planReview.push({ item: key, reason: entry.result.reason ?? 'did not check out' });
      return key;
    };
    const stateNow = (Array.isArray(plan.stateNow) ? plan.stateNow : []).map(i => register('state', i)).filter((k): k is string => k !== null);
    const checks = (Array.isArray(plan.checks) ? plan.checks : []).map(i => register('check', i)).filter((k): k is string => k !== null);
    plans.push({
      id, origin: { run, version: null }, originPins: context.pins,
      label: null, answerLine: null, stepLine: null, rowFlags: [], question, from,
      fromItems: from.map(ref => {
        const note = context.refs.notes.find(n => n.ref === ref);
        const line = context.refs.lines.find(l => l.ref === ref);
        return note ? { ref, section: note.section, text: note.text } : { ref, section: 'transcript', text: line?.segmentId ?? ref };
      }),
      owner: ownerOf(from, context.refs.notes), ownerClaimed: text(plan.owner),
      stateNow: [...new Set(stateNow)], checks: [...new Set(checks)], answer: null, steps: [], waitingOn: strings(plan.waitingOn), decideAfter: strings(plan.decideAfter),
      changeIf: text(plan.changeIf), further: null, review: planReview,
    });
    const out = plans.at(-1)!;
    if (out.ownerClaimed === out.owner) out.ownerClaimed = null;
    pending.push({ out, plan });
  });
  // Bases are checked once every plan's items are in the registry: an id may name another plan's item (they are unique across plans).
  for (const { out, plan } of pending) {
    const a = plan.answer as Record<string, unknown> | null | undefined;
    if (a !== null && a !== undefined) {
      const answerText = typeof a === 'object' ? text(a.text) : null;
      if (!answerText) out.review.push({ item: 'answer', reason: 'an answer without text' });
      else {
        if (typeof a.complete !== 'boolean') out.review.push({ item: 'answer', reason: 'not marked complete or partial; read as partial' });
        out.answer = { text: answerText, complete: a.complete === true, open: text(a.open), ...basisOf(a.basis, 'answer', registry, run, defined) };
      }
    }
    const step = (id: string, kind: Step['kind'], cond: string | null, value: unknown): Step | null => {
      const body = typeof value === 'string' ? text(value) : text((value as { text?: unknown; then?: unknown })?.[kind === 'next' ? 'text' : 'then']);
      if (!body) { out.review.push({ item: id, reason: 'a step without text' }); return null; }
      const basis = typeof value === 'string' ? { basis: [], check: 'unchecked' as const, reason: 'no basis given' } : basisOf((value as { basis?: unknown }).basis, 'step', registry, run, defined);
      return { id, kind, if: cond, text: body, ...basis };
    };
    if (plan.next !== null && plan.next !== undefined) { const s = step(`${out.id}.s1`, 'next', null, plan.next); if (s) out.steps.push(s); }
    const follows = Array.isArray(plan.followOn) ? plan.followOn : [];
    follows.forEach((f, i) => {
      const id = `${out.id}.s${i + 2}`;
      if (i >= MAX_FOLLOW_ONS) { out.review.push({ item: id, reason: `more than ${MAX_FOLLOW_ONS} follow-on steps` }); return; }
      const cond = text((f as { if?: unknown })?.if);
      // A follow-on without its condition would read as an unconditional task.
      if (!cond) { out.review.push({ item: id, reason: 'a follow-on step without its condition' }); return; }
      const s = step(id, 'follow', cond, f);
      if (s) out.steps.push(s);
    });
    // Row texts: kept whole; too long or missing is flagged, never cut.
    out.label = text(plan.label); out.answerLine = text(plan.answerLine); out.stepLine = text(plan.stepLine);
    if (!out.label) out.rowFlags.push('no label');
    else if (wordCount(out.label) > ROW_WORDS.label) out.rowFlags.push(`label over ${ROW_WORDS.label} words`);
    if (out.answerLine && wordCount(out.answerLine) > ROW_WORDS.answerLine) out.rowFlags.push(`answer line over ${ROW_WORDS.answerLine} words`);
    if (out.answer && !out.answerLine) out.rowFlags.push('no answer line; the full answer is shown');
    if (out.stepLine && wordCount(out.stepLine) > ROW_WORDS.stepLine) out.rowFlags.push(`step line over ${ROW_WORDS.stepLine} words`);
    if (out.steps.some(s => s.kind === 'next') && !out.stepLine) out.rowFlags.push('no step line; the full step is shown');
    const f = plan.further as Record<string, unknown> | null | undefined;
    if (f && (f.state === 'ready' || f.state === 'blocked')) {
      const minutes = typeof f.minutes === 'number' && Number.isFinite(f.minutes) && f.minutes > 0 ? f.minutes : null;
      out.further = { state: f.state, what: text(f.what) ?? '', why: text(f.why) ?? '', minutes };
      if (f.state === 'ready' && (minutes === null || minutes > 20)) out.review.push({ item: 'further', reason: minutes === null ? 'no estimate of its time' : `estimated at ${minutes} min, over the 20-min limit` });
    } else if (f !== null && f !== undefined) out.review.push({ item: 'further', reason: 'not ready or blocked; left out' });
  }
  // Coverage, over the plans that were kept: each open question and action item is planned, deferred with a reason, or not covered.
  const covered = new Set(plans.flatMap(p => p.from));
  const deferred: CheckedRun['deferred'] = [];
  for (const d of Array.isArray(answer.deferred) ? answer.deferred : []) {
    const given = text((d as { item?: unknown })?.item), why = text((d as { why?: unknown })?.why);
    const item = given?.match(/^([NS]\d+)(?=$|[\s\p{P}])/u)?.[1];
    // General scope remarks stay in the record, but are not failed checks on a note and cover no input item.
    if (!item) { deferred.push({ item: given ?? '', text: null, why: why ?? '' }); continue; }
    if (!known.has(item)) { review.push(`A deferred item names no note of the input (${JSON.stringify(item)}).`); continue; }
    if (!why) { review.push(`${item} was deferred without a reason.`); continue; }
    deferred.push({ item, text: context.refs.notes.find(n => n.ref === item)?.text ?? null, why });
  }
  const deferredRefs = new Set(deferred.filter(d => known.has(d.item) && d.why).map(d => d.item));
  const notCovered = context.refs.notes.filter(n => (n.section === 'openQuestions' || n.section === 'actions') && !covered.has(n.ref) && !deferredRefs.has(n.ref))
    .map(n => ({ item: n.ref, section: n.section, text: n.text }));
  // "Nothing to plan" needs the model to have said so: an empty list of plans, and every open question and action item deferred
  // with a reason. Anything else without a kept plan is a failure (no list, a malformed one, or open items left unaccounted for).
  const open = context.refs.notes.filter(n => n.section === 'openQuestions' || n.section === 'actions');
  const nothing = Array.isArray(answer.plans) && rawPlans.length === 0 && open.every(n => deferredRefs.has(n.ref));
  if (!plans.length && Array.isArray(answer.plans) && !rawPlans.length && !nothing) review.push('No plans, and not every open question and action item was deferred with a reason.');
  const status: RunStatus = plans.length ? 'plans' : nothing ? 'nothing to plan' : 'all plans failed checks';
  return { run, status, plans, evidence: registry, deferred, notCovered, dropped, review };
}

/** The registry entries a plan rests on: its own items and every id its answer and steps name. Carried with the plan. */
export function entriesOf(plan: CheckedPlan, registry: Registry): Registry {
  const ids = new Set([...plan.stateNow, ...plan.checks, ...(plan.answer?.basis ?? []), ...plan.steps.flatMap(s => s.basis)]);
  return Object.fromEntries([...ids].filter(id => registry[id]).map(id => [id, registry[id]]));
}
export type { EvidenceItem };
