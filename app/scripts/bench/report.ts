// Rebuild the results section of docs/benchmarks.md from raw JSON. Text outside the markers is left as it is.
// Usage: npm run bench:report -- [file.json ...]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchPaths } from './ami.ts';
import { parseResult, type BenchResult, type CountSummary, type LiveFile, type WerFile, type WerSession } from './results.ts';
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

/** Replace the marker section. The same runs produce the same text, including a second run on the output. */
export function renderBench(markdown: string, runs: BenchResult[]): string {
  return spliceMarkers(markdown, runs.length ? renderRuns(runs) : 'not yet measured');
}

export function spliceMarkers(markdown: string, body: string): string {
  const start = markdown.indexOf(BEGIN);
  const stop = markdown.indexOf(END);
  if (start < 0 || stop < start) throw new Error(`Missing ${BEGIN} / ${END} markers.`);
  return `${markdown.slice(0, start + BEGIN.length)}\n${body.replace(/\s+$/, '')}\n${markdown.slice(stop)}`;
}

function renderRuns(runs: BenchResult[]): string {
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.kind.localeCompare(b.kind) || (a.runLabel ?? '').localeCompare(b.runLabel ?? ''));
  const lines = [ATTRIBUTION, '', '### Runs', '', ...markdownTable(
    ['Run', 'Kind', 'Date', 'Label', 'Model', 'Commit', 'macOS', 'Chip', 'RAM'],
    ordered.map((run, index) => [index + 1, run.kind, run.createdAt, run.runLabel ?? '', run.model, run.commit, run.macos, run.chip, formatRam(run.ramBytes)]),
  )];
  for (const run of ordered) if (run.error) lines.push('', `Run ${ordered.indexOf(run) + 1} stopped early: ${oneLine(run.error)}`);
  const werRuns = ordered.filter((run): run is WerFile => run.kind === 'wer');
  const liveRuns = ordered.filter((run): run is LiveFile => run.kind === 'live');
  if (werRuns.length) lines.push('', ...renderWer(ordered, werRuns));
  if (liveRuns.length) lines.push('', ...renderLive(ordered, liveRuns));
  return lines.join('\n');
}

function renderWer(ordered: BenchResult[], runs: WerFile[]): string[] {
  const lines = ['### Accuracy', '', ...markdownTable(
    ['Run', 'WER', 'S', 'D', 'I', 'N', 'Audio', 'Wall'],
    runs.map(run => [no(ordered, run), formatPercent(run.totals.wer), run.totals.substitutions, run.totals.deletions, run.totals.insertions, run.totals.referenceWords, formatSeconds(run.totals.audioSeconds), formatSeconds(run.totals.wallSeconds)]),
  )];
  const finished = runs.filter(run => !run.error);
  if (finished.length >= 2) {
    const spread = medianSpread(finished.map(run => run.totals.wer));
    lines.push('', `Median WER across ${finished.length} runs: ${formatPercent(spread.median)} (min ${formatPercent(spread.min)}, max ${formatPercent(spread.max)}).`);
  }
  lines.push('', '#### Per session', '', ...sessionTable(ordered, runs));
  return lines;
}

function sessionTable(ordered: BenchResult[], runs: WerFile[]): string[] {
  const keys = new Map<string, { meetingId: string; mic: string }>();
  for (const run of runs) for (const session of run.sessions) keys.set(`${session.meetingId}\t${session.mic}`, { meetingId: session.meetingId, mic: session.mic });
  const header = ['Session', 'Mic', ...runs.map(run => `Run ${no(ordered, run)}`)];
  const several = runs.length >= 2;
  if (several) header.push('Median');
  const rows = [...keys.values()].sort((a, b) => a.meetingId.localeCompare(b.meetingId) || a.mic.localeCompare(b.mic)).map(key => {
    const values = runs.map(run => run.sessions.find(session => session.meetingId === key.meetingId && session.mic === key.mic));
    const row: (string | number)[] = [key.meetingId, key.mic, ...values.map(cellWer)];
    if (several) {
      const present = values.filter((session): session is WerSession => Boolean(session));
      row.push(present.length >= 2 ? formatPercent(medianSpread(present.map(session => session.wer)).median) : '');
    }
    return row;
  });
  return markdownTable(header, rows);
}

