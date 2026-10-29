// Rebuild only the marked results section, grouping comparable repetitions before aggregating.
// Usage: npm run bench:report -- [file.json ...]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchPaths } from './ami.ts';
import { parseResult, validateCompletion, type BenchResult, type CountSummary, type LiveFile, type WerFile } from './results.ts';
import { medianSpread } from './stats.ts';

const BEGIN = '<!-- bench:begin -->';
const END = '<!-- bench:end -->';
const ATTRIBUTION = 'AMI Meeting Corpus, CC BY 4.0. Carletta et al., "The AMI Meeting Corpus", 2005. https://creativecommons.org/licenses/by/4.0/';

export function loadResults(files: string[]): BenchResult[] {
  return files.map(file => {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : 'invalid JSON'}`); }
    try { return parseResult(parsed); }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : 'invalid result'}`); }
  });
}

/** Missing provenance is legacy, never a basis for cross-run statistics. Selection order is immaterial. */
export function cohortKey(run: BenchResult): string | null {
  if (!run.modelIdentity || run.logicalCores === undefined || run.dirty === undefined || !run.nodeVersion || (run.kind === 'wer' && !run.condition)) return null;
  const set = (values: string[]) => [...new Set(values)].sort();
  const condition = run.kind === 'wer'
    ? [set(run.condition!.sessions), set(run.condition!.mics)]
    : [run.meetingId, run.mic, run.fromSec, run.minutes];
  return JSON.stringify([run.kind, run.modelIdentity.basename, run.modelIdentity.sha256,
    run.chip, run.ramBytes, run.logicalCores, run.commit, run.dirty, condition]);
}

/** Replace the marker section. The same runs produce the same text, including a second run on the output. */
export function renderBench(markdown: string, runs: BenchResult[]): string {
  return spliceMarkers(markdown, runs.length ? renderRuns(runs.map(validateCompletion)) : 'not yet measured');
}

export function spliceMarkers(markdown: string, body: string): string {
  const start = markdown.indexOf(BEGIN);
  const stop = markdown.indexOf(END);
  if (start < 0 || stop < start) throw new Error(`Missing ${BEGIN} / ${END} markers.`);
  return `${markdown.slice(0, start + BEGIN.length)}\n${body.replace(/\s+$/, '')}\n${markdown.slice(stop)}`;
}

function renderRuns(runs: BenchResult[]): string {
  const groups = new Map<string | null, BenchResult[]>();
  // Newest run first, which also orders cohorts by their newest run. Equal dates preserve input order.
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = cohortKey(run);
    const group = groups.get(key) ?? [];
    group.push(run); groups.set(key, group);
  }
  const lines = [ATTRIBUTION, '', 'Accuracy is custom-normalized WER; not directly comparable to published Whisper/NIST scores.'];
  let index = 0;
  for (const [key, group] of groups) {
    const legacy = key === null;
    const example = group[0];
    lines.push('', legacy ? '### Legacy' : `### Cohort ${++index} — ${example.kind}`, '',
      `${group.length} ${group.length === 1 ? 'run' : 'runs'}; ${group.filter(run => !run.error).length} finished.`, '');
    if (legacy) lines.push('Missing cohort provenance: inspection only; unrelated legacy runs are not aggregated.', '');
    else if (example.kind === 'wer') lines.push(`Condition: sessions ${example.condition!.sessions.slice().sort().join(', ')} × mics ${example.condition!.mics.slice().sort().join(', ')}.`, '');
    else lines.push(`Condition: ${example.meetingId}, ${example.mic}, from ${example.fromSec} s, ${example.minutes} minutes.`, '');
    lines.push(...markdownTable(
      ['Run', 'Kind', 'Date', 'Label', 'Model basename', 'Model SHA-256', 'Model bytes', 'Commit', 'Dirty', 'Node', 'macOS', 'Chip', 'RAM', 'Logical cores', 'Failed chunks', 'Unfinished chunks'],
      group.map((run, i) => [i + 1, run.kind, run.createdAt, run.runLabel ?? '', run.modelIdentity?.basename ?? run.model,
        run.modelIdentity?.sha256 ?? 'n/a', run.modelIdentity?.bytes ?? 'n/a', run.commit, run.dirty === undefined ? 'n/a' : String(run.dirty),
        run.nodeVersion ?? 'n/a', run.macos, run.chip, formatRam(run.ramBytes), run.logicalCores ?? 'n/a',
        run.kind === 'wer' ? run.sessions.reduce((n, s) => n + s.failedChunks, 0) : run.failedChunks ?? 'n/a',
        run.kind === 'wer' ? (run.sessions.every(s => s.unfinishedChunks !== undefined) ? run.sessions.reduce((n, s) => n + s.unfinishedChunks!, 0) : 'n/a') : run.unfinishedChunks ?? 'n/a']),
    ));
    for (const [i, run] of group.entries()) if (run.error) lines.push('', `Run ${i + 1} stopped early: ${oneLine(run.error)}`);
    const werRuns = group.filter((run): run is WerFile => run.kind === 'wer');
    const liveRuns = group.filter((run): run is LiveFile => run.kind === 'live');
    if (werRuns.length) lines.push('', ...renderWer(group, werRuns, !legacy));
    if (liveRuns.length) lines.push('', ...renderLive(group, liveRuns, !legacy));
  }
  return lines.join('\n');
}

