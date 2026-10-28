import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPiTask } from '../src/pi-task.ts';
import { PiRpc } from '../src/pi-rpc.ts';
import { NotesJobs } from '../src/notes.ts';
import { MeetingStore } from '../src/store.ts';
import { Explorations } from '../src/explorations.ts';
import { Cooldowns } from '../src/quota.ts';
import { until } from './helpers/setup-pi.ts';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'local-lane-')), log = join(directory, 'lane.jsonl'), command = join(directory, 'pi');
  await copyFile(new URL('./fixtures/local-lane-pi.mjs', import.meta.url), command); await chmod(command, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = async (): Promise<{ event: string; pid: number }[]> => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const peak = async () => { let active = 0, max = 0; for (const e of await events()) { active += e.event === 'start' ? 1 : -1; max = Math.max(max, active); } return max; };
  return { directory, events, peak, options: { model: 'ollama/fictional:4b', command, cwd: directory, env: { ...process.env, LANE_LOG: log, LANE_DELAY: '180' }, tools: null, timeoutMs: 2000 } };
}

for (const local of [true, false]) test(`single lane: ${local ? 'local notes parts and RPC serialize' : 'cloud notes parts stay parallel'}`, async t => {
  const f = await fixture(t), store = new MeetingStore(f.directory);
  const meeting = store.createMeeting('Fictional lantern workshop');
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Keep the painted lanterns on the rack.', words: [], backend: 'fake', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const options = { ...f.options, model: local ? f.options.model : 'example/cloud' };
  const jobs = new NotesJobs({ store, directory: f.directory, clock: Date.now, glossaryFor: async () => null,
    runner: input => runPiTask(input.instructions, { ...options, signal: input.signal, onEvent: input.onEvent }) });
  const rpc = new PiRpc(options);
  try {
    await jobs.start(meeting.id);
    await until(async () => (await f.events()).length > 0);
    const progress = (await jobs.status(meeting.id)).job?.progress;
    assert.ok(progress); assert.equal(Object.keys(progress.parts).length, 3);
    const answer = rpc.ask('Fictional Board scan after Stop');
    if (local) {
      await until(async () => Boolean((await jobs.status(meeting.id)).job?.progress?.parts.project.done));
      const midway = (await jobs.status(meeting.id)).job?.progress;
      assert.ok(midway); assert.equal(midway.parts.project.count, 1);
      assert.equal(midway.parts.tasks.done, false); assert.equal(midway.parts.other.done, false);
      assert.equal(midway.latest, 'Keep the lanterns on the rack.');
    }
    await answer;
    await until(() => !jobs.busy(meeting.id));
    await rpc.close();
    assert.equal((await jobs.status(meeting.id)).job, null);
    if (local) assert.equal(await f.peak(), 1, 'Only one local Pi process across notes and RPC');
    else assert.ok(await f.peak() >= 3, 'Cloud parts remain parallel');
  } finally { await jobs.close(); await rpc.close(); store.close(); }
});

test('single lane: exploration whole-job timer starts after local admission', async t => {
  const f = await fixture(t);
  const first = runPiTask('First local task', { ...f.options, env: { ...f.options.env, LANE_DELAY: '700' } });
  await until(async () => (await f.events()).length === 1);
  const jobs = new Explorations({ directory: f.directory, clock: Date.now, cooldowns: new Cooldowns(), local: () => true });
  try {
    const job = await jobs.submit('fictional', { kind: 'plan', limitMs: 400, runLimitMs: 400,
      work: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return 'finished'; } });
    await first;
    await until(() => !jobs.busy('fictional'));
    assert.equal(job.state, 'done'); assert.equal(job.result, 'finished');
    assert.ok(job.startedAt! >= job.createdAt + 400, 'Queued time is not execution time');
  } finally { await jobs.close(); }
});

test('single lane: a local plan’s concurrent child writers serialize without deadlocking its job lane', async t => {
  const f = await fixture(t);
  const jobs = new Explorations({ directory: f.directory, clock: Date.now, cooldowns: new Cooldowns(), local: () => true });
  try {
    const job = await jobs.submit('fictional', { kind: 'plan', limitMs: 4000, runLimitMs: 5000,
      work: ctx => Promise.all([ctx.pi('First fictional writer', f.options), ctx.pi('Second fictional writer', f.options)]) });
    await until(() => !jobs.busy('fictional'));
    assert.equal(job.state, 'done', job.error ?? ''); assert.equal(await f.peak(), 1);
  } finally { await jobs.close(); }
});

test('single lane: waiting does not consume task or RPC execution time, and queued cancellation never spawns', async t => {
  const f = await fixture(t);
  const first = runPiTask('First local task', { ...f.options, env: { ...f.options.env, LANE_DELAY: '700' } });
  await until(async () => (await f.events()).length === 1);
  const next = runPiTask('Waiting local task', { ...f.options, timeoutMs: 500 });
  const rpc = new PiRpc({ ...f.options, timeoutMs: 500 });
  const reply = rpc.ask('Waiting local correction');
  const controller = new AbortController();
  const cancelled = runPiTask('Cancelled in queue', { ...f.options, signal: controller.signal }).then(() => null, error => error);
  controller.abort();
  try {
    await first; assert.equal((await next).stopReason, 'stop'); assert.equal((await reply).stopReason, 'stop');
    assert.match((await cancelled).message, /cancelled/);
    await rpc.close();
    assert.equal((await f.events()).filter(e => e.event === 'start').length, 3);
    assert.equal(await f.peak(), 1);
  } finally { await rpc.close(); }
});
