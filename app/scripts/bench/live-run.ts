// One real-time excerpt through the rehearsal page, then spoken-to-visible lag, live WER, and process samples.
// The headline clock starts when the audio was spoken and stops when the transcript DOM shows the text.
// LagMeter stays as a diagnostic: HTTP 201 until the segments snapshot. Usage:
// npm run bench:live -- --session ES2004a [--mic Mix-Headset] [--from M:SS] [--minutes 10] [--run-label text]
// Requires MEETING_TEST_CHROME (a disposable Chromium). The server binds an ephemeral port, never 4318.
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { runRehearsal } from '../rehearse.ts';
import { discoverModel } from '../../src/config.ts';
import { LagMeter } from '../lag-meter.ts';
import { benchPaths, reference, referenceText } from './ami.ts';
import { parseLiveArgs } from './cli.ts';
import { machineInfo, modelIdentity } from './machine.ts';
import { readPs, serverUsage, speechWorkerUsage } from './ps.ts';
import { chunkCompletionError, resultPath, type CountSummary, type LiveFile } from './results.ts';
import { applySnapshot, domSight, frameEndMs, headlineLagWarning, mergeSights, rememberSegmentEnds, spokenFrame, visibleLags, type DomSight, type SpokenFrame } from './snapshot.ts';
import { summarize } from './stats.ts';
import { NORMALIZER, wer } from './wer.ts';

type ResourceSample = { at: number; serverCpu: number; serverRss: number; workerCpu: number; workerRss: number };

// Installed before navigation. Stamps use the page clock, the same Date.now() as X-Capture-Wall-Ms.
// Grey draft: #transcript .para[data-kind="active"] .preview-text (data-key, data-end).
// Final segment: .para[data-kind="final"] span[data-id]. segmentNode sets data-id and no end, so endMs stays null unless the span has data-end.
const DOM_WATCH = `(() => {
  const previewEnd = new Map();
  const finals = new Set();
  const sights = [];
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
      push({ kind: 'preview', key, endMs, at });
    }
    for (const span of root.querySelectorAll('.para[data-kind="final"] span[data-id]')) {
      const key = span.getAttribute('data-id') || '';
      if (!key || finals.has(key)) continue;
      const raw = span.getAttribute('data-end');
      const endMs = raw === null ? null : Number(raw);
      if (endMs !== null && !Number.isFinite(endMs)) continue;
      finals.add(key);
      push({ kind: 'final', key, endMs, at });
    }
  };
  const arm = () => {
    if (!document.documentElement || window.__benchWatching) return;
    window.__benchWatching = true;
    window.__benchSights = sights;
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-end', 'data-kind', 'data-key', 'data-ids', 'data-id'],
    });
    scan();
  };
  if (document.documentElement) arm();
  else document.addEventListener('DOMContentLoaded', arm);
})();`;

function counts(values: number[]): CountSummary {
  if (!values.length) return { mean: 0, p50: 0, p95: 0, max: 0, n: 0 };
  return summarize(values);
}

function sampleResources(serverPid: number): ResourceSample | null {
  const rows = readPs();
  const server = serverUsage(rows, serverPid);
  if (!server) return null;
  const worker = speechWorkerUsage(rows, serverPid);
  return { at: Date.now(), serverCpu: server.cpu, serverRss: server.rssBytes, workerCpu: worker.cpu, workerRss: worker.rssBytes };
}

function finalText(directory: string, meetingId: string): string {
  const db = new DatabaseSync(join(directory, 'meetings.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT text FROM segments WHERE meetingId = ? ORDER BY startMs, ord').all(meetingId) as { text: string }[];
    return rows.map(row => row.text.trim()).filter(Boolean).join(' ');
  } finally { db.close(); }
}

async function copySights(page: Page): Promise<DomSight[]> {
  if (page.isClosed()) return [];
  try {
    const list = await page.evaluate(() => Reflect.get(globalThis, '__benchSights') ?? null);
    if (!Array.isArray(list)) return [];
    return list.flatMap(item => { const sight = domSight(item); return sight ? [sight] : []; });
  } catch { return []; }
}

