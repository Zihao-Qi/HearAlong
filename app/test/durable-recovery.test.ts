import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { ActionJobs, captureContext, type ActionJob } from '../src/actions.ts';
import { Explorations } from '../src/explorations.ts';
import { Cooldowns } from '../src/quota.ts';
import type { PiTaskResult } from '../src/pi-task.ts';

function gate() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < end, 'timed out waiting for the terminal record');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const answer: PiTaskResult = { text: 'There are twelve fictional shells.\n<<<META\n{"sources":[],"assumptions":[],"openPoints":[]}\nMETA>>>',
  tools: [], ms: 1, aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [] };

async function actionFixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'action-recovery-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Fictional shell count');
  const chunk = await store.addPcm(meeting.id, 'mic:fiction', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Count the fictional shells.', words: [], backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const selection = { text: 'Count the fictional shells.', segmentIds: [store.segments(meeting.id)[0].id] };
  let calls = 0;
  const makeJobs = () => new ActionJobs({ store, directory, clock: () => 123456, rootsFor: () => [], glossaryFor: async () => null,
    runner: async () => { calls++; return answer; } });
  return { directory, store, meeting, selection, makeJobs, calls: () => calls,
    async close() { store.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('loading queued and running saved actions durably interrupts them without rerunning; reload is idempotent', async () => {
  const f = await actionFixture();
  const jobs = f.makeJobs(), restarted = f.makeJobs();
  try {
    const folder = join(f.directory, 'actions', f.meeting.id);
    await fs.mkdir(folder, { recursive: true });
    for (const state of ['queued', 'running', 'done'] as const) {
      const job: ActionJob = { id: state, meetingId: f.meeting.id, action: 'explain', prompt: null, parentId: null, retryOf: null, state, origin: 'user',
        createdAt: 1, startedAt: state === 'queued' ? null : 2, finishedAt: state === 'done' ? 3 : null, error: null,
        context: captureContext(f.store, f.meeting.id, f.selection, 1, null, []), draft: '', status: [], result: null };
      await fs.writeFile(join(folder, `${state}.json`), JSON.stringify(job));
    }
    await jobs.load();
    assert.equal(jobs.list(f.meeting.id).length, 3);
    for (const id of ['queued', 'running']) {
      const loaded = jobs.get(id)!;
      assert.equal(loaded.state, 'interrupted');
      assert.equal(loaded.finishedAt, 123456);
      assert.match(loaded.error!, /server stopped/);
      assert.deepEqual(JSON.parse(await fs.readFile(join(folder, `${id}.json`), 'utf8')), loaded);
    }
    assert.equal(jobs.get('done')!.state, 'done');
    assert.equal(jobs.get('done')!.finishedAt, 3);
    assert.equal(jobs.busy(f.meeting.id), false);
    await restarted.load();
    assert.deepEqual(restarted.list(f.meeting.id), jobs.list(f.meeting.id));
    assert.equal(f.calls(), 0);
  } finally { await jobs.close(); await restarted.close(); await f.close(); }
});

test('a terminal action save failure is never shown as done and durably falls back to failed with no result', async t => {
  const f = await actionFixture(), jobs = f.makeJobs();
  const reached = gate(), release = gate();
  const writeFile = fs.writeFile;
  let failures = 0;
  const mock = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(join(f.directory, 'actions')) && String(args[0]).includes('.json.')) {
      const record = JSON.parse(String(args[1]));
      if (record.state === 'done') {
        failures++; reached.open(); await release.ready;
        throw new Error('fictional terminal action disk outage');
      }
    }
    return writeFile(...args);
  });
  syncBuiltinESMExports();
  try {
    const { job } = await jobs.submit(f.meeting.id, { action: 'explain', selection: f.selection });
    await reached.ready;
    assert.equal(job.state, 'running', 'a result is invisible while its terminal save is pending');
    assert.equal(job.result, null);
    const path = join(f.directory, 'actions', f.meeting.id, `${job.id}.json`);
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).state, 'running');
    release.open();
    await until(() => job.state === 'failed');
    await jobs.close();
    assert.equal(failures, 1, 'the fault hits the terminal answer, not acceptance or evidence');
    assert.equal(f.calls(), 1);
    assert.equal(job.result, null);
    assert.match(job.error!, /answer could not be saved: fictional terminal action disk outage/);
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), job);
    const restarted = f.makeJobs();
    try { await restarted.load(); assert.equal(restarted.get(job.id)!.state, 'failed'); assert.equal(restarted.get(job.id)!.result, null); }
    finally { await restarted.close(); }
    assert.equal(f.calls(), 1);
  } finally { release.open(); await jobs.close(); mock.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

for (const fallbackFails of [false, true]) test(`terminal exploration persistence failure: fallback ${fallbackFails ? 'also fails, next start interrupts' : 'saves failed, next start preserves it'}`, async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'exploration-terminal-'));
  const reached = gate(), release = gate();
  let calls = 0, failures = 0;
  const ended: string[] = [];
  const makeJobs = () => new Explorations({ directory, clock: () => 987654, cooldowns: new Cooldowns(), onEnd: job => { ended.push(job.state); } });
  const jobs = makeJobs();
  const writeFile = fs.writeFile;
  const mock = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(join(directory, 'explorations')) && String(args[0]).includes('job.json.')) {
      const record = JSON.parse(String(args[1]));
      if (record.state === 'done' || (fallbackFails && record.state === 'failed')) {
        failures++; reached.open(); await release.ready;
        throw new Error('fictional terminal exploration disk outage');
      }
    }
    return writeFile(...args);
  });
  syncBuiltinESMExports();
  try {
    const job = await jobs.submit('fictional-meeting', { kind: 'plan', work: async ({ log }) => {
      calls++; log.appendText('Fictional shell inventory plan.'); return { fictional: 'plan' };
    } });
    await reached.ready;
    assert.equal(job.state, 'running');
    assert.equal(jobs.list('fictional-meeting')[0].state, 'running');
    const path = join(directory, 'explorations', job.meetingId, job.id, 'job.json');
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).state, 'running');
    release.open();
    await until(() => ended.length === 1);
    await jobs.close();
    assert.deepEqual(ended, ['failed']);
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /run could not be saved: fictional terminal exploration disk outage/);
    assert.equal(failures, fallbackFails ? 2 : 1);
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).state, fallbackFails ? 'running' : 'failed');
    mock.mock.restore(); syncBuiltinESMExports();
    const restarted = makeJobs();
    try {
      await restarted.load();
      const recovered = restarted.get(job.id)!;
      assert.equal(recovered.state, fallbackFails ? 'interrupted' : 'failed');
      if (fallbackFails) { assert.equal(recovered.stopped, 'crash'); assert.equal(recovered.result, null); }
      assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), recovered);
      assert.equal((await restarted.stream(job.id)).text, 'Fictional shell inventory plan.');
      await restarted.load();
      assert.deepEqual(restarted.get(job.id), recovered);
      assert.equal(restarted.busy(job.meetingId), false);
      assert.equal(calls, 1, 'recovery never reruns work');
    } finally { await restarted.close(); }
  } finally { release.open(); await jobs.close(); mock.mock.restore(); syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true }); }
});
