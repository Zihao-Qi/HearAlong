// How often the model's quotes pass the code's checks, counted locally in <data>/metrics/quote-checks.json and never sent
// anywhere. Counts only: feature, model id, ISO week and a fixed outcome key per checked claim. Reasons are mapped from the
// features' own reason strings to the closed list below, so no quote, text, meeting id, path or finer time is ever written.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SourceCheck } from './actions.ts';
import type { Notes, NotesRecord } from './notes.ts';
import type { CheckedRun } from './plans/validate.ts';

export const QUOTE_FEATURES = ['board', 'notes', 'plans', 'actions'] as const;
export type QuoteFeature = (typeof QUOTE_FEATURES)[number];
/**
 * Every outcome key and its kind: `quote` (no usable quote, or not where it was cited), `citation` (no valid source, or one the
 * run never read), `claim` (the item itself is malformed or not one claim), `limit` (a duplicate, or past a count limit).
 */
export const OUTCOMES = {
  passed: 'passed', passed_after_nearby_line: 'passed',
  no_quote: 'quote', quote_too_short: 'quote', quote_too_long: 'quote', quote_length: 'quote', quote_not_found: 'quote',
  quote_not_found_after_invalid_citation: 'quote', quote_joins_speakers: 'quote', quote_not_consecutive: 'quote', quote_in_earlier_lines: 'quote',
  no_citation: 'citation', too_many_citations: 'citation', invalid_citation: 'citation', earlier_lines_only: 'citation', source_not_read: 'citation',
  source_not_found: 'citation', source_unreadable: 'citation', pdf_lines_missing: 'citation', quote_in_search_snippet: 'citation',
  no_text: 'claim', text_too_long: 'claim', malformed: 'claim', non_project: 'claim', duplicate_id: 'claim',
  duplicate: 'limit', over_limit: 'limit',
  other: 'other',
} as const;
export type Outcome = keyof typeof OUTCOMES;
/** counts[feature][model][week][outcome] */
export type QuoteCounts = Partial<Record<QuoteFeature, Record<string, Record<string, Partial<Record<Outcome, number>>>>>>;

export const MAX_MODELS = 20;
export const MAX_WEEKS = 160;
const MODEL = /^[A-Za-z0-9][\w.:@+/-]{0,99}$/;
const WEEK = /^\d{4}-W\d{2}$/;
export const quoteMetricsPath = (directory: string) => join(directory, 'metrics', 'quote-checks.json');

/** The ISO 8601 week of a time, in UTC ("2026-W44"). */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 3 - (day.getUTCDay() + 6) % 7); // the Thursday of its week names the year
  const week = 1 + Math.floor((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 604_800_000);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Only the allowed keys survive a read: anything else in the file (hand edits, a corrupt write) is left out. */
function sanitize(raw: unknown): QuoteCounts {
  const counts: QuoteCounts = {};
  const data = object(raw) && raw.version === 1 && object(raw.counts) ? raw.counts : {};
  for (const feature of QUOTE_FEATURES) {
    const byModel = data[feature];
    if (!object(byModel)) continue;
    for (const [model, byWeek] of Object.entries(byModel)) {
      if (!MODEL.test(model) || !object(byWeek)) continue;
      for (const [week, outcomes] of Object.entries(byWeek)) {
        if (!WEEK.test(week) || !object(outcomes)) continue;
        for (const [outcome, n] of Object.entries(outcomes)) {
          if (!Object.hasOwn(OUTCOMES, outcome) || !Number.isSafeInteger(n) || (n as number) <= 0) continue;
          ((((counts[feature] ??= {})[model] ??= {})[week] ??= {}) as Record<string, number>)[outcome] = n as number;
        }
      }
    }
  }
  return counts;
}
/** The saved counts; a missing or unreadable file is no counts. */
export async function loadQuoteCounts(path: string): Promise<QuoteCounts> {
  try { return sanitize(JSON.parse(await readFile(path, 'utf8'))); } catch { return {}; }
}

const queues = new Map<string, Promise<void>>();
/**
 * Adds one count per outcome, for one feature and model, in the week of `at`. Updates to a file run one at a time; the write
 * is atomic. Never rejects: a counter must not affect the feature that calls it.
 */
export async function recordQuoteChecks(directory: string, feature: QuoteFeature, model: string | null | undefined, outcomes: Outcome[], at = Date.now()): Promise<void> {
  const path = quoteMetricsPath(directory);
  const pending = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const counts = await loadQuoteCounts(path);
    const models = counts[feature] ??= {};
    let id = model && MODEL.test(model) ? model : 'unknown';
    if (!models[id] && Object.keys(models).filter(m => m !== 'other').length >= MAX_MODELS) id = 'other';
    const weeks = models[id] ??= {};
    const tally = (weeks[isoWeek(at)] ??= {}) as Record<string, number>;
    for (const outcome of outcomes) if (Object.hasOwn(OUTCOMES, outcome)) tally[outcome] = (tally[outcome] ?? 0) + 1;
    for (const week of Object.keys(weeks).sort().slice(0, -MAX_WEEKS)) delete weeks[week];
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(tmp, JSON.stringify({ version: 1, counts: sanitize({ version: 1, counts }) }), { mode: 0o600 }); await rename(tmp, path); }
    finally { await rm(tmp, { force: true }).catch(() => {}); }
  });
  queues.set(path, pending);
  try { await pending; } catch (error) { console.warn(`Quote checks were not counted: ${(error as Error).message}`); }
  finally { if (queues.get(path) === pending) queues.delete(path); }
}

