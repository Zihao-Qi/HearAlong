// A call heard through speakers, through the shipped v0.3.0 path: the real page and server, the server-side AEC3 worker with its
// alignment and wait, the read-time echo rule, and the Me/Them paragraphs. Usage:
// npm run bench:call -- [--pairs 1,2,3,4,5] [--smoke] [--run-label text] [--allow-dirty]
// Per pair, the page records a fake microphone (near speaker + simulated speaker echo of the far speaker) in real time, and a
// stand-in for the native capture helper sends the far speaker's clean audio as the meeting-app source. Needs MEETING_TEST_CHROME.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { runRehearsal } from '../rehearse.ts';
import { discoverModel } from '../../src/config.ts';
import { decodeChunk } from '../../src/audio.ts';
import { MeetingStore } from '../../src/store.ts';
import { wordSegments } from '../../src/segments.ts';
import { echoWords } from '../../src/echo-words.ts';
import { LagMeter } from '../lag-meter.ts';
import { benchPaths, reference } from './ami.ts';
import { planIhm } from './ihm.ts';
import { parseCallArgs } from './cli.ts';
import { machineInfo, modelIdentity } from './machine.ts';
import { chunkCompletionError, fileStamp, resultPath, type CallAec, type CallFile, type CallLag, type CallPairResult, type CountSummary } from './results.ts';
import { applySnapshot, domSight, frameEndMs, mergeSights, rememberSegmentEnds, spokenFrame, visibleLags, type DomSight, type SpokenFrame } from './snapshot.ts';
import { summarize } from './stats.ts';
import { NORMALIZER } from './wer.ts';
import { BenchCallHelper } from './call-helper.ts';
import { PAIRS, ROOM_VERSION, callLayout, farBlocks, layoutSamples, layoutSeconds, mixMicrophone, nearBlocks, pairName, pcm16Wav, placeClips, planClips,
  scoreCall, sumCallScores, wallToMeetingMs, type CallCondition, type CallPair, type Layout, type Line, type Source } from './call-mix.ts';

type Role = 'me' | 'them' | 'none';
type RoleSight = DomSight & { role: Role };
const APP = { id: 'bench.call.app', name: 'Bench Call' };
const AEC_NOTICE = 'AEC passes raw for this recording:';

// As live-run.ts, plus the paragraph's speaker class (.para.me / .para.them) on every sight.
const DOM_WATCH = `(() => {
  const previewEnd = new Map();
  const finals = new Set();
  const sights = [];
  const roleOf = (para) => para.classList.contains('them') ? 'them' : para.classList.contains('me') ? 'me' : 'none';
  const push = (sight) => {
    sights.push(sight);
    const send = window.__benchDomSample;
    if (typeof send !== 'function') return;
    try { void Promise.resolve(send(sight)).catch(() => {}); } catch { /* binding not ready */ }
  };
  const scan = () => {
    const at = Date.now();
    const root = document.getElementById('transcript');
    if (!root) return;
    for (const para of root.querySelectorAll('.para[data-kind="active"]')) {
      const text = para.querySelector('.preview-text');
      if (!text || !String(text.textContent || '').trim()) continue;
      const key = para.getAttribute('data-key') || '';
      const endMs = Number(para.getAttribute('data-end'));
      if (!key || !Number.isFinite(endMs)) continue;
      const before = previewEnd.get(key);
      if (before !== undefined && endMs <= before) continue;
      previewEnd.set(key, endMs);
      push({ kind: 'preview', key, endMs, at, role: roleOf(para) });
    }
    for (const span of root.querySelectorAll('.para[data-kind="final"] span[data-id]')) {
      const key = span.getAttribute('data-id') || '';
      if (!key || finals.has(key)) continue;
      const raw = span.getAttribute('data-end');
      const endMs = raw === null ? null : Number(raw);
      if (endMs !== null && !Number.isFinite(endMs)) continue;
      finals.add(key);
      push({ kind: 'final', key, endMs, at, role: roleOf(span.closest('.para')) });
    }
  };
  const arm = () => {
    if (!document.documentElement || window.__benchWatching) return;
    window.__benchWatching = true;
    window.__benchSights = sights;
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-end', 'data-kind', 'data-key', 'data-ids', 'data-id', 'class'],
    });
    scan();
  };
  if (document.documentElement) arm();
  else document.addEventListener('DOMContentLoaded', arm);
})();`;