function renderLive(ordered: BenchResult[], runs: LiveFile[]): string[] {
  const lines = ['### Live latency', '', 'Spoken to visible. Preview lag is each time the grey draft grows. Final lag is the first time each saved segment is shown.', '', ...markdownTable(
    ['Run', 'Session', 'Mic', 'From', 'Audio', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n', 'WER'],
    runs.map(run => [no(ordered, run), run.meetingId, run.mic, formatClock(run.fromSec), formatSeconds(run.audioSeconds),
      ...lagCells(run.preview), ...lagCells(run.final), formatPercent(run.wer.wer)]),
  )];
  const finished = runs.filter(run => !run.error);
  if (finished.length >= 2) {
    const preview = medianSpread(finished.map(run => run.preview.p50));
    const final = medianSpread(finished.map(run => run.final.p50));
    lines.push('', `Median preview p50 across ${finished.length} runs: ${formatLagValue(preview.median)} (min ${formatLagValue(preview.min)}, max ${formatLagValue(preview.max)}).`);
    lines.push(`Median final p50 across ${finished.length} runs: ${formatLagValue(final.median)} (min ${formatLagValue(final.min)}, max ${formatLagValue(final.max)}).`);
  }
  lines.push('', `Clock offset (page minus Node), recorded and not used in the lag: ${runs.map(run => formatOffset(run.clockOffsetMs)).join(', ')}.`);
  for (const run of runs) if (run.warning) lines.push('', `Run ${no(ordered, run)} lag warning: ${oneLine(run.warning)}`);
  lines.push('', '#### Diagnostic: reached server to available on server', '', 'LagMeter on the segments snapshot, from the PCM upload HTTP 201. This table is the server path, under the spoken-to-visible headline.', '', ...markdownTable(
    ['Run', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n'],
    runs.map(run => [no(ordered, run), ...lagCells(run.diagnostic.preview), ...lagCells(run.diagnostic.final)]),
  ));
  if (finished.length >= 2) {
    const preview = medianSpread(finished.map(run => run.diagnostic.preview.p50));
    const final = medianSpread(finished.map(run => run.diagnostic.final.p50));
    lines.push('', `Median diagnostic preview p50 across ${finished.length} runs: ${formatLagValue(preview.median)} (min ${formatLagValue(preview.min)}, max ${formatLagValue(preview.max)}).`);
    lines.push(`Median diagnostic final p50 across ${finished.length} runs: ${formatLagValue(final.median)} (min ${formatLagValue(final.min)}, max ${formatLagValue(final.max)}).`);
  }
  lines.push('', '### Resources', '', 'CPU is the ps percent. RSS is the resident set. The speech-worker columns sum the STT processes and whatever they spawn.', '', ...markdownTable(
    ['Run', 'Server CPU mean', 'Server CPU p95', 'Server CPU max', 'Server RSS mean', 'Server RSS p95', 'Server RSS max', 'Worker CPU mean', 'Worker CPU p95', 'Worker CPU max', 'Worker RSS mean', 'Worker RSS p95', 'Worker RSS max'],
    runs.map(run => [no(ordered, run), ...resourceCells(run.resources.server), ...resourceCells(run.resources.speechWorker)]),
  ));
  if (finished.length >= 2) {
    const cpu = medianSpread(finished.map(run => run.resources.server.cpu.mean));
    const rss = medianSpread(finished.map(run => run.resources.server.rssBytes.mean));
    const workerCpu = medianSpread(finished.map(run => run.resources.speechWorker.cpu.mean));
    const workerRss = medianSpread(finished.map(run => run.resources.speechWorker.rssBytes.mean));
    lines.push('', `Median server CPU mean across ${finished.length} runs: ${formatCpu(cpu.median)} (min ${formatCpu(cpu.min)}, max ${formatCpu(cpu.max)}).`);
    lines.push(`Median server RSS mean across ${finished.length} runs: ${formatMib(rss.median)} (min ${formatMib(rss.min)}, max ${formatMib(rss.max)}).`);
    lines.push(`Median worker CPU mean across ${finished.length} runs: ${formatCpu(workerCpu.median)} (min ${formatCpu(workerCpu.min)}, max ${formatCpu(workerCpu.max)}).`);
    lines.push(`Median worker RSS mean across ${finished.length} runs: ${formatMib(workerRss.median)} (min ${formatMib(workerRss.min)}, max ${formatMib(workerRss.max)}).`);
  }
  return lines;
}

function resourceCells(role: { cpu: CountSummary; rssBytes: CountSummary }): (string | number)[] {
  return [formatPoint(role.cpu, 'mean', formatCpu), formatPoint(role.cpu, 'p95', formatCpu), formatPoint(role.cpu, 'max', formatCpu),
    formatPoint(role.rssBytes, 'mean', formatMib), formatPoint(role.rssBytes, 'p95', formatMib), formatPoint(role.rssBytes, 'max', formatMib)];
}

function no(ordered: BenchResult[], run: BenchResult): number {
  return ordered.indexOf(run) + 1;
}

function cellWer(session: WerSession | undefined): string {
  return session ? formatPercent(session.wer) : '';
}

function formatPoint(summary: CountSummary, field: 'mean' | 'p95' | 'max', format: (value: number) => string): string {
  return summary.n === 0 ? 'n/a' : format(summary[field]);
}

function lagCells(summary: CountSummary): (string | number)[] {
  return [formatLag(summary, 'p50'), formatLag(summary, 'p95'), formatLag(summary, 'max'), summary.n];
}

function formatLag(summary: CountSummary, field: 'p50' | 'p95' | 'max'): string {
  return summary.n === 0 ? 'n/a' : formatLagValue(summary[field]);
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
