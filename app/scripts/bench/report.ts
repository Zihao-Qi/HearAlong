// Rebuild only the marked results section, grouping comparable repetitions before aggregating.
// Usage: npm run bench:report -- [file.json ...]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchPaths } from './ami.ts';
import { parseResult, validateCompletion, type BenchResult, type CallFile, type CallLag, type CountSummary, type LiveFile, type WerFile, type IhmFile } from './results.ts';
import type { CallCondition, Leak } from './call-mix.ts';
import { TALK_STATES } from './call-mix.ts';
import { medianSpread } from './stats.ts';
import { sumScores } from './breakdown.ts';

const BEGIN = '<!-- bench:begin -->';
const END = '<!-- bench:end -->';
const CALL_BEGIN = '<!-- bench-call:begin -->';
const CALL_END = '<!-- bench-call:end -->';
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
  if (!run.modelIdentity || run.logicalCores === undefined || run.dirty === undefined || !run.nodeVersion || (run.kind !== 'live' && !run.condition)) return null;
  const set = (values: string[]) => [...new Set(values)].sort();
  const condition = run.kind === 'call' ? [run.condition.mode, set(run.condition.pairs), run.condition.blocks, run.condition.smoke, run.condition.room]
    : run.kind !== 'live'
      ? [set(run.condition!.sessions), set(run.condition!.mics)]
      : [run.meetingId, run.mic, run.fromSec, run.minutes];
  return JSON.stringify([run.kind, run.modelIdentity.basename, run.modelIdentity.sha256,
    run.chip, run.ramBytes, run.logicalCores, run.commit, run.dirty, condition,
    run.normalizer ?? 'hearalong-1', run.scoringCommit ?? run.commit, run.scoringDirty ?? run.dirty]);
}

/** Replace the marker section. The same runs produce the same text, including a second run on the output. */
export function renderBench(markdown: string, runs: BenchResult[]): string {
  const calls = runs.filter((run): run is CallFile => run.kind === 'call'), others = runs.filter(run => run.kind !== 'call');
  const next = spliceMarkers(markdown, others.length ? renderRuns(others.map(validateCompletion)) : 'not yet measured');
  // Call runs have their own section. A document without it is left alone, unless there are call runs to place.
  if (!markdown.includes(CALL_BEGIN) && !calls.length) return next;
  return spliceMarkers(next, calls.length ? renderCallRuns(calls.map(validateCompletion)) : 'not yet measured', CALL_BEGIN, CALL_END);
}

export function spliceMarkers(markdown: string, body: string, begin = BEGIN, end = END): string {
  const start = markdown.indexOf(begin);
  const stop = markdown.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`Missing ${begin} / ${end} markers.`);
  return `${markdown.slice(0, start + begin.length)}\n${body.replace(/\s+$/, '')}\n${markdown.slice(stop)}`;
}

function cohorts<T extends BenchResult>(runs: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = cohortKey(run) ?? `legacy:${run.normalizer ?? 'hearalong-1'}`;
    groups.set(key, [...groups.get(key) ?? [], run]);
  }
  return groups;
}

function provenanceTable(group: BenchResult[]): string[] {
  return markdownTable(
    ['Run', 'Kind', 'Date', 'Label', 'Model basename', 'Model SHA-256', 'Model bytes', 'Commit', 'Dirty', 'Node', 'macOS', 'Chip', 'RAM', 'Logical cores', 'Failed chunks', 'Unfinished chunks'],
    group.map((run, i) => [i + 1, run.kind, run.createdAt, run.runLabel ?? '', run.modelIdentity?.basename ?? run.model,
      run.modelIdentity?.sha256 ?? 'n/a', run.modelIdentity?.bytes ?? 'n/a', run.commit, run.dirty === undefined ? 'n/a' : String(run.dirty),
      run.nodeVersion ?? 'n/a', run.macos, run.chip, formatRam(run.ramBytes), run.logicalCores ?? 'n/a',
      run.kind === 'call' || run.kind === 'live' ? run.failedChunks ?? 'n/a' : run.sessions.reduce((n, s) => n + s.failedChunks, 0),
      run.kind === 'call' || run.kind === 'live' ? run.unfinishedChunks ?? 'n/a' : (run.sessions.every(s => s.unfinishedChunks !== undefined) ? run.sessions.reduce((n, s) => n + s.unfinishedChunks!, 0) : 'n/a')]));
}

