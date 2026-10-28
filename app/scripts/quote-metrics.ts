// The local quote-check counts (src/quote-metrics.ts) as a table: per feature and model, the claims checked, the share that
// failed, the share whose quote or citation did not check out, and the top reasons. Read-only; --json for machine use.
// Usage: node --experimental-strip-types scripts/quote-metrics.ts [quote-checks.json | data folder] [--json]
// Without a path it reads <MEETING_DATA_DIR or app/data>/metrics/quote-checks.json.
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQuoteCounts, quoteMetricsPath, summarize, type QuoteRow } from '../src/quote-metrics.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const unknown = args.find(a => a.startsWith('-') && a !== '--json');
const paths = args.filter(a => !a.startsWith('-'));
if (unknown || paths.length > 1) {
  console.error('Usage: node --experimental-strip-types scripts/quote-metrics.ts [quote-checks.json | data folder] [--json]');
  process.exit(2);
}
const target = resolve(paths[0] ?? process.env.MEETING_DATA_DIR ?? join(ROOT, 'data'));
let path = paths[0] ? target : quoteMetricsPath(target);
try { if (statSync(target).isDirectory()) path = quoteMetricsPath(target); } catch { /* a missing path reads as no counts */ }

const summary = summarize(await loadQuoteCounts(path));
if (args.includes('--json')) console.log(JSON.stringify({ file: path, ...summary }, null, 2));
else if (!summary.rows.length) console.log(`No quote checks recorded yet (${path}).`);
else {
  const pct = (n: number, of: number) => `${(100 * n / of).toFixed(1)}%`;
  const top = (r: QuoteRow) => Object.entries(r.reasons).sort(([a, x], [b, y]) => y! - x! || a.localeCompare(b)).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
  const table = [['feature', 'model', 'checked', 'failed', 'quote/cite', 'top reasons'],
    ...[...summary.rows, summary.total].map(r => [r.feature, r.model, String(r.checked), pct(r.failed, r.checked), pct(r.quoteFailed, r.checked), top(r)])];
  const width = table[0].map((_, i) => Math.max(...table.map(row => row[i].length)));
  // Text columns left-aligned, numbers right-aligned; the last column is not padded.
  for (const row of table) console.log(row.map((cell, i) => i === row.length - 1 ? cell : i < 2 ? cell.padEnd(width[i]) : cell.padStart(width[i])).join('  '));
  console.log(`\nCounts only, from ${path}. failed: everything not passed, i.e. dropped (board; notes duplicates and items over a limit), sent to Needs review (notes, plans), or shown with a failed check (actions).`);
  console.log('quote/cite: the quote was missing, the wrong length or not found, or its citation was invalid or never read.');
  for (const row of summary.rows) for (const outcome of ['passed_after_nearby_line', 'passed_spans_lines', 'passed_quote_located', 'passed_elided'] as const)
    if (row.reasons[outcome]) console.log(`${row.feature} ${row.model}: ${outcome} ${row.reasons[outcome]} (counted as passed).`);
}