const counts = (values: number[]): CountSummary => values.length ? summarize(values) : { mean: 0, p50: 0, p95: 0, max: 0, n: 0 };
type Samples = { me: { preview: number[]; final: number[] }; them: { preview: number[]; final: number[] } };
const lagOf = (samples: Samples): CallLag => ({ me: { preview: counts(samples.me.preview), final: counts(samples.me.final) },
  them: { preview: counts(samples.them.preview), final: counts(samples.them.final) } });
function roleSight(value: unknown): RoleSight | null {
  const sight = domSight(value);
  if (!sight) return null;
  const role = (value as { role?: unknown }).role;
  return { ...sight, role: role === 'me' || role === 'them' ? role : 'none' };
}

/** Utterances of one AMI speaker, packed into the talk-state blocks, on the call file's clock. */
async function speakerAudio(source: Source, blocks: number[], layout: Layout, root: string) {
  const words = reference(source.meeting, { root }).filter(word => word.speaker === source.speaker);
  const clips = planIhm([source.meeting], root).filter(clip => clip.speaker === source.speaker && clip.end - clip.start >= 1 && clip.end - clip.start <= 13
    && words.filter(word => word.start >= clip.start && word.end <= clip.end).length >= 4);
  if (!clips.length) throw new Error(`No usable utterances for ${source.meeting}.${source.speaker}.`);
  const planned = planClips(clips, blocks, layout);
  const audio = await decodeChunk(clips[0].path, 0, Math.max(...planned.map(item => item.end)) + 1);
  const placed = placeClips(audio, planned, words, layoutSamples(layout));
  return { ...placed, provenance: planned.map(clip => ({ ...source, sourceStart: clip.start, sourceEnd: clip.end, outputStart: clip.at })) };
}

/**
 * Every saved line (raw) and the ids the store's read boundary still shows after the echo rule. Word times come from the chunk's
 * recognition, cut the way MeetingStore cuts them, and only when they match the line's text and ends (as the store requires).
 */
function savedLines(directory: string, meetingId: string): { lines: Line[]; shown: Set<string> } {
  const store = new MeetingStore(directory);
  try {
    const rows = store.db.prepare('SELECT id, chunkId, source, startMs, endMs, text, ord, timing FROM segments WHERE meetingId = ? ORDER BY startMs, ord').all(meetingId) as unknown as (Line & { chunkId: string; timing: string; ord: number })[];
    const parts = new Map<string, ReturnType<typeof wordSegments>>();
    const lines = rows.map(row => {
      const line: Line = { id: row.id, source: row.source, startMs: row.startMs, endMs: row.endMs, text: row.text, ord: row.ord };
      if (row.timing !== 'word') return line;
      let cut = parts.get(row.chunkId);
      if (!cut) {
        const chunk = store.chunk(row.chunkId);
        let words: unknown;
        try { words = chunk?.metrics ? JSON.parse(chunk.metrics).words : undefined; } catch { words = undefined; }
        try { cut = chunk && Array.isArray(words) ? wordSegments(chunk.seconds * 1000, words).map(part => ({ ...part, words: part.words?.map(w => ({ ...w, t0Ms: w.t0Ms + chunk.startMs, t1Ms: w.t1Ms + chunk.startMs })) })) : []; }
        catch { cut = []; }
        parts.set(row.chunkId, cut);
      }
      const part = cut[row.ord];
      if (!part?.words?.length || echoWords(part.text).join(' ') !== echoWords(row.text).join(' ')
        || Math.abs(part.words[0].t0Ms - row.startMs) > 1 || Math.abs(part.words.at(-1)!.t1Ms - row.endMs) > 1) return line;
      return { ...line, words: part.words.map(w => ({ text: w.text, startMs: w.t0Ms, endMs: w.t1Ms })) };
    });
    return { lines, shown: new Set(store.segments(meetingId).map(segment => segment.id)) };
  } finally { store.close(); }
}

async function copySights(page: Page): Promise<RoleSight[]> {
  if (page.isClosed()) return [];
  try {
    const list = await page.evaluate(() => Reflect.get(globalThis, '__benchSights') ?? null);
    if (!Array.isArray(list)) return [];
    return list.flatMap(item => { const sight = roleSight(item); return sight ? [sight] : []; });
  } catch { return []; }
}