function aggregate(label: string, values: number[], format: (n: number) => string): string {
  const prefix = `Median ${label} across ${values.length} eligible ${values.length === 1 ? 'run' : 'runs'}:`;
  if (!values.length) return `${prefix} n/a.`;
  const spread = medianSpread(values);
  return `${prefix} ${format(spread.median)} (min ${format(spread.min)}, max ${format(spread.max)}).`;
}

function renderWer(ordered: BenchResult[], runs: WerFile[], aggregateRuns: boolean): string[] {
  const lines = ['#### Accuracy: custom-normalized WER', '', ...markdownTable(
    ['Run', 'Custom-normalized WER', 'S', 'D', 'I', 'N', 'Audio', 'Wall'],
    runs.map(run => [no(ordered, run), run.totals.referenceWords > 0 ? formatPercent(run.totals.wer) : 'n/a', run.totals.substitutions, run.totals.deletions, run.totals.insertions, run.totals.referenceWords, formatSeconds(run.totals.audioSeconds), formatSeconds(run.totals.wallSeconds)]),
  )];
  if (aggregateRuns) lines.push('', aggregate('custom-normalized WER', runs.filter(run => !run.error && run.totals.referenceWords > 0).map(run => run.totals.wer), formatPercent));
  lines.push('', '##### Per session', '', ...sessionTable(ordered, runs, aggregateRuns));
  return lines;
}

function sessionTable(ordered: BenchResult[], runs: WerFile[], aggregateRuns: boolean): string[] {
  const keys = new Map<string, { meetingId: string; mic: string }>();
  for (const run of runs) for (const session of run.sessions) keys.set(`${session.meetingId}\t${session.mic}`, { meetingId: session.meetingId, mic: session.mic });
  const header = ['Session', 'Mic', ...runs.map(run => `Run ${no(ordered, run)}`)];
  if (aggregateRuns) header.push('Median', 'Eligible runs');
  const rows = [...keys.values()].sort((a, b) => a.meetingId.localeCompare(b.meetingId) || a.mic.localeCompare(b.mic)).map(key => {
    const values = runs.map(run => run.sessions.find(session => session.meetingId === key.meetingId && session.mic === key.mic));
    const row: (string | number)[] = [key.meetingId, key.mic, ...values.map(session => session && session.referenceWords > 0 ? formatPercent(session.wer) : 'n/a')];
    if (aggregateRuns) {
      const eligible = values.flatMap((session, i) => session && !runs[i].error && session.referenceWords > 0 ? [session.wer] : []);
      row.push(eligible.length ? formatPercent(medianSpread(eligible).median) : 'n/a', eligible.length);
    }
    return row;
  });
  return markdownTable(header, rows);
}

