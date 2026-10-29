// Offline regression fixtures only: no recognizer subprocess, server, corpus, or model discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as machine from '../scripts/bench/machine.ts';
import * as results from '../scripts/bench/results.ts';
import { parseWerArgs, parseLiveArgs } from '../scripts/bench/cli.ts';
import { renderBench } from '../scripts/bench/report.ts';
import { JobManager } from '../src/jobs.ts';
import { MeetingStore } from '../src/store.ts';
import type { Recognition } from '../src/recognizer.ts';
import type { LiveFile, WerFile } from '../scripts/bench/results.ts';

const doc = '<!-- bench:begin -->\nold\n<!-- bench:end -->';
const point = (value: number, n = 4) => ({ mean: value, p50: value, p95: value, max: value, n });
const identity = { basename: 'fiction.gguf', sha256: 'a'.repeat(64), bytes: 3 };
const base = {
  commit: 'fictional-commit', dirty: false, nodeVersion: 'v22.0.0', logicalCores: 8,
  macos: '99.0', chip: 'Fictional Chip', ramBytes: 16 * 2 ** 30,
  model: identity.basename, modelIdentity: identity, createdAt: '2026-01-01T00:00:00Z', runLabel: null, error: null,
};
function werRun(rate = 0.1): WerFile {
  const scores = { substitutions: rate * 10, deletions: 0, insertions: 0, hits: 10 - rate * 10, referenceWords: 10, wer: rate };
  return { ...base, kind: 'wer', condition: { sessions: ['FictionA'], mics: ['Mix-Headset'] },
    sessions: [{ ...scores, meetingId: 'FictionA', mic: 'Mix-Headset', audioSeconds: 60, wallSeconds: 10, failedChunks: 0, unfinishedChunks: 0 }],
    totals: { ...scores, audioSeconds: 60, wallSeconds: 10 } };
}
function liveRun(): LiveFile {
  return { ...base, kind: 'live', meetingId: 'FictionA', mic: 'Mix-Headset', fromSec: 0, minutes: 1,
    audioSeconds: 60, warning: null, clockOffsetMs: null, failedChunks: 0, unfinishedChunks: 0,
    preview: point(2000), final: point(3000), diagnostic: { preview: point(500), final: point(1000) },
    wer: werRun().totals, resources: { server: { cpu: point(20), rssBytes: point(2 ** 20) }, speechWorker: { cpu: point(40), rssBytes: point(2 ** 21) } } };
}