type Rule = [RegExp, Outcome];
const match = (rules: Rule[], reason: string): Outcome => rules.find(([pattern]) => pattern.test(reason))?.[1] ?? 'other';

/** The board's drop reasons (board.ts validateItems). */
const BOARD_RULES: Rule[] = [
  [/^more than \d+ items in one scan$/, 'over_limit'], [/^unknown type$/, 'malformed'], [/^text over 300 characters$/, 'text_too_long'],
  [/^no text$/, 'no_text'], [/^unknown confidence$/, 'malformed'], [/^materials\/nonProject must be true or false$/, 'malformed'],
  [/^more than \d+ citations$/, 'too_many_citations'], [/^no citation$/, 'no_citation'], [/^citation outside the scanned lines$/, 'invalid_citation'],
  [/^cites only earlier lines$/, 'earlier_lines_only'], [/^quote must be \d+-\d+ words$/, 'quote_length'], [/^quote not found in the cited lines$/, 'quote_not_found'],
  [/^quote joins lines of different speakers$/, 'quote_joins_speakers'], [/^quote spans lines that are not consecutive$/, 'quote_not_consecutive'],
  [/^quote is only in earlier lines$/, 'quote_in_earlier_lines'],
];
/** A board scan: each kept item passed; each dropped one failed for its reason. */
export function boardOutcomes(result: { kept: unknown[]; dropped: { reason: string }[] }): Outcome[] {
  return [...result.kept.map(() => 'passed' as const), ...result.dropped.map(d => match(BOARD_RULES, d.reason))];
}

/** The notes' Needs review and drop reasons (notes.ts validateNotes). */
const NOTES_RULES: Rule[] = [
  [/^no text$/, 'no_text'], [/^malformed: /, 'malformed'], [/^no valid citation$/, 'no_citation'], [/^cites non-project talk/, 'non_project'],
  [/^too long for one claim$/, 'text_too_long'], [/^more than \d+ citations$/, 'too_many_citations'], [/^no quote$/, 'no_quote'],
  [/^quote too long$/, 'quote_too_long'], [/^quote too short to support the item$/, 'quote_too_short'],
  [/^quote not found after an invalid citation was removed$/, 'quote_not_found_after_invalid_citation'], [/^quote not found in the cited lines$/, 'quote_not_found'],
  [/^duplicate$/, 'duplicate'], [/^more than \d+ items$/, 'over_limit'],
];
/** Dropped-list lines that are not an item's outcome: an owner left unconfirmed (the item is kept), entries never read, ranges. */
const NOT_AN_ITEM = /^owner not explicitly assigned|^more than \d+ entries$/;
/** A notes run: kept items passed, Needs review items failed for their reason, dropped items for theirs. */
export function notesOutcomes(result: { notes: Notes; dropped: NotesRecord['dropped'] }): Outcome[] {
  const { notes, dropped } = result;
  return [
    ...(['summary', 'decisions', 'actions', 'openQuestions', 'otherMatters'] as const).flatMap(section => notes[section].map(item => item.quoteCheck ?? 'passed' as const)),
    ...notes.needsReview.map(item => match(NOTES_RULES, item.reviewReason ?? '')),
    ...dropped.filter(d => d.section !== 'otherTalk' && !NOT_AN_ITEM.test(d.reason)).map(d => match(NOTES_RULES, d.reason)),
  ];
}