/** Headline lag is spoken to visible. Diagnostic lag is LagMeter. Resource samples are every 1 s. */
async function main(): Promise<void> {
  const args = parseLiveArgs(process.argv.slice(2));
  const paths = benchPaths();
  const wav = paths.wav(args.session, args.mic);
  if (!existsSync(wav)) throw new Error(`Missing audio: ${wav}. Run npm run bench:fetch first.`);
  const machine = machineInfo(args.allowDirty);
  const config = await discoverModel();
  if (!config.available || !config.path) throw new Error(config.error ?? 'Model unavailable.');
  const identity = await modelIdentity(config.path);
  const started = new Date();
  const meter = new LagMeter();
  const serverPreview: number[] = [];
  const serverFinal: number[] = [];
  const resources: ResourceSample[] = [];
  const spokenFrames: SpokenFrame[] = [];
  const segmentEnds = new Map<string, number>();
  const exposed: DomSight[] = [];
  let polled: DomSight[] = [];
  let pcmUploads = 0;
  let clockOffsetMs: number | null = null;
  const fallback = { source: undefined as string | undefined };
  let idle = Promise.resolve();
  let sightsIdle = Promise.resolve();
  let stop = () => {};
  let directory: string | undefined;
  let failure: string | null = null;
  const attach = async (page: Page) => {
    page.on('response', response => {
      const request = response.request();
      if (request.method() !== 'POST' || response.status() !== 201) return;
      let pathname = '';
      try { pathname = new URL(response.url()).pathname; } catch { return; }
      if (!pathname.endsWith('/pcm')) return;
      pcmUploads++;
      const headers = request.headers();
      const bytes = request.postDataBuffer()?.length ?? Number(headers['content-length'] ?? 0);
      const frame = frameEndMs(headers, bytes);
      if (frame) {
        if (frame.source.startsWith('mic:')) fallback.source = frame.source;
        meter.audio(frame.source, frame.endMs, Date.now());
      }
      const spoken = spokenFrame(headers, bytes);
      if (spoken) spokenFrames.push(spoken);
    });
    await page.exposeFunction('__benchDomSample', (value: unknown) => {
      const sight = domSight(value);
      if (sight) exposed.push(sight);
    });
    await page.addInitScript(DOM_WATCH);
  };
  try {
    directory = await runRehearsal([wav, '--from', args.from, '--minutes', String(args.minutes), '--headless'], async page => {
      try {
        const before = Date.now();
        const pageNow = await page.evaluate(() => Date.now());
        const after = Date.now();
        if (typeof pageNow === 'number' && Number.isFinite(pageNow)) clockOffsetMs = pageNow - (before + after) / 2;
      } catch { /* the page can close before the sample */ }
      let polling = false;
      const tick = () => {
        if (polling) return;
        polling = true;
        idle = idle.then(async () => {
          if (page.isClosed()) return;
          const body = await page.evaluate(async () => {
            const statusResponse = await fetch('/api/status');
            if (!statusResponse.ok) return null;
            const status = await statusResponse.json() as { meetings?: { id: string; title: string }[] };
            const meeting = status.meetings?.find(item => item.title.startsWith('Rehearsal:')) ?? status.meetings?.[0];
            if (!meeting) return { segments: null as unknown };
            const segmentsResponse = await fetch(`/api/meetings/${meeting.id}/segments`);
            return { meetingId: meeting.id, segments: segmentsResponse.ok ? await segmentsResponse.json() : null };
          });
          if (!body) return;
          if (!body.segments) return;
          rememberSegmentEnds(body.segments, segmentEnds);
          const sample = applySnapshot(meter, body.segments, Date.now(), fallback.source);
          serverPreview.push(...sample.preview);
          serverFinal.push(...sample.final);
        }).catch(() => { /* the page closes while the last finals settle */ }).finally(() => { polling = false; });
      };
      let copying = false;
      const takeSights = () => {
        if (copying) return;
        copying = true;
        sightsIdle = sightsIdle.then(async () => {
          const list = await copySights(page);
          if (list.length >= polled.length) polled = list;
        }).finally(() => { copying = false; });
      };
      const ticks = setInterval(tick, 250);
      const sightTicks = setInterval(takeSights, 100);
      const probe = setInterval(() => { const sample = sampleResources(process.pid); if (sample) resources.push(sample); }, 1000);
      stop = () => { clearInterval(ticks); clearInterval(sightTicks); clearInterval(probe); };
      const first = sampleResources(process.pid);
      if (first) resources.push(first);
      tick();
      takeSights();
    }, attach, { modelPath: config.path, terminalTimeoutMs: 30 * 60_000 });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    stop();
  }
  await idle;
  await sightsIdle;
  const micSpoken = spokenFrames.filter(frame => frame.source.startsWith('mic:'));
  const clockFrames = micSpoken.length ? micSpoken : spokenFrames;
  const sights = mergeSights(polled, exposed);
  const headline = visibleLags(clockFrames, sights, segmentEnds);
  let fromSec = args.fromSec;
  let audioSeconds = args.minutes * 60;
  let transcript = '';
  let failedChunks = 0;
  let unfinishedChunks = 0;
  let scored = wer('', '');
  if (directory) {
    try {
      const report = JSON.parse(await readFile(join(directory, 'rehearsal.json'), 'utf8')) as {
        url?: string; from?: number; seconds?: number; meetingId?: string; reason?: string; errors?: string[];
        failedChunks?: number; unfinishedChunks?: number;
      };
      if (report.url && new URL(report.url).port === '4318') failure = 'The live run bound port 4318. It must use an ephemeral port.';
      if (typeof report.from === 'number') fromSec = report.from;
      if (typeof report.seconds === 'number') audioSeconds = report.seconds;
      if (report.reason && report.reason !== 'audio ended') failure ??= `Rehearsal ended: ${report.reason}.`;
      if (report.errors?.length) failure ??= report.errors.join('; ');
      failedChunks = report.failedChunks ?? 0;
      unfinishedChunks = report.unfinishedChunks ?? 0;
      failure ??= chunkCompletionError(failedChunks, unfinishedChunks);
      if (report.meetingId) {
        transcript = finalText(directory, report.meetingId);
        const words = reference(args.session, { fromSec, toSec: fromSec + audioSeconds, root: paths.root });
        scored = wer(referenceText(words), transcript);
      } else failure ??= 'The rehearsal did not record a meeting id.';
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (pcmUploads > 0 && spokenFrames.length === 0) failure ??= 'PCM uploads had no X-Capture-Wall-Ms, so spoken time could not be mapped.';
  if ((serverPreview.length || serverFinal.length) && sights.length === 0) failure ??= 'Server snapshots had text, but the transcript DOM recorded no preview or final line.';
  const preview = counts(headline.preview);
  const final = counts(headline.final);
  if (final.n === 0) failure ??= 'No final samples were observed.';
  const diagnostic = { preview: counts(serverPreview), final: counts(serverFinal) };
  const warning = (['preview', 'final'] as const).flatMap(kind => {
    const text = headlineLagWarning(kind, kind === 'preview' ? preview : final, diagnostic[kind]);
    return text ? [text] : [];
  }).join(' ') || null;
  if (warning) console.warn(warning);
  const result: LiveFile = {
    ...machine, normalizer: NORMALIZER, scoringCommit: machine.commit, scoringDirty: machine.dirty, kind: 'live', createdAt: started.toISOString(), runLabel: args.label, model: identity.basename, modelIdentity: identity, error: failure, warning,
    failedChunks, unfinishedChunks,
    meetingId: args.session, mic: args.mic, fromSec, minutes: args.minutes, audioSeconds, clockOffsetMs,
    preview, final, diagnostic,
    wer: {
      substitutions: scored.substitutions, deletions: scored.deletions, insertions: scored.insertions, hits: scored.hits,
      referenceWords: scored.referenceWords, wer: scored.wer,
    },
    resources: {
      server: { cpu: counts(resources.map(item => item.serverCpu)), rssBytes: counts(resources.map(item => item.serverRss)) },
      speechWorker: { cpu: counts(resources.map(item => item.workerCpu)), rssBytes: counts(resources.map(item => item.workerRss)) },
    },
  };
  await mkdir(paths.results, { recursive: true, mode: 0o700 });
  const output = resultPath(paths.results, 'live', started);
  await writeFile(output, `${JSON.stringify({
    ...result, previewSamples: headline.preview, finalSamples: headline.final,
    diagnosticPreviewSamples: serverPreview, diagnosticFinalSamples: serverFinal,
    spokenFrames: clockFrames, sights, segmentEnds: Object.fromEntries(segmentEnds), resourceSamples: resources, transcript,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(output);
  if (failure) throw new Error(failure);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