test('cohorts isolate each identity and condition, count runs, and sort newest first', () => {
  const original = werRun();
  const changes: Partial<WerFile>[] = [
    { modelIdentity: { ...identity, basename: 'other.gguf' } },
    { modelIdentity: { ...identity, sha256: 'b'.repeat(64) } },
    { chip: 'Other Chip' }, { ramBytes: 32 * 2 ** 30 }, { logicalCores: 10 }, { commit: 'other-commit' }, { dirty: true },
    { condition: { sessions: ['FictionB'], mics: ['Mix-Headset'] } },
    { condition: { sessions: ['FictionA'], mics: ['Array1-01'] } },
  ];
  for (const change of changes) {
    const rendered = renderBench(doc, [original, { ...werRun(0.9), ...change, createdAt: '2026-02-01T00:00:00Z' }]);
    assert.equal((rendered.match(/^### Cohort/gm) ?? []).length, 2, JSON.stringify(change));
    assert.doesNotMatch(rendered, /50\.00%/);
    assert.ok(rendered.indexOf('2026-02-01') < rendered.indexOf('2026-01-01'));
    assert.match(rendered, /1 run; 1 finished/);
  }
  for (const change of [{ meetingId: 'FictionB' }, { mic: 'Array1-01' }, { fromSec: 10 }, { minutes: 2 }]) {
    assert.equal((renderBench(doc, [liveRun(), { ...liveRun(), ...change }]).match(/^### Cohort/gm) ?? []).length, 2);
  }
  const reordered = { ...original, condition: { sessions: ['FictionB', 'FictionA'], mics: ['Array1-01', 'Mix-Headset'] } };
  assert.match(renderBench(doc, [reordered, { ...reordered, condition: { sessions: ['FictionA', 'FictionB'], mics: ['Mix-Headset', 'Array1-01'] } }]), /2 runs; 2 finished/);
});

test('errored runs never enter headline or session medians; chunk counts remain visible', () => {
  const broken = { ...werRun(0.9), error: 'stopped', sessions: [{ ...werRun(0.9).sessions[0], failedChunks: 2, unfinishedChunks: 1 }] };
  const rendered = renderBench(doc, [werRun(), werRun(0.3), broken]);
  assert.match(rendered, /Median custom-normalized WER across 2 eligible runs: 20\.00%/);
  assert.match(rendered, /\| FictionA \| Mix-Headset \| 10\.00% \| 30\.00% \| 90\.00% \| 20\.00% \| 2 \|/);
  assert.match(rendered, /Failed chunks/);
  assert.match(rendered, /Unfinished chunks/);
  const emptyReference = werRun(); emptyReference.totals.referenceWords = 0; emptyReference.sessions[0].referenceWords = 0;
  assert.match(renderBench(doc, [emptyReference]), /Median custom-normalized WER across 0 eligible runs: n\/a/);
});

test('legacy results get one inspection-only block, without cross-run medians', () => {
  const legacy = JSON.parse(JSON.stringify(werRun())) as Record<string, unknown>;
  for (const field of ['modelIdentity', 'logicalCores', 'dirty', 'nodeVersion', 'condition']) delete legacy[field];
  const parsed = results.parseResult(legacy);
  const rendered = renderBench(doc, [parsed, { ...parsed, createdAt: '2026-02-01T00:00:00Z' }]);
  assert.equal((rendered.match(/^### Legacy/gm) ?? []).length, 1);
  assert.doesNotMatch(rendered, /Median/);
  const live = JSON.parse(JSON.stringify(liveRun())) as Record<string, unknown>;
  delete live.modelIdentity;
  assert.equal((renderBench(doc, [parsed, results.parseResult(live)]).match(/^### Legacy/gm) ?? []).length, 1);
});

test('each lag and resource metric uses n > 0 and reports its own eligible count', () => {
  const missing = liveRun();
  missing.preview = point(0, 0);
  missing.diagnostic.preview = point(0, 0);
  missing.diagnostic.final = point(0, 0);
  missing.resources.server.cpu = point(0, 0);
  missing.resources.server.rssBytes = point(0, 0);
  missing.resources.speechWorker.cpu = point(0, 0);
  missing.resources.speechWorker.rssBytes = point(0, 0);
  const broken = liveRun(); broken.error = 'stopped';
  broken.preview = point(999999); broken.final = point(999999);
  broken.diagnostic = { preview: point(999999), final: point(999999) };
  broken.resources = { server: { cpu: point(999999), rssBytes: point(999999) }, speechWorker: { cpu: point(999999), rssBytes: point(999999) } };
  const rendered = renderBench(doc, [liveRun(), missing, broken]);
  assert.match(rendered, /Median preview p50 across 1 eligible run: 2\.00 s/);
  assert.match(rendered, /Median final p50 across 2 eligible runs: 3\.00 s/);
  assert.match(rendered, /Median diagnostic preview p50 across 1 eligible run: 0\.50 s/);
  assert.match(rendered, /Median diagnostic final p50 across 1 eligible run: 1\.00 s/);
  assert.match(rendered, /Median server CPU mean across 1 eligible run: 20\.0%/);
  assert.match(rendered, /Median server RSS mean across 1 eligible run: 1\.0 MiB/);
  assert.match(rendered, /Median worker CPU mean across 1 eligible run: 40\.0%/);
  assert.match(rendered, /Median worker RSS mean across 1 eligible run: 2\.0 MiB/);
  const unavailable = liveRun(); unavailable.preview = point(0, 0);
  assert.match(renderBench(doc, [unavailable]), /Median preview p50 across 0 eligible runs: n\/a/);
  const measuredZero = liveRun(); measuredZero.preview = point(0);
  assert.match(renderBench(doc, [measuredZero]), /Median preview p50 across 1 eligible run: 0\.00 s/);
});

test('no final samples means an error, including when parsed from JSON', () => {
  const run = liveRun(); run.final = point(0, 0);
  const parsed = results.parseResult(run);
  assert.match(parsed.error ?? '', /no final samples/i);
  assert.match(renderBench(doc, [run]), /0 finished/);
  assert.match(renderBench(doc, [run]), /Median final p50 across 0 eligible runs: n\/a/);
  assert.match(renderBench(doc, [run]), /Median server CPU mean across 0 eligible runs: n\/a/);
});

test('provenance hashes fictional model bytes and refuses dirty source unless allowed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-identity-'));
  try {
    const path = join(directory, 'fiction.gguf'); writeFileSync(path, 'abc');
    assert.deepEqual(await machine.modelIdentity(path), { basename: 'fiction.gguf', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    const run = (_command: string, args: string[]) => args[0] === 'rev-parse' ? 'fictional-head\n' : ' M fictional.ts\n';
    assert.throws(() => machine.sourceInfo(false, run), /--allow-dirty/);
    assert.deepEqual(machine.sourceInfo(true, run), { commit: 'fictional-head', dirty: true, nodeVersion: process.version });
    assert.deepEqual(machine.sourceInfo(false, (_command, args) => args[0] === 'rev-parse' ? 'clean-head\n' : ''), { commit: 'clean-head', dirty: false, nodeVersion: process.version });
    assert.equal(parseWerArgs(['--allow-dirty']).allowDirty, true);
    assert.equal(parseWerArgs([]).allowDirty, false);
    assert.equal(parseLiveArgs(['--session', 'ES2004a', '--allow-dirty']).allowDirty, true);
    assert.deepEqual(results.parseResult(werRun()).modelIdentity, identity);
    assert.equal(results.parseResult(werRun()).nodeVersion, 'v22.0.0');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const recognition: Recognition = { text: 'fiction', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };
async function queueFixture(run: (jobs: JobManager, store: MeetingStore, id: string, time: { now: number; advance(ms: number): void }) => Promise<void>, fail: boolean | 'always' | 'hung' | 'unavailable' = true) {
  const directory = mkdtempSync(join(tmpdir(), 'bench-terminal-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Fiction'); store.addMedia(meeting.id, join(directory, 'fiction.wav'), 1);
  let calls = 0;
  const timers = new Map<NodeJS.Timeout, { at: number; callback: () => void }>();
  const time = { now: 100_000, advance(ms: number) { this.now += ms; for (const [id, timer] of [...timers]) if (timer.at <= this.now) { timers.delete(id); timer.callback(); } } };
  let release: ((result: Recognition) => void) | undefined;
  const jobs = new JobManager(store, {
    available: () => fail !== 'unavailable',
    async transcribe() {
      if (fail === 'hung') return new Promise<Recognition>(resolve => { release = resolve; });
      if ((++calls === 1 && fail) || fail === 'always') throw new Error('retry');
      return recognition;
    },
    close() { release?.(recognition); },
  }, {
    clock: () => time.now,
    setTimeout(callback, ms) { const id = { unref() {} } as NodeJS.Timeout; timers.set(id, { at: time.now + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  try { await run(jobs, store, meeting.id, time); }
  finally { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('terminal wait includes scheduled retries, without changing wait()', async () => {
  await queueFixture(async (jobs, store, id, time) => {
    jobs.kick(); await jobs.wait(); assert.equal(store.chunks(id)[0].status, 'queued');
    let settled = false;
    const pending = jobs.waitUntilTerminal(time.now + 20_000).then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    time.advance(15_000); await jobs.wait(); time.advance(100); await pending;
    assert.equal(store.chunks(id)[0].status, 'completed');
  });
});

test('terminal wait has a deadline and rejects closed queues; cancelled chunks are terminal', async () => {
  await queueFixture(async (jobs, store, id, time) => {
    jobs.kick(); await jobs.wait();
    const pending = jobs.waitUntilTerminal(time.now + 1000);
    const rejected = assert.rejects(pending, /deadline/i); time.advance(1000); await rejected;
    const closing = jobs.waitUntilTerminal(time.now + 1000);
    const closed = assert.rejects(closing, /closed|stopped/i); await jobs.close(); time.advance(100); await closed;
    assert.equal(store.chunks(id)[0].status, 'queued');
  });
  await queueFixture(async (jobs, store, id, time) => {
    store.setStatus(store.chunks(id)[0].id, 'cancelled');
    await jobs.waitUntilTerminal(time.now + 1000);
  }, false);
});

test('terminal wait allows exhausted failures but bounds hung and unavailable recognizers', async () => {
  await queueFixture(async (jobs, store, id, time) => {
    jobs.kick(); await jobs.wait();
    const pending = jobs.waitUntilTerminal(time.now + 90_000);
    time.advance(15_000); await jobs.wait();
    assert.equal(store.chunks(id)[0].status, 'queued');
    time.advance(60_000); await jobs.wait(); time.advance(100); await pending;
    assert.equal(store.chunks(id)[0].status, 'failed');
    assert.equal(store.chunks(id)[0].attempts, 3);
  }, 'always');
  for (const mode of ['hung', 'unavailable'] as const) await queueFixture(async (jobs, store, id, time) => {
    const rejected = assert.rejects(jobs.waitUntilTerminal(time.now + 1000), /deadline/i);
    time.advance(1000); await rejected;
    assert.equal(store.chunks(id)[0].status, mode === 'hung' ? 'running' : 'queued');
    await assert.rejects(jobs.waitUntilTerminal(Infinity), /finite/);
  }, mode);
});

test('failed and unfinished chunks produce run errors', () => {
  assert.equal(results.chunkCompletionError(0, 0), null);
  assert.match(results.chunkCompletionError(2, 1) ?? '', /2 failed.*1 unfinished/);
  const run = werRun(); run.sessions[0].failedChunks = 1;
  assert.match(results.parseResult(run).error ?? '', /1 failed/);
  const live = liveRun(); live.unfinishedChunks = 1;
  assert.match(results.parseResult(live).error ?? '', /1 unfinished/);
});