const CALL_MODE_ORDER: Record<CallCondition, number> = { echo: 0, control: 1, raw: 2 };
const CALL_MODE_LABELS: Record<CallCondition, string> = { echo: 'with echo', control: 'control, no echo', raw: 'raw, with echo, AEC off' };

function renderCallRuns(runs: CallFile[]): string {
  const lines = [ATTRIBUTION, '', 'Accuracy is custom-normalized WER; not directly comparable to published Whisper/NIST scores. Echo is simulated (see Method).'];
  let index = 0;
  const numbers = new Map<string, number>();
  // Files of one run share a date; fix the mode order so ties never depend on the order of the input files.
  const ordered = [...runs].sort((a, b) => CALL_MODE_ORDER[a.condition.mode] - CALL_MODE_ORDER[b.condition.mode] || a.condition.batch.localeCompare(b.condition.batch));
  for (const [key, group] of cohorts(ordered)) {
    const legacy = key.startsWith('legacy:'), example = group[0], finished = group.filter(run => !run.error);
    const mode = CALL_MODE_LABELS[example.condition.mode];
    if (!legacy) numbers.set(key, index + 1);
    lines.push('', legacy ? '### Legacy' : `### Call cohort ${++index} — ${mode}`, '', `${group.length} ${group.length === 1 ? 'run' : 'runs'}; ${finished.length} finished.`, '',
      `Normalizer: ${example.normalizer ?? 'hearalong-1'}. Scoring commit: ${example.scoringCommit ?? example.commit}; scoring dirty: ${example.scoringDirty ?? example.dirty ?? 'unknown'}.`, '',
      `Condition: ${example.condition.blocks} blocks of 20 s per pair${example.condition.smoke ? ' (smoke run)' : ''}; room ${example.condition.room}; pairs ${example.condition.pairs.join(', ')}.`, '',
      ...provenanceTable(group));
    for (const [i, run] of group.entries()) if (run.error) lines.push('', `Run ${i + 1} stopped early: ${oneLine(run.error)}`);
    const n = (run: CallFile) => group.indexOf(run) + 1;
    const wer = (score: { referenceWords: number; wer: number }) => score.referenceWords > 0 ? formatPercent(score.wer) : 'n/a';
    lines.push('', '#### Me (microphone)', '', 'Finished pairs only, counts summed. The shown view is what the transcript displays after the read-time echo rule.', '', ...markdownTable(
      ['Run', 'Pairs', 'Near-only WER', 'Double-talk WER', 'Me words in echo-only blocks', 'Far words in Me, echo only', 'Far words in Me, double talk', 'Genuine Me words hidden'],
      group.map(run => { const t = run.totals.score; return [n(run), run.totals.pairs, wer(t.nearOnly.me), wer(t.doubleTalk.me), t.echoOnly.leak.meWords,
        formatLeak(t.echoOnly.leak), formatLeak(t.doubleTalk.leak), formatHidden(t.nearOnly.hidden.genuine + t.doubleTalk.hidden.genuine, t.nearOnly.hidden.recognizedGenuine + t.doubleTalk.hidden.recognizedGenuine)]; })));
    lines.push('', UPPER_BOUNDS);
    if (!legacy) lines.push('', aggregate('Me near-only WER', finished.filter(r => r.totals.score.nearOnly.me.referenceWords).map(r => r.totals.score.nearOnly.me.wer), formatPercent),
      aggregate('Me double-talk WER', finished.filter(r => r.totals.score.doubleTalk.me.referenceWords).map(r => r.totals.score.doubleTalk.me.wer), formatPercent),
      aggregate('far-word rate in Me, echo only', finished.filter(r => r.totals.score.echoOnly.leak.farWords).map(r => r.totals.score.echoOnly.leak.rate), formatPercent));
    lines.push('', '#### Read-time echo rule', '', 'Raw is every saved Me line; shown is after the rule. Hidden genuine words are near-speaker reference words recognized correctly in a hidden Me line.', '', ...markdownTable(
      ['Run', 'Talk state', 'Me lines hidden', 'Me words hidden', 'Far words in Me, raw', 'Far words in Me, shown', 'Genuine Me words hidden', 'Me WER raw', 'Me WER shown'],
      group.flatMap(run => (['echoOnly', 'nearOnly', 'doubleTalk'] as const).map(state => { const t = run.totals.score[state]; return [n(run), STATE_NAMES[state], t.hidden.lines, t.hidden.words,
        formatLeak(t.leakRaw), formatLeak(t.leak), formatHidden(t.hidden.genuine, t.hidden.recognizedGenuine), state === 'echoOnly' ? 'n/a' : wer(t.meRaw), state === 'echoOnly' ? 'n/a' : wer(t.me)]; }))));
    lines.push('', UPPER_BOUNDS);
    lines.push('', '#### Them (call source)', '', ...markdownTable(['Run', 'Far alone WER (echo-only blocks)', 'Double-talk WER'],
      group.map(run => [n(run), wer(run.totals.score.echoOnly.them), wer(run.totals.score.doubleTalk.them)])));
    if (!legacy) lines.push('', aggregate('Them WER, far alone', finished.filter(r => r.totals.score.echoOnly.them.referenceWords).map(r => r.totals.score.echoOnly.them.wer), formatPercent));
    lines.push('', '#### Lag during a call', '', 'Spoken to visible, as in the live benchmark, per source, with preview growth counted per source. Samples pooled across finished pairs. The run waits after Stop until every chunk is final and the page shows every final line, so tail lines are included.', '', ...callLagTable(group, n, run => run.totals.lag),
      '', ...markdownTable(['Run', 'Me finals first shown after Stop', 'Them finals first shown after Stop'], group.map(run => [n(run), run.totals.afterStop.me, run.totals.afterStop.them])));
    if (!legacy) lines.push('', aggregate('Me preview p50', finished.filter(r => r.totals.lag.me.preview.n).map(r => r.totals.lag.me.preview.p50), formatLagValue),
      aggregate('Me final p50', finished.filter(r => r.totals.lag.me.final.n).map(r => r.totals.lag.me.final.p50), formatLagValue),
      aggregate('Them preview p50', finished.filter(r => r.totals.lag.them.preview.n).map(r => r.totals.lag.them.preview.p50), formatLagValue),
      aggregate('Them final p50', finished.filter(r => r.totals.lag.them.final.n).map(r => r.totals.lag.them.final.p50), formatLagValue));
    lines.push('', '#### Echo cancellation', '', 'From the server: microphone frames processed by the AEC worker (`echoStats`), the share of their samples that had call audio to cancel against, the wait for that audio, worker failures, and the once-per-recording notices that AEC passed raw audio.', '', ...markdownTable(
      ['Run', 'Pair', 'Mic frames', 'Through AEC', 'Reference covered', 'Mean wait', 'Max wait', 'Worker failures', 'Raw notices'],
      group.flatMap(run => run.pairs.map(pair => {
        const off = run.condition.mode === 'raw';
        return [n(run), pair.pair, pair.aec.micFrames,
          off ? 'off' : pair.aec.aecFrames,
          off ? 'off' : (pair.aec.referenceCoverage === null ? 'n/a' : formatPercent(pair.aec.referenceCoverage)),
          off ? 'off' : (pair.aec.meanWaitMs === null ? 'n/a' : `${Math.round(pair.aec.meanWaitMs)} ms`),
          off ? 'off' : (pair.aec.maxWaitMs === null ? 'n/a' : `${Math.round(pair.aec.maxWaitMs)} ms`),
          off ? 'off' : pair.aec.failures,
          off ? 'off' : (pair.aec.notices.length ? pair.aec.notices.map(oneLine).join(' / ') : 0)];
      }))));
    lines.push('', '#### Per pair', '', ...markdownTable(
      ['Run', 'Pair', 'Echo', 'Me near-only WER', 'Me double-talk WER', 'Far words in Me, echo only', 'Them WER, far alone', 'Genuine Me words hidden', 'Me final p50', 'Them final p50', 'Error'],
      group.flatMap(run => run.pairs.map(pair => { const t = pair.score; return [n(run), pair.pair, run.condition.mode === 'control' ? 'none' : `${pair.delayMs} ms, ${pair.gainDb} dB`, wer(t.nearOnly.me), wer(t.doubleTalk.me),
        formatLeak(t.echoOnly.leak), wer(t.echoOnly.them), formatHidden(t.nearOnly.hidden.genuine + t.doubleTalk.hidden.genuine, t.nearOnly.hidden.recognizedGenuine + t.doubleTalk.hidden.recognizedGenuine),
        formatLag(pair.lag.me.final, 'p50'), formatLag(pair.lag.them.final, 'p50'), pair.error ? oneLine(pair.error) : '']; }))));
    lines.push('', UPPER_BOUNDS);
    lines.push('', '##### Diagnostic: reached server to available on server', '', 'LagMeter on the segments snapshot, from each source\'s PCM upload HTTP 201, pooled across finished pairs. A final counts when the line reaches the snapshot, which can be before the page shows it.', '',
      ...callLagTable(group, n, run => run.totals.diagnostic));
  }
  lines.push(...renderCallControl(runs, numbers));
  return lines.join('\n');
}

