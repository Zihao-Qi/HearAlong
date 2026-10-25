import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { JobManager, type Recognizer } from '../src/jobs.ts';
import { LocalRecognizer, type Recognition } from '../src/recognizer.ts';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

const result: Recognition = { text: 'The fictional seed library is ready.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };
class Time {
  now = 100_000;
  timers = new Map<NodeJS.Timeout, { at: number; callback: () => void; unref: boolean }>();
  options = {
    clock: () => this.now,
    setTimeout: (callback: () => void, ms: number) => {
      const entry = { at: this.now + ms, callback, unref: false };
      const timer = { unref: () => { entry.unref = true; } } as NodeJS.Timeout;
      this.timers.set(timer, entry); return timer;
    },
    clearTimeout: (timer: NodeJS.Timeout) => { this.timers.delete(timer); },
  };
  advance(ms: number) {
    this.now += ms;
    for (const [timer, entry] of this.timers) if (entry.at <= this.now) {
      this.timers.delete(timer); entry.callback();
    }
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jobs-retry-'));
  let store = new MeetingStore(directory);
  const meeting = store.createMeeting('Seed library');
  store.addMedia(meeting.id, join(directory, 'fictional.wav'), 20);
  const id = store.chunks(meeting.id)[0].id;
  const time = new Time();
  let manager: JobManager | undefined;
  return {
    directory, meeting, id, time, get store() { return store; },
    manager(recognizer: Recognizer) { return manager = new JobManager(store, recognizer, time.options); },
    async reopen() { await manager?.close(); store.close(); store = new MeetingStore(directory); },
    async close() { await manager?.close(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('one failure waits 15 s, stays queued with its error, then publishes the transcript', async () => {
  const f = await fixture(); let calls = 0;
  const jobs = f.manager({ async transcribe() { if (++calls === 1) throw new Error('temporary'); return result; }, close() {} });
  try {
    jobs.kick(); await jobs.wait();
    assert.equal(f.store.chunk(f.id)?.status, 'queued');
    assert.equal(f.store.chunk(f.id)?.error, 'temporary');
    assert.equal(f.store.chunk(f.id)?.attempts, 1);
    assert.equal(f.store.chunk(f.id)?.retryAt, f.time.now + 15_000);
    assert.equal(f.time.timers.size, 1);
    assert.ok([...f.time.timers.values()].every(t => t.unref));
    f.time.advance(14_999); jobs.kick(); await jobs.wait(); assert.equal(calls, 1);
    assert.equal(f.time.timers.size, 1, 'kicks never multiply wake timers');
    f.time.advance(1); await jobs.wait();
    assert.equal(calls, 2);
    assert.equal(f.store.chunk(f.id)?.status, 'completed');
    assert.equal(f.store.chunk(f.id)?.error, null);
    assert.equal(f.store.chunk(f.id)?.retryAt, null);
    assert.match(f.store.plainText(f.meeting.id), /fictional seed library/);
    assert.equal(f.time.timers.size, 0);
  } finally { await f.close(); }
});

test('three failures stop with the last error; both waits are respected and other chunks run', async () => {
  const f = await fixture(); let calls = 0;
  f.store.addMedia(f.meeting.id, join(f.directory, 'other.wav'), 20);
  const other = f.store.chunks(f.meeting.id)[1].id;
  const order: string[] = [];
  const jobs = f.manager({ async transcribe(c) { order.push(c.id); if (c.id === f.id) throw new Error(`failure ${++calls}`); return result; }, close() {} });
  try {
    jobs.kick(); await jobs.wait();
    assert.deepEqual(order, [f.id, other]);
    assert.equal(f.store.chunk(f.id)?.status, 'queued');
    assert.equal(f.store.chunk(other)?.status, 'completed');
    f.time.advance(15_000); await jobs.wait();
    assert.equal(calls, 2);
    assert.equal(f.store.chunk(f.id)?.retryAt, f.time.now + 60_000);
    f.time.advance(59_999); jobs.kick(); await jobs.wait(); assert.equal(calls, 2);
    f.time.advance(1); await jobs.wait();
    assert.equal(f.store.chunk(f.id)?.status, 'failed');
    assert.equal(f.store.chunk(f.id)?.error, 'failure 3');
    assert.equal(f.store.chunk(f.id)?.attempts, 3);
    f.time.advance(600_000); jobs.kick(); await jobs.wait();
    assert.equal(calls, 3); assert.equal(f.time.timers.size, 0);
  } finally { await f.close(); }
});

test('manual Retry API clears the persisted budget and gives three fresh attempts', async () => {
  const f = await fixture(); let calls = 0;
  const recognizer = { async transcribe() { throw new Error(`failure ${++calls}`); }, close() {} };
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const jobs = f.manager(recognizer); jobs.kick(); await jobs.wait();
    f.time.advance(15_000); await jobs.wait(); f.time.advance(60_000); await jobs.wait();
    assert.equal(calls, 3);
    await jobs.close();
    f.store.db.prepare('UPDATE chunks SET retryAt=? WHERE id=?').run(f.time.now + 600_000, f.id);
    app = await startServer({ directory: f.directory, port: 0, setup: await dashboardSetup(f.directory, true), recognizer,
      drafts: null, quick: null, heavy: null, notes: null, actions: null, board: null, plans: null });
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    // Keep the HTTP boundary real, but drive the new budget with our deterministic manager below.
    await app.jobs.close();
    const response = await fetch(`${app.url}/api/meetings/${f.meeting.id}/retry`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
    assert.equal(response.status, 200);
    assert.equal(f.store.chunk(f.id)?.attempts, 0); assert.equal(f.store.chunk(f.id)?.retryAt, null);
    const fresh = f.manager(recognizer); fresh.kick(); await fresh.wait();
    f.time.advance(15_000); await fresh.wait(); f.time.advance(60_000); await fresh.wait();
    assert.equal(calls, 6); assert.equal(f.store.chunk(f.id)?.status, 'failed');
    assert.equal(f.store.chunk(f.id)?.error, 'failure 6');
  } finally { await app?.close(); await f.close(); }
});

test('restart preserves a future retry and startup kick wakes it when due', async () => {
  const f = await fixture(); let calls = 0;
  const recognizer = { async transcribe() { if (++calls === 1) throw new Error('temporary'); return result; }, close() {} };
  try {
    const first = f.manager(recognizer); first.kick(); await first.wait();
    assert.equal(f.store.chunk(f.id)?.status, 'queued');
    const due = f.store.chunk(f.id)?.retryAt;
    await f.reopen(); assert.equal(f.store.chunk(f.id)?.retryAt, due);
    const restarted = f.manager(recognizer); restarted.kick(); await restarted.wait();
    assert.equal(calls, 1); assert.equal(f.time.timers.size, 1);
    f.time.advance(15_000); await restarted.wait();
    assert.equal(calls, 2); assert.equal(f.store.chunk(f.id)?.status, 'completed');
    assert.equal(f.store.chunk(f.id)?.attempts, 2);
  } finally { await f.close(); }
});

test('an interrupted third attempt cannot become a fourth attempt after restart', async () => {
  const f = await fixture(); let calls = 0;
  let interrupt: (() => void) | undefined;
  const jobs = f.manager({
    async transcribe() {
      if (++calls < 3) throw new Error('temporary');
      return new Promise<Recognition>((_resolve, reject) => { interrupt = () => reject(new Error('stopped')); });
    },
    close() { interrupt?.(); },
  });
  try {
    jobs.kick(); await jobs.wait();
    f.time.advance(15_000); await jobs.wait();
    f.time.advance(60_000);
    assert.equal(calls, 3);
    assert.equal(f.store.chunk(f.id)?.status, 'running');
    await f.reopen();
    const restarted = f.manager({ async transcribe() { calls++; return result; }, close() {} });
    restarted.kick(); await restarted.wait();
    assert.equal(calls, 3);
    assert.equal(f.store.chunk(f.id)?.status, 'failed');
    assert.equal(f.store.chunk(f.id)?.attempts, 3);
    assert.equal(f.time.timers.size, 0);
  } finally { await f.close(); }
});

test('migration adds defaults without requeueing old failed rows, even on later kicks', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.store.setStatus(f.id, 'failed', '', 'old failure');
    const before = f.store.chunk(f.id)!;
    const columns = f.store.db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[];
    for (const name of ['attempts', 'retryAt']) if (columns.some(c => c.name === name)) f.store.db.exec(`ALTER TABLE chunks DROP COLUMN ${name}`);
    await f.reopen();
    assert.equal(f.store.chunk(f.id)?.attempts, 0); assert.equal(f.store.chunk(f.id)?.retryAt, null);
    const { attempts, retryAt, ...after } = f.store.chunk(f.id)!;
    const { attempts: _a, retryAt: _r, ...original } = before;
    assert.deepEqual(after, original);
    const jobs = f.manager({ async transcribe() { calls++; return result; }, close() {} });
    jobs.kick(); await jobs.wait(); f.time.advance(600_000); jobs.kick(); await jobs.wait();
    assert.equal(calls, 0); assert.equal(f.store.chunk(f.id)?.status, 'failed');
    await f.reopen(); assert.equal(f.store.chunk(f.id)?.status, 'failed');
  } finally { await f.close(); }
});

test('close during a wait removes its timer and even a stale callback starts no attempt', async () => {
  const f = await fixture(); let calls = 0;
  const jobs = f.manager({ async transcribe() { calls++; throw new Error('temporary'); }, close() {} });
  try {
    jobs.kick(); await jobs.wait();
    assert.equal(f.time.timers.size, 1);
    const callback = [...f.time.timers.values()][0].callback;
    await jobs.close(); assert.equal(f.time.timers.size, 0);
    f.time.advance(600_000); callback(); jobs.kick(); await jobs.wait();
    assert.equal(calls, 1); assert.equal(f.store.chunk(f.id)?.status, 'queued');
  } finally { await f.close(); }
});

test('a worker that exits once is replaced and the automatic retry succeeds', async () => {
  const f = await fixture();
  const recognizer = new LocalRecognizer(join(f.directory, 'crashed-once'), new URL('./fixtures/exit-once-worker.ts', import.meta.url));
  const jobs = f.manager(recognizer);
  try {
    jobs.kick(); await jobs.wait();
    assert.equal(recognizer.lastExit?.code, 17);
    assert.equal(f.store.chunk(f.id)?.status, 'queued');
    assert.match(f.store.chunk(f.id)?.error ?? '', /STT process exited/);
    f.time.advance(15_000); await jobs.wait();
    assert.equal(f.store.chunk(f.id)?.status, 'completed');
    assert.equal(f.store.chunk(f.id)?.attempts, 2);
    assert.match(f.store.plainText(f.meeting.id), /worker recovered/);
  } finally { await f.close(); }
});