function renderLive(ordered: BenchResult[], runs: LiveFile[], aggregateRuns: boolean): string[] {
  const lines = ['#### Live latency', '', 'Spoken to visible. Preview lag is each time the grey draft grows. Final lag is the first time each saved segment is shown.', '', ...markdownTable(
    ['Run', 'Session', 'Mic', 'From', 'Audio', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n', 'Custom-normalized WER'],
    runs.map(run => [no(ordered, run), run.meetingId, run.mic, formatClock(run.fromSec), formatSeconds(run.audioSeconds),
      ...lagCells(run.preview), ...lagCells(run.final), run.wer.referenceWords > 0 ? formatPercent(run.wer.wer) : 'n/a']),
  )];
  const finished = runs.filter(run => !run.error);
  const metric = (label: string, pick: (run: LiveFile) => CountSummary, field: 'p50' | 'mean', format: (n: number) => string) =>
    aggregate(label, finished.flatMap(run => pick(run).n > 0 ? [pick(run)[field]] : []), format);
  if (aggregateRuns) lines.push('', metric('preview p50', run => run.preview, 'p50', formatLagValue), metric('final p50', run => run.final, 'p50', formatLagValue));
  lines.push('', `Clock offset (page minus Node), recorded and not used in the lag: ${runs.map(run => formatOffset(run.clockOffsetMs)).join(', ')}.`);
  for (const run of runs) if (run.warning) lines.push('', `Run ${no(ordered, run)} lag warning: ${oneLine(run.warning)}`);
  lines.push('', '##### Diagnostic: reached server to available on server', '', 'LagMeter on the segments snapshot, from the PCM upload HTTP 201. This table is the server path, under the spoken-to-visible headline.', '', ...markdownTable(
    ['Run', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n'],
    runs.map(run => [no(ordered, run), ...lagCells(run.diagnostic.preview), ...lagCells(run.diagnostic.final)]),
  ));
  if (aggregateRuns) lines.push('', metric('diagnostic preview p50', run => run.diagnostic.preview, 'p50', formatLagValue), metric('diagnostic final p50', run => run.diagnostic.final, 'p50', formatLagValue));
  lines.push('', '#### Resources', '', 'CPU is sampled macOS ps %cpu: a decaying average over up to a minute, not instantaneous or one-second utilization; 100% = one core. Maxima are sampled maxima. RSS is the resident set. The speech-worker columns sum the STT processes and whatever they spawn.', '', ...markdownTable(
    ['Run', 'Server CPU mean', 'Server CPU p95', 'Server CPU max', 'Server RSS mean', 'Server RSS p95', 'Server RSS max', 'Worker CPU mean', 'Worker CPU p95', 'Worker CPU max', 'Worker RSS mean', 'Worker RSS p95', 'Worker RSS max'],
    runs.map(run => [no(ordered, run), ...resourceCells(run.resources.server), ...resourceCells(run.resources.speechWorker)]),
  ));
  if (aggregateRuns) lines.push('',
    metric('server CPU mean', run => run.resources.server.cpu, 'mean', formatCpu),
    metric('server RSS mean', run => run.resources.server.rssBytes, 'mean', formatMib),
    metric('worker CPU mean', run => run.resources.speechWorker.cpu, 'mean', formatCpu),
    metric('worker RSS mean', run => run.resources.speechWorker.rssBytes, 'mean', formatMib));
  return lines;
}

function resourceCells(role: { cpu: CountSummary; rssBytes: CountSummary }): (string | number)[] {
  return [formatPoint(role.cpu, 'mean', formatCpu), formatPoint(role.cpu, 'p95', formatCpu), formatPoint(role.cpu, 'max', formatCpu),
    formatPoint(role.rssBytes, 'mean', formatMib), formatPoint(role.rssBytes, 'p95', formatMib), formatPoint(role.rssBytes, 'max', formatMib)];
}

function no(ordered: BenchResult[], run: BenchResult): number {
  return ordered.indexOf(run) + 1;
}

function formatPoint(summary: CountSummary, field: 'mean' | 'p95' | 'max', format: (value: number) => string): string {
  return summary.n > 0 ? format(summary[field]) : 'n/a';
}

function lagCells(summary: CountSummary): (string | number)[] {
  return [formatLag(summary, 'p50'), formatLag(summary, 'p95'), formatLag(summary, 'max'), summary.n];
}

function formatLag(summary: CountSummary, field: 'p50' | 'p95' | 'max'): string {
  return summary.n > 0 ? formatLagValue(summary[field]) : 'n/a';
}

function formatOffset(ms: number | null): string {
  return ms === null ? 'n/a' : `${ms.toFixed(1)} ms`;
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'inf';
}

function formatLagValue(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : 'n/a';
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

function formatCpu(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMib(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

function formatRam(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function markdownTable(headers: string[], rows: (string | number)[][]): string[] {
  const cell = (value: string | number) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)];
}

function resultFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let doc = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/benchmarks.md');
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--doc') {
      const value = args[++i];
      if (!value) throw new Error('Missing value for --doc.');
      doc = resolve(value);
    } else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else files.push(resolve(arg));
  }
  const chosen = files.length ? files : resultFiles(benchPaths().results);
  const markdown = readFileSync(doc, 'utf8');
  const next = renderBench(markdown, loadResults(chosen));
  if (next !== markdown) writeFileSync(doc, next);
  console.log(doc);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
