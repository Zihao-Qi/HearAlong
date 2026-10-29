import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { JobManager } from '../src/jobs.ts';

const result = { text: 'Fictional storage recovery.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };
for (const stage of ['start', 'complete', 'fail'] as const) test(`queue survives a SQLite ${stage} error and retries without a spin or lost running chunk`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jobs-storage-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting();
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  let now = 100_000, calls = 0;
  const timers = new Map<NodeJS.Timeout, { at: number; callback: () => void }>();
  const jobs = new JobManager(store, { async transcribe() { calls++; if (stage === 'fail') throw new Error('Fictional recognizer failure'); return result; }, close() {} }, {
    clock: () => now,
    setTimeout: (callback, ms) => { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, { at: now + ms, callback }); return timer; },
    clearTimeout: timer => { timers.delete(timer); },
  });
  const status = stage === 'start' ? 'running' : stage === 'complete' ? 'completed' : 'queued';
  store.db.exec(`CREATE TRIGGER fictional_disk_failure BEFORE UPDATE ON chunks WHEN NEW.status='${status}' BEGIN SELECT RAISE(FAIL, 'Fictional storage unavailable'); END`);
  try {
    jobs.kick();
    await assert.doesNotReject(jobs.wait(), 'the queue owns its rejection even when no caller normally waits');
    assert.match((jobs as JobManager & { storageError: string | null }).storageError ?? '', /storage unavailable/);
    assert.equal(store.chunk(chunk.id)?.status, stage === 'start' ? 'queued' : 'running');
    assert.equal(timers.size, 1);
    let first = [...timers.values()][0];
    assert.ok(first.at >= now + 1000 && first.at <= now + 60_000, 'storage retry is delayed and bounded');
    // Audio arrivals must not bypass storage backoff.
    for (let i = 0; i < 10; i++) jobs.kick();
    assert.equal(timers.size, 1);
    assert.equal(calls, stage === 'start' ? 0 : 1);
    for (const delay of [30_000, 60_000, 60_000]) {
      now = first.at; timers.clear(); first.callback(); await jobs.wait();
      assert.equal(timers.size, 1);
      first = [...timers.values()][0];
      assert.equal(first.at - now, delay, 'repeated storage errors back off to a one-minute cap');
      assert.equal(calls, stage === 'start' ? 0 : 1, 'a storage outage does not consume recognition attempts');
    }
    store.db.exec('DROP TRIGGER fictional_disk_failure');
    now = first.at; timers.clear(); first.callback(); await jobs.wait();
    assert.equal((jobs as JobManager & { storageError: string | null }).storageError, null);
    assert.equal(store.chunk(chunk.id)?.status, stage === 'fail' ? 'queued' : 'completed');
    assert.equal(calls, 1, 'retrying a result/status write does not rerun recognition');
    await jobs.close();
    assert.equal(timers.size, 0, 'shutdown cancels retry timers');
  } finally { await jobs.close().catch(() => {}); store.close(); await rm(directory, { recursive: true, force: true }); }
});