type WerScore = { referenceWords: number; wer: number };
type MatchedBatch = { batch: string; echo?: CallFile; control?: CallFile; raw?: CallFile; createdAt: string };

function formatCohortList(values: number[]): string {
  if (values.length <= 1) return values.map(String).join('');
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

/** Me WER and side-by-side metrics across conditions from the same run, matched by batch, cohort by cohort. Never pooled across modes. */
function renderCallControl(runs: CallFile[], numbers: ReadonlyMap<string, number>): string[] {
  // Newest first, as cohorts() orders them, so the output does not depend on the order of the input files.
  const pairsOf = new Map<string, { echo: CallFile[]; control: CallFile[]; raw: CallFile[] }>();
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || CALL_MODE_ORDER[a.condition.mode] - CALL_MODE_ORDER[b.condition.mode] || a.condition.batch.localeCompare(b.condition.batch))) {
    const key = cohortKey({ ...run, condition: { ...run.condition, mode: 'echo' } });
    if (!key) continue;
    const entry = pairsOf.get(key) ?? { echo: [], control: [], raw: [] };
    entry[run.condition.mode].push(run); pairsOf.set(key, entry);
  }
  const lines: string[] = [];
  const wer = (score?: WerScore) => score && score.referenceWords > 0 ? formatPercent(score.wer) : 'n/a';
  const diff = (a?: WerScore, b?: WerScore) =>
    a && b && a.referenceWords && b.referenceWords && Number.isFinite(a.wer - b.wer) ? `${a.wer >= b.wer ? '+' : ''}${((a.wer - b.wer) * 100).toFixed(2)} pts` : 'n/a';
  const points = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)} pts`;
  let index = 0;
  for (const group of pairsOf.values()) {
    const batches = new Map<string, { echo?: CallFile; control?: CallFile; raw?: CallFile }>();
    for (const mode of ['echo', 'control', 'raw'] as const) {
      for (const run of group[mode]) {
        if (run.error) continue;
        const item = batches.get(run.condition.batch) ?? {};
        item[mode] ??= run;
        batches.set(run.condition.batch, item);
      }
    }
    const matched: MatchedBatch[] = [...batches.entries()]
      .map(([batch, entry]) => ({ batch, ...entry, createdAt: (entry.echo ?? entry.control ?? entry.raw)!.createdAt }))
      .filter(m => Number(Boolean(m.echo)) + Number(Boolean(m.control)) + Number(Boolean(m.raw)) >= 2)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.batch.localeCompare(a.batch));
    if (!matched.length) continue;
    const hasRaw = matched.some(m => m.raw !== undefined);
    const differences = (pick: (m: MatchedBatch) => [WerScore | undefined, WerScore | undefined]) =>
      matched.flatMap(m => {
        const [a, b] = pick(m);
        return a && b && a.referenceWords && b.referenceWords && Number.isFinite(a.wer - b.wer) ? [a.wer - b.wer] : [];
      });
    if (!hasRaw) {
      const example = matched[0].echo!.condition;
      const echoNo = numbers.get(cohortKey(matched[0].echo!)!), controlNo = numbers.get(cohortKey(matched[0].control!)!);
      lines.push('', `### Echo against control ${++index} (call cohorts ${echoNo} and ${controlNo})`, '', `Me WER with the simulated echo and in the control (the same microphone without echo, AEC still running), from the same runs. ${example.blocks} blocks per pair${example.smoke ? ' (smoke run)' : ''}; pairs ${example.pairs.join(', ')}. The difference is echo minus control, in percentage points.`, '',
        ...markdownTable(['Batch', 'Near only, echo', 'Near only, control', 'Near only, difference', 'Double talk, echo', 'Double talk, control', 'Double talk, difference'],
          matched.map(m => { const a = m.echo!.totals.score, b = m.control!.totals.score; return [m.batch, wer(a.nearOnly.me), wer(b.nearOnly.me), diff(a.nearOnly.me, b.nearOnly.me),
            wer(a.doubleTalk.me), wer(b.doubleTalk.me), diff(a.doubleTalk.me, b.doubleTalk.me)]; })));
      lines.push('', aggregate('near-only difference', differences(m => [m.echo?.totals.score.nearOnly.me, m.control?.totals.score.nearOnly.me]), points),
        aggregate('double-talk difference', differences(m => [m.echo?.totals.score.doubleTalk.me, m.control?.totals.score.doubleTalk.me]), points));
      lines.push('', '#### Per pair', '', ...markdownTable(['Batch', 'Pair', 'Near only, echo', 'Near only, control', 'Near only, difference', 'Double talk, echo', 'Double talk, control', 'Double talk, difference'],
        matched.flatMap(m => m.echo!.pairs.flatMap(pe => {
          const pc = m.control!.pairs.find(item => item.pair === pe.pair);
          if (!pc || pe.error || pc.error) return [];
          const a = pe.score, b = pc.score;
          return [[m.batch, pe.pair, wer(a.nearOnly.me), wer(b.nearOnly.me), diff(a.nearOnly.me, b.nearOnly.me), wer(a.doubleTalk.me), wer(b.doubleTalk.me), diff(a.doubleTalk.me, b.doubleTalk.me)]];
        }))));
      continue;
    }
    const firstOf = (mode: CallCondition) => matched.find(m => m[mode])?.[mode];
    const cohortNos = (['echo', 'control', 'raw'] as const).flatMap(mode => {
      const sample = firstOf(mode);
      const no = sample ? numbers.get(cohortKey(sample)!) : undefined;
      return no !== undefined ? [no] : [];
    });
    const example = (matched[0].echo ?? matched[0].raw ?? matched[0].control)!.condition;
    lines.push('', `### Echo against control and raw ${++index} (call cohorts ${formatCohortList(cohortNos)})`, '',
      `Me WER with the simulated echo (echo, AEC on), without echo (control, AEC on), and raw (with echo, AEC off), from the same runs. ${example.blocks} blocks per pair${example.smoke ? ' (smoke run)' : ''}; pairs ${example.pairs.join(', ')}. The difference column is echo minus control, in percentage points.`, '',
      ...markdownTable(['Batch', 'Near only, echo', 'Near only, control', 'Near only, raw', 'Near only, difference', 'Double talk, echo', 'Double talk, control', 'Double talk, raw', 'Double talk, difference'],
        matched.map(m => {
          const e = m.echo?.totals.score, c = m.control?.totals.score, r = m.raw?.totals.score;
          return [m.batch, wer(e?.nearOnly.me), wer(c?.nearOnly.me), wer(r?.nearOnly.me), diff(e?.nearOnly.me, c?.nearOnly.me),
            wer(e?.doubleTalk.me), wer(c?.doubleTalk.me), wer(r?.doubleTalk.me), diff(e?.doubleTalk.me, c?.doubleTalk.me)];
        })));
    lines.push('',
      aggregate('near-only difference', differences(m => [m.echo?.totals.score.nearOnly.me, m.control?.totals.score.nearOnly.me]), points),
      aggregate('double-talk difference', differences(m => [m.echo?.totals.score.doubleTalk.me, m.control?.totals.score.doubleTalk.me]), points),
      aggregate('double-talk raw-minus-control difference', differences(m => [m.raw?.totals.score.doubleTalk.me, m.control?.totals.score.doubleTalk.me]), points),
      aggregate('double-talk echo-minus-raw difference', differences(m => [m.echo?.totals.score.doubleTalk.me, m.raw?.totals.score.doubleTalk.me]), points));
    lines.push('', '#### Per pair', '', ...markdownTable(['Batch', 'Pair', 'Near only, echo', 'Near only, control', 'Near only, raw', 'Near only, difference', 'Double talk, echo', 'Double talk, control', 'Double talk, raw', 'Double talk, difference'],
      matched.flatMap(m => {
        const order = (m.echo ?? m.raw ?? m.control)!.pairs.map(item => item.pair);
        return order.flatMap(pairName => {
          const pe = m.echo?.pairs.find(item => item.pair === pairName && !item.error);
          const pc = m.control?.pairs.find(item => item.pair === pairName && !item.error);
          const pr = m.raw?.pairs.find(item => item.pair === pairName && !item.error);
          if (Number(Boolean(pe)) + Number(Boolean(pc)) + Number(Boolean(pr)) < 2) return [];
          return [[m.batch, pairName, wer(pe?.score.nearOnly.me), wer(pc?.score.nearOnly.me), wer(pr?.score.nearOnly.me), diff(pe?.score.nearOnly.me, pc?.score.nearOnly.me),
            wer(pe?.score.doubleTalk.me), wer(pc?.score.doubleTalk.me), wer(pr?.score.doubleTalk.me), diff(pe?.score.doubleTalk.me, pc?.score.doubleTalk.me)]];
        });
      })));
    const optLeak = (leak?: Leak) => leak ? formatLeak(leak) : 'n/a';
    lines.push('', '#### Far words in Me', '', ...markdownTable(
      ['Batch', 'Echo-only Me words, echo', 'Echo-only Me words, control', 'Echo-only Me words, raw', 'Echo-only far words, echo', 'Echo-only far words, control', 'Echo-only far words, raw', 'Double-talk far words, echo', 'Double-talk far words, control', 'Double-talk far words, raw'],
      matched.map(m => [m.batch,
        m.echo ? m.echo.totals.score.echoOnly.leak.meWords : 'n/a', m.control ? m.control.totals.score.echoOnly.leak.meWords : 'n/a', m.raw ? m.raw.totals.score.echoOnly.leak.meWords : 'n/a',
        optLeak(m.echo?.totals.score.echoOnly.leak), optLeak(m.control?.totals.score.echoOnly.leak), optLeak(m.raw?.totals.score.echoOnly.leak),
        optLeak(m.echo?.totals.score.doubleTalk.leak), optLeak(m.control?.totals.score.doubleTalk.leak), optLeak(m.raw?.totals.score.doubleTalk.leak)])),
      '', UPPER_BOUNDS);
    lines.push('', '#### Read-time echo rule', '', ...markdownTable(
      ['Batch', 'Talk state', 'Condition', 'Me lines hidden', 'Me words hidden', 'Far words in Me, raw', 'Far words in Me, shown', 'Genuine Me words hidden', 'Me WER raw', 'Me WER shown'],
      matched.flatMap(m => TALK_STATES.flatMap(state => (['echo', 'control', 'raw'] as const).flatMap(cond => {
        const run = m[cond];
        if (!run) return [];
        const t = run.totals.score[state];
        return [[m.batch, STATE_NAMES[state], cond, t.hidden.lines, t.hidden.words, formatLeak(t.leakRaw), formatLeak(t.leak),
          formatHidden(t.hidden.genuine, t.hidden.recognizedGenuine), state === 'echoOnly' ? 'n/a' : wer(t.meRaw), state === 'echoOnly' ? 'n/a' : wer(t.me)]];
      })))),
      '', UPPER_BOUNDS);
    lines.push('', '#### Them (call source)', '', ...markdownTable(
      ['Batch', 'Far alone, echo', 'Far alone, control', 'Far alone, raw', 'Double talk, echo', 'Double talk, control', 'Double talk, raw'],
      matched.map(m => [m.batch, wer(m.echo?.totals.score.echoOnly.them), wer(m.control?.totals.score.echoOnly.them), wer(m.raw?.totals.score.echoOnly.them),
        wer(m.echo?.totals.score.doubleTalk.them), wer(m.control?.totals.score.doubleTalk.them), wer(m.raw?.totals.score.doubleTalk.them)])));
    lines.push('', '#### Lag during a call', '', ...markdownTable(
      ['Batch', 'Source', 'Condition', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n', 'After Stop'],
      matched.flatMap(m => (['me', 'them'] as const).flatMap(role => (['echo', 'control', 'raw'] as const).flatMap(cond => {
        const run = m[cond];
        if (!run) return [];
        const lag = run.totals.lag[role];
        return [[m.batch, role === 'me' ? 'Me' : 'Them', cond, ...lagCells(lag.preview), ...lagCells(lag.final), run.totals.afterStop[role]]];
      })))),
      '', '##### Diagnostic: reached server to available on server', '', ...markdownTable(
        ['Batch', 'Source', 'Condition', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n'],
        matched.flatMap(m => (['me', 'them'] as const).flatMap(role => (['echo', 'control', 'raw'] as const).flatMap(cond => {
          const run = m[cond];
          if (!run) return [];
          const lag = run.totals.diagnostic[role];
          return [[m.batch, role === 'me' ? 'Me' : 'Them', cond, ...lagCells(lag.preview), ...lagCells(lag.final)]];
        })))));
  }
  return lines;
}