/** A plan's state items, checked against transcript lines, materials and fetched pages (plans/validate.ts checkSource). */
const PLANS_RULES: Rule[] = [
  [/^no quote$/, 'no_quote'], [/^quote too short to support the item$/, 'quote_too_short'], [/^quote too long$/, 'quote_too_long'],
  [/^quote not found/, 'quote_not_found'], [/^no transcript line /, 'invalid_citation'], [/^no file given$/, 'no_citation'],
  [/^unknown material root/, 'invalid_citation'], [/^the path is in /, 'invalid_citation'], [/^the citation names both /, 'invalid_citation'],
  [/^no line number$/, 'invalid_citation'], [/^not read in this run$/, 'source_not_read'], [/^no page lines were recorded for this PDF/, 'pdf_lines_missing'],
  [/^no address given$/, 'no_citation'], [/^not fetched in this run$/, 'source_not_read'], [/^unknown source type null$/, 'no_citation'],
  [/^unknown source type /, 'invalid_citation'], [/^no text$/, 'no_text'], [/ is defined more than once$/, 'duplicate_id'],
];
/** A plans run: each state item in the registry once (quick checks are Python runs, not quotes). */
export function plansOutcomes(run: Pick<CheckedRun, 'evidence'>): Outcome[] {
  return Object.values(run.evidence).filter(e => e.kind === 'state').map(e => e.result.ok ? 'passed' : match(PLANS_RULES, e.result.reason ?? ''));
}

/** An answer's source checks (actions.ts checkAnswer): status, and for an invalid or missing quote its detail. */
const ACTION_INVALID: Rule[] = [
  [/^malformed source: no quote$/, 'no_quote'], [/^malformed source: /, 'malformed'], [/^unknown material root$/, 'invalid_citation'],
  [/^live project-memory files are not a source/, 'invalid_citation'], [/^outside the attached materials$/, 'invalid_citation'],
  [/^file not found$/, 'source_not_found'], [/^not a file$/, 'source_not_found'], [/^no text from this PDF/, 'source_unreadable'],
  [/^file not readable$/, 'source_unreadable'], [/^no valid line range$/, 'invalid_citation'], [/^more than \d+ line ranges$/, 'invalid_citation'],
  [/^lines \d+–\d+ are not inside the file/, 'invalid_citation'], [/^range too broad/, 'invalid_citation'], [/^not a web address$/, 'invalid_citation'],
];
export function actionOutcomes(checks: Pick<SourceCheck, 'status' | 'detail'>[]): Outcome[] {
  return checks.map(({ status, detail }) => {
    switch (status) {
      case 'quote found': return 'passed';
      case 'quote not found': return detail === 'no usable quote' ? 'quote_too_short' : 'quote_not_found';
      case 'invalid': return match(ACTION_INVALID, detail ?? '');
      case 'quote in search snippet': return 'quote_in_search_snippet';
      case 'seen in search only': case 'not seen': return 'source_not_read';
      case 'fetch failed': return 'source_unreadable';
      default: return 'other';
    }
  });
}

export type QuoteRow = { feature: string; model: string; checked: number; passed: number; failed: number; quoteFailed: number; reasons: Partial<Record<Outcome, number>> };
/** Totals per feature and model (all weeks), overall, and per week, for the report script. */
export function summarize(counts: QuoteCounts) {
  const row = (feature: string, model: string): QuoteRow => ({ feature, model, checked: 0, passed: 0, failed: 0, quoteFailed: 0, reasons: {} });
  const add = (r: QuoteRow, outcome: Outcome, n: number) => {
    r.checked += n;
    if (OUTCOMES[outcome] === 'passed') {
      r.passed += n;
      if (outcome !== 'passed') r.reasons[outcome] = (r.reasons[outcome] ?? 0) + n;
      return;
    }
    r.failed += n;
    if (OUTCOMES[outcome] === 'quote' || OUTCOMES[outcome] === 'citation') r.quoteFailed += n;
    r.reasons[outcome] = (r.reasons[outcome] ?? 0) + n;
  };
  const rows: QuoteRow[] = [], total = row('all', 'all models'), weeks: Record<string, QuoteRow> = {};
  for (const feature of QUOTE_FEATURES) {
    for (const [model, byWeek] of Object.entries(counts[feature] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const r = row(feature, model);
      for (const [week, outcomes] of Object.entries(byWeek)) {
        for (const [outcome, n] of Object.entries(outcomes) as [Outcome, number][]) { add(r, outcome, n); add(total, outcome, n); add(weeks[week] ??= row('all', week), outcome, n); }
      }
      rows.push(r);
    }
  }
  const sorted = (r: QuoteRow) => ({ ...r, reasons: Object.fromEntries(Object.entries(r.reasons).sort(([a], [b]) => a.localeCompare(b))) });
  return { rows: rows.map(sorted), total: sorted(total), weeks: Object.fromEntries(Object.keys(weeks).sort().map(w => [w, sorted(weeks[w])])) };
}
