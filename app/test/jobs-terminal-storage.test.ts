import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager, type Recognizer } from '../src/jobs.ts';
import { MeetingStore } from '../src/store.ts';
import type { Recognition } from '../src/recognizer.ts';

const result: Recognition = { text: 'Fictional recovery.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };
function fixture(recognizer: Recognizer) {
  const directory = mkdtempSync(join(tmpdir(), 'jobs-terminal-storage-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fiction');
  store.addMedia(meeting.id, join(directory, 'fiction.wav'), 1);
  let now = 100_000;
  const timers = new Map<NodeJS.Timeout, { at: number; callback: () => void }>();
  const jobs = new JobManager(store, recognizer, {
    clock: () => now,
    setTimeout(callback, ms) { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, { at: now + ms, callback }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  return {
    jobs, store, meeting,
    get now() { return now; },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    async close() { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('an empty kick cannot swallow a retry wake-up before its promise handlers run', async () => {
  let calls = 0;
  const f = fixture({ async transcribe() { if (++calls === 1) throw new Error('retry'); return result; }, close() {} });
  try {
    f.jobs.kick(); await f.jobs.wait();
    f.jobs.kick(); // No chunk is due; do not flush microtasks before the retry fires.
    f.advance(15_000); await f.jobs.wait();
    assert.equal(calls, 2);
    assert.equal(f.store.chunks(f.meeting.id)[0].status, 'completed');
  } finally { await f.close(); }
});

for (const stage of ['complete', 'fail'] as const) test(`terminal wait survives a ${stage} write outage without rerunning the held recognition`, async () => {
  let calls = 0;
  const f = fixture({ async transcribe() { if (++calls === 1 && stage === 'fail') throw new Error('retry'); return result; }, close() {} });
  const status = stage === 'complete' ? 'completed' : 'queued';
  f.store.db.exec(`CREATE TRIGGER fictional_write_failure BEFORE UPDATE ON chunks WHEN NEW.status='${status}' BEGIN SELECT RAISE(FAIL, 'Fictional storage unavailable'); END`);
  try {
    f.jobs.kick(); await f.jobs.wait();
    assert.match(f.jobs.storageError ?? '', /storage unavailable/);
    assert.equal(f.store.chunks(f.meeting.id)[0].status, 'running');
    let settled = false;
    const pending = f.jobs.waitUntilTerminal(f.now + 90_000).then(() => { settled = true; });
    f.advance(14_999); await f.jobs.wait();
    assert.equal(settled, false);
    assert.equal(calls, 1, 'terminal polling must respect storage backoff');
    f.store.db.exec('DROP TRIGGER fictional_write_failure');
    f.advance(1); await f.jobs.wait();
    assert.equal(f.jobs.storageError, null);
    assert.equal(calls, 1, 'retry the held write, not recognition');
    if (stage === 'fail') {
      assert.equal(f.store.chunks(f.meeting.id)[0].retryAt, f.now + 15_000);
      f.advance(15_000); await f.jobs.wait();
    }
    f.advance(100); await pending;
    assert.equal(f.store.chunks(f.meeting.id)[0].status, 'completed');
    assert.equal(calls, stage === 'complete' ? 1 : 2);
  } finally { await f.close(); }
});