const UPPER_BOUNDS = 'Both counts run slightly high: "far words in Me" in double talk can include a near word that matches a far word, and "genuine Me words" can include a leaked far word that matches a near reference word.';
const STATE_NAMES = { echoOnly: 'Echo only', nearOnly: 'Near only', doubleTalk: 'Double talk' } as const;

function callLagTable(group: CallFile[], n: (run: CallFile) => number, pick: (run: CallFile) => CallLag): string[] {
  return markdownTable(['Run', 'Source', 'Preview p50', 'Preview p95', 'Preview max', 'Preview n', 'Final p50', 'Final p95', 'Final max', 'Final n'],
    group.flatMap(run => { const lag = pick(run); return (['me', 'them'] as const).map(role => [n(run), role === 'me' ? 'Me' : 'Them', ...lagCells(lag[role].preview), ...lagCells(lag[role].final)]); }));
}

function formatLeak(leak: Leak): string {
  return leak.farWords ? `${leak.matched} of ${leak.farWords} (${formatPercent(leak.rate)})` : 'n/a';
}

function formatHidden(hidden: number, recognized: number): string {
  return recognized ? `${hidden} of ${recognized} (${formatPercent(hidden / recognized)})` : String(hidden);
}

function renderRuns(runs: BenchResult[]): string {
  // Newest run first, which also orders cohorts by their newest run. Equal dates preserve input order.
  const groups = cohorts(runs);
  const lines = [ATTRIBUTION, '', 'Accuracy is custom-normalized WER; not directly comparable to published Whisper/NIST scores.'];
  let index = 0;
  for (const [key, group] of groups) {
    const legacy = key?.startsWith('legacy:') ?? false;
    const example = group[0];
    lines.push('', legacy ? '### Legacy' : `### Cohort ${++index} — ${example.kind}`, '',
      `${group.length} ${group.length === 1 ? 'run' : 'runs'}; ${group.filter(run => !run.error).length} finished.`, '');
    lines.push(`Normalizer: ${example.normalizer ?? 'hearalong-1'}. Scoring commit: ${example.scoringCommit ?? example.commit}; scoring dirty: ${example.scoringDirty ?? example.dirty ?? 'unknown'}.`, '');
    if (legacy) lines.push('Missing cohort provenance: inspection only; unrelated legacy runs are not aggregated.', '');
    else if (example.kind === 'wer' || example.kind === 'ihm') lines.push(`Condition: sessions ${example.condition!.sessions.slice().sort().join(', ')} × mics ${example.condition!.mics.slice().sort().join(', ')}.`, '');
    else if (example.kind === 'live') lines.push(`Condition: ${example.meetingId}, ${example.mic}, from ${example.fromSec} s, ${example.minutes} minutes.`, '');
    lines.push(...provenanceTable(group));
    for (const [i, run] of group.entries()) if (run.error) lines.push('', `Run ${i + 1} stopped early: ${oneLine(run.error)}`);
    const werRuns = group.filter((run): run is WerFile | IhmFile => run.kind === 'wer' || run.kind === 'ihm');
    const ihmRuns = group.filter((run): run is IhmFile => run.kind === 'ihm');
    if (ihmRuns.length) lines.push('', 'Check of the Q8 model file against NVIDIA’s published AMI 10.14% (offline, Open ASR Leaderboard). Not an exact reproduction: our normalizer is not whisper-normalizer (numbers, fillers, contractions differ); NVIDIA’s segmentation may differ from AMI’s segments file.', '', ...markdownTable(
      ['Run', 'hearalong-2 WER', 'hearalong-1 WER', 'NVIDIA published WER', 'Clips'],
      ihmRuns.map(run => [no(group, run), formatPercent(run.totals.wer), formatPercent(run.legacyTotals.wer), '10.14%', run.clips])));
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

function renderWer(ordered: BenchResult[], runs: (WerFile | IhmFile)[], aggregateRuns: boolean): string[] {
  const lines = ['#### Accuracy: custom-normalized WER', '', ...markdownTable(
    ['Run', 'Custom-normalized WER', 'S', 'D', 'I', 'N', 'Audio', 'Wall'],
    runs.map(run => [no(ordered, run), run.totals.referenceWords > 0 ? formatPercent(run.totals.wer) : 'n/a', run.totals.substitutions, run.totals.deletions, run.totals.insertions, run.totals.referenceWords, formatSeconds(run.totals.audioSeconds), formatSeconds(run.totals.wallSeconds)]),
  )];
  if (aggregateRuns) lines.push('', aggregate('custom-normalized WER', runs.filter(run => !run.error && run.totals.referenceWords > 0).map(run => run.totals.wer), formatPercent));
  const eligible = runs.filter(run => !run.error);
  if (eligible.some(run => run.sessions.some(session => session.breakdown))) {
    lines.push('', '##### Per microphone', '', 'Corpus counts across eligible finished runs. Single-speaker excludes overlap and turns of at most two words. Insertions attach to the preceding reference word (leading insertions to the first).', '', ...markdownTable(
      ['Mic', 'Overall WER', 'Single-speaker WER', 'Share of missed words that were crosstalk'],
      [...new Set(eligible.flatMap(run => run.sessions.map(session => session.mic)))].sort().map(mic => {
        const sessions = eligible.flatMap(run => run.sessions.filter(session => session.mic === mic));
        const overall = sumScores(sessions), clean = sumScores(sessions.flatMap(session => session.breakdown ? [session.breakdown.singleSpeaker] : []));
        const overlapD = sessions.reduce((sum, session) => sum + (session.breakdown?.overlap.deletions ?? 0), 0);
        const complete = sessions.every(session => session.breakdown);
        return [mic, formatPercent(overall.wer), complete && clean.referenceWords ? formatPercent(clean.wer) : 'n/a', complete && overall.deletions ? formatPercent(overlapD / overall.deletions) : 'n/a'];
      })));
  }
  lines.push('', '##### Per session', '', ...sessionTable(ordered, runs, aggregateRuns));
  return lines;
}

function sessionTable(ordered: BenchResult[], runs: (WerFile | IhmFile)[], aggregateRuns: boolean): string[] {
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