type PairAudio = Awaited<ReturnType<typeof speakerAudio>>;
type Settle = { waitedMs: number; chunksTerminal: boolean; expected: number; missing: number };

async function runPair(index: number, pair: CallPair, condition: CallCondition, audio: { near: PairAudio; far: PairAudio }, layout: Layout, modelPath: string, out: string, notices: string[]) {
  const name = `pair-${index}-${condition}`, folder = join(out, name);
  await mkdir(folder, { mode: 0o700 });
  console.log(`${name}: ${pairName(pair)}, ${condition === 'echo' ? `echo ${pair.delayMs} ms at ${pair.gainDb} dB` : 'control: no echo on the microphone'}`);
  const { near, far } = audio;
  const mixed = mixMicrophone(near.pcm, far.pcm, pair, 123 + index, condition);
  const micWav = join(folder, 'microphone.wav');
  await writeFile(micWav, pcm16Wav(mixed.mic), { mode: 0o600 });
  const helper = new BenchCallHelper(APP, mixed.call);
  const meMeter = new LagMeter(), themMeter = new LagMeter();
  const diagnostic = { me: { preview: [] as number[], final: [] as number[] }, them: { preview: [] as number[], final: [] as number[] } };
  const micFrames: SpokenFrame[] = [];
  const segmentEnds = new Map<string, number>(), segmentSources = new Map<string, string>();
  const exposed: RoleSight[] = [];
  let polled: RoleSight[] = [];
  let clockOffsetMs: number | null = null, accepted = 0;
  let idle = Promise.resolve(), sightsIdle = Promise.resolve();
  let stop = () => {};
  let failure: string | null = null;
  let settle: Settle | null = null;
  const directory = join(folder, 'run');
  const noticesBefore = notices.length;
  const attach = async (page: Page) => {
    page.on('response', response => {
      const request = response.request();
      if (request.method() !== 'POST' || response.status() !== 201) return;
      let pathname = '';
      try { pathname = new URL(response.url()).pathname; } catch { return; }
      if (!pathname.endsWith('/pcm')) return;
      const headers = request.headers(), bytes = request.postDataBuffer()?.length ?? Number(headers['content-length'] ?? 0);
      const frame = frameEndMs(headers, bytes);
      if (frame?.source.startsWith('mic:')) meMeter.audio(frame.source, frame.endMs, Date.now());
      const spoken = spokenFrame(headers, bytes);
      if (spoken?.source.startsWith('mic:')) micFrames.push(spoken);
    });
    await page.exposeFunction('__benchDomSample', (value: unknown) => { const sight = roleSight(value); if (sight) exposed.push(sight); });
    await page.addInitScript(DOM_WATCH);
  };
  try {
    await runRehearsal([micWav, '--headless'], async page => {
      try {
        const before = Date.now(), pageNow = await page.evaluate(() => Date.now()), after = Date.now();
        if (typeof pageNow === 'number' && Number.isFinite(pageNow)) clockOffsetMs = pageNow - (before + after) / 2;
      } catch { /* the page can close before the sample */ }
      let polling = false, copying = false;
      const tick = () => {
        if (polling) return;
        polling = true;
        idle = idle.then(async () => {
          if (page.isClosed()) return;
          const body = await page.evaluate(async () => {
            const status = await (await fetch('/api/status')).json() as { meetings?: { id: string; title: string }[] };
            const meeting = status.meetings?.find(item => item.title.startsWith('Rehearsal:')) ?? status.meetings?.[0];
            if (!meeting) return null;
            const response = await fetch(`/api/meetings/${meeting.id}/segments`);
            return response.ok ? await response.json() : null;
          });
          if (!body) return;
          // Call frames reach the meter when the helper saw their 201, in order.
          for (; accepted < helper.frames.length && helper.frames[accepted].acceptedAt !== null; accepted++) {
            const frame = helper.frames[accepted];
            themMeter.audio(frame.source, frame.endMs, frame.acceptedAt!);
          }
          rememberSegmentEnds(body, segmentEnds);
          for (const segment of Array.isArray(body.segments) ? body.segments : []) if (typeof segment?.id === 'string' && typeof segment.source === 'string') segmentSources.set(segment.id, segment.source);
          const now = Date.now();
          for (const [role, meter] of [['me', meMeter], ['them', themMeter]] as const) {
            const sample = applySnapshot(meter, body, now);
            diagnostic[role].preview.push(...sample.preview); diagnostic[role].final.push(...sample.final);
          }
        }).catch(() => { /* the page closes while the last finals settle */ }).finally(() => { polling = false; });
      };
      const takeSights = () => {
        if (copying) return;
        copying = true;
        sightsIdle = sightsIdle.then(async () => { const list = await copySights(page); if (list.length >= polled.length) polled = list; }).finally(() => { copying = false; });
      };
      const ticks = setInterval(tick, 250), sightTicks = setInterval(takeSights, 100);
      stop = () => { clearInterval(ticks); clearInterval(sightTicks); };
      tick(); takeSights();
    }, attach, { modelPath, terminalTimeoutMs: 30 * 60_000, directory, callApp: {
      app: helper.app, connect: url => helper.connect(url), anchor: at => helper.anchor(at),
      // After Stop and every job settled: confirm every chunk of both sources is terminal on the server, then wait (bounded) until
      // the page shows each final line the segments view lists, so tail lines are timed too.
      settled: async (page, meetingId) => {
        const begun = Date.now(), until = begun + 60_000;
        let last = { terminal: false, expected: [] as string[], visible: [] as string[] };
        while (!page.isClosed()) {
          last = await page.evaluate(async id => {
            const meeting = await (await fetch(`/api/meetings/${id}`)).json() as { chunks?: { status: string }[] };
            const lines = await (await fetch(`/api/meetings/${id}/segments`)).json() as { segments?: { id: string }[] };
            const visible = [...document.querySelectorAll('#transcript .para[data-kind="final"] span[data-id]')].map(node => node.getAttribute('data-id') ?? '');
            return { terminal: Boolean(meeting.chunks?.length) && meeting.chunks!.every(chunk => ['completed', 'failed', 'cancelled'].includes(chunk.status)),
              expected: (lines.segments ?? []).map(line => line.id), visible };
          }, meetingId).catch(() => last);
          const seen = new Set(last.visible);
          if (last.terminal && last.expected.every(id => seen.has(id))) break;
          if (Date.now() >= until) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        const seen = new Set(last.visible);
        settle = { waitedMs: Date.now() - begun, chunksTerminal: last.terminal, expected: last.expected.length, missing: last.expected.filter(id => !seen.has(id)).length };
      },
    } });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    stop();
    await helper.close();
  }
  await idle; await sightsIdle;
  const report = existsSync(join(directory, 'rehearsal.json')) ? JSON.parse(await readFile(join(directory, 'rehearsal.json'), 'utf8')) as {
    url?: string; reason?: string; errors?: string[]; startedAt?: number | null; meetingId?: string; failedChunks?: number; unfinishedChunks?: number;
    echo?: { frames: number; samples: number; missingSamples: number; computeMs: number; delayMs: number; maxDelayMs: number; failures: number } | null;
  } : {};
  if (report.url && new URL(report.url).port === '4318') failure ??= 'The run bound port 4318. It must use an ephemeral port.';
  if (report.reason && report.reason !== 'audio ended') failure ??= `Rehearsal ended: ${report.reason}.`;
  if (report.errors?.length) failure ??= report.errors.join('; ');
  const failedChunks = report.failedChunks ?? 0, unfinishedChunks = report.unfinishedChunks ?? 0;
  failure ??= chunkCompletionError(failedChunks, unfinishedChunks);
  if (helper.errors.length) failure ??= `Call helper: ${helper.errors.slice(0, 3).join('; ')}`;
  if (!helper.frames.length) failure ??= 'The call source never started: the page did not start meeting-app capture.';
  if (!micFrames.length) failure ??= 'No microphone frame was uploaded.';
  const startedAt = report.startedAt ?? null;
  if (startedAt === null) failure ??= 'The rehearsal did not record when the microphone started.';
  const micOffset = wallToMeetingMs(micFrames), callOffset = wallToMeetingMs(helper.frames);
  const timebase = { micZeroMs: (startedAt ?? 0) + (micOffset ?? 0), callZeroMs: (startedAt ?? 0) + (callOffset ?? 0) };
  let score = scoreCall({ layout, timebase, nearWords: near.words, farWords: far.words, lines: [], shown: new Set() });
  let lines: Line[] = [], shown = new Set<string>();
  if (report.meetingId) {
    ({ lines, shown } = savedLines(directory, report.meetingId));
    score = scoreCall({ layout, timebase, nearWords: near.words, farWords: far.words, lines, shown });
  } else failure ??= 'The rehearsal did not record a meeting id.';
  if (!lines.some(line => line.source.startsWith('mic:'))) failure ??= 'No Me line was saved.';
  if (!lines.some(line => line.source.startsWith('app:'))) failure ??= 'No Them line was saved.';
  const sights = mergeSights(polled, exposed).map(sight => sight as RoleSight);
  const roleOf = (sight: RoleSight): Role => {
    const source = sight.kind === 'final' ? segmentSources.get(sight.key) : undefined;
    return source ? (source.startsWith('mic:') ? 'me' : 'them') : sight.role;
  };
  // Preview growth is per source, not per row key: when a Them line lands, the Me/Them paragraphs regroup and the Me draft is
  // re-keyed into pieces whose ends were already visible. A per-key rule would count those as new, late samples.
  const forRole = (role: Role) => sights.filter(sight => roleOf(sight) === role).map(sight => sight.kind === 'preview' ? { ...sight, key: role } : sight);
  const meLags = visibleLags(micFrames, forRole('me'), segmentEnds);
  const themLags = visibleLags(helper.frames, forRole('them'), segmentEnds);
  const echo = report.echo ?? null;
  const aec: CallAec = {
    micFrames: micFrames.length, aecFrames: echo?.frames ?? 0, failures: echo?.failures ?? 0,
    referenceCoverage: echo && echo.samples ? 1 - echo.missingSamples / echo.samples : null,
    meanWaitMs: echo && echo.frames ? echo.delayMs / echo.frames : null, maxWaitMs: echo?.maxDelayMs ?? null,
    notices: notices.slice(noticesBefore),
  };
  const lag = lagOf({ me: meLags, them: themLags }), diag = lagOf(diagnostic);
  const settled = settle as Settle | null; // Set inside the rehearsal's callback.
  if (!settled) failure ??= 'The run did not reach the settled check.';
  else if (!settled.chunksTerminal) failure ??= 'Not every chunk was final after Stop.';
  else if (settled.missing) failure ??= `${settled.missing} of ${settled.expected} final lines never appeared on the page within 60 s after settling.`;
  // Finals first shown after the audio ended (when the run presses Stop), per source.
  const stopAt = (startedAt ?? 0) + layoutSeconds(layout) * 1000;
  const afterStop = { me: 0, them: 0 };
  for (const sight of sights) if (sight.kind === 'final' && sight.at > stopAt) { const role = roleOf(sight); if (role === 'me' || role === 'them') afterStop[role]++; }
  if (lag.me.final.n === 0 || lag.them.final.n === 0) failure ??= 'No final samples were observed for one of the sources.';
  const result: CallPairResult = {
    name, pair: pairName(pair), delayMs: pair.delayMs, gainDb: pair.gainDb, audioSeconds: layoutSeconds(layout), error: failure,
    failedChunks, unfinishedChunks, score, lag, diagnostic: diag, aec, afterStop, settle: settled ?? { waitedMs: 0, chunksTerminal: false, expected: 0, missing: 0 },
    timebase: { ...timebase, clockOffsetMs, callStartMs: helper.frames[0] && startedAt !== null ? helper.frames[0].captureWallMs - startedAt : null },
  };
  const samples = { me: meLags, them: themLags, diagnostic };
  await writeFile(join(folder, 'detail.json'), `${JSON.stringify({ ...result, room: mixed.room, provenance: { near: near.provenance, far: far.provenance },
    nearReference: near.words, farReference: far.words, lines, shown: [...shown], micFrames, callFrames: helper.frames, sights, samples }, null, 2)}\n`, { mode: 0o600 });
  console.log(`${name}: ${failure ?? 'finished'}`);
  return { result, samples };
}

async function main(): Promise<void> {
  const args = parseCallArgs(process.argv.slice(2), PAIRS.length);
  const paths = benchPaths(), layout = callLayout(args.blocks);
  const machine = machineInfo(args.allowDirty);
  const config = await discoverModel();
  if (!config.available || !config.path) throw new Error(config.error ?? 'Model unavailable.');
  const identity = await modelIdentity(config.path);
  const started = new Date();
  // Keep corpus input read-only when measurements belong in a separate job folder.
  const results = process.env.HEARALONG_BENCH_RESULTS_DIR ? resolve(process.env.HEARALONG_BENCH_RESULTS_DIR) : paths.results;
  await mkdir(results, { recursive: true, mode: 0o700 });
  const stamp = fileStamp(started), work = join(results, `call-${stamp}`);
  await mkdir(work, { mode: 0o700 });
  const conditions: CallCondition[] = args.condition === 'both' ? ['echo', 'control'] : [args.condition];
  // The server logs AEC fallback once per recording through console.warn; count those lines, and still print them.
  const notices: string[] = [];
  const warn = console.warn;
  console.warn = (...items: unknown[]) => { const text = items.map(String).join(' '); if (text.includes(AEC_NOTICE)) notices.push(text); warn(...items); };
  const pool = (): Samples => ({ me: { preview: [], final: [] }, them: { preview: [], final: [] } });
  const runs = new Map(conditions.map(condition => [condition, { pairs: [] as CallPairResult[], pooled: pool(), pooledDiagnostic: pool() }]));
  try {
    for (const index of args.pairs) {
      const pair = PAIRS[index - 1];
      const audio = { near: await speakerAudio(pair.near, nearBlocks(layout), layout, paths.root), far: await speakerAudio(pair.far, farBlocks(layout), layout, paths.root) };
      // Alternate which condition goes first, so warm-up and order effects do not fall on one side.
      for (const condition of index % 2 ? conditions : [...conditions].reverse()) {
        const { result, samples } = await runPair(index, pair, condition, audio, layout, config.path, work, notices);
        const run = runs.get(condition)!;
        run.pairs.push(result);
        if (!result.error) for (const role of ['me', 'them'] as const) for (const kind of ['preview', 'final'] as const) {
          run.pooled[role][kind].push(...samples[role][kind]); run.pooledDiagnostic[role][kind].push(...samples.diagnostic[role][kind]);
        }
      }
    }
  } finally { console.warn = warn; }
  const errors: string[] = [];
  for (const [condition, run] of runs) {
    const pairs = run.pairs.sort((a, b) => a.name.localeCompare(b.name)), finished = pairs.filter(pair => !pair.error);
    const error = pairs.some(pair => pair.error) ? pairs.filter(pair => pair.error).map(pair => `${pair.name}: ${pair.error}`).join(' ') : null;
    const sum = (pick: (pair: CallPairResult) => number) => finished.reduce((n, pair) => n + pick(pair), 0);
    const result: CallFile = {
      ...machine, normalizer: NORMALIZER, scoringCommit: machine.commit, scoringDirty: machine.dirty, kind: 'call', createdAt: started.toISOString(),
      runLabel: args.label, model: identity.basename, modelIdentity: identity, error,
      failedChunks: pairs.reduce((n, pair) => n + pair.failedChunks, 0), unfinishedChunks: pairs.reduce((n, pair) => n + pair.unfinishedChunks, 0),
      condition: { mode: condition, batch: stamp, pairs: args.pairs.map(index => `${index}:${pairName(PAIRS[index - 1])}`), blocks: layout.blocks, smoke: args.smoke, room: ROOM_VERSION },
      pairs,
      totals: {
        pairs: finished.length, score: sumCallScores(finished.map(pair => pair.score)),
        lag: lagOf(run.pooled), diagnostic: lagOf(run.pooledDiagnostic), afterStop: { me: sum(pair => pair.afterStop.me), them: sum(pair => pair.afterStop.them) },
        aec: { micFrames: sum(pair => pair.aec.micFrames), aecFrames: sum(pair => pair.aec.aecFrames), failures: sum(pair => pair.aec.failures), notices: sum(pair => pair.aec.notices.length) },
      },
    };
    const output = resultPath(results, `call-${condition}`, started);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(output);
    if (error) errors.push(`${condition}: ${error}`);
  }
  if (errors.length) throw new Error(errors.join(' '));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
