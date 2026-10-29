import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordingEnds } from '../public/recording-end.js';
import { MeetingStore } from '../src/store.ts';
import { LiveCapture } from '../src/live.ts';
import { AudioRetention } from '../src/audio-retention.ts';
import { until } from './helpers/until.ts';

function time() {
  const timers = new Map<NodeJS.Timeout, () => void>(), waits: number[] = [];
  return { timers, waits, options: {
    setTimer(callback: () => void, ms: number) { const timer = {} as NodeJS.Timeout; timers.set(timer, callback); waits.push(ms); return timer; },
    clearTimer(timer: NodeJS.Timeout | undefined) { if (timer) timers.delete(timer); },
  }, async tick() { const [timer, callback] = [...timers][0]; timers.delete(timer); callback(); await new Promise<void>(resolve => setImmediate(resolve)); } };
}

test('a lost end request is retried after capture ends, unblocking deletion and retention without discarding saved audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-end-'));
  const store = new MeetingStore(directory), capture = new LiveCapture(store), meeting = store.createMeeting();
  const source = 'mic:fictional', clock = time(); let calls = 0;
  const retention = new AudioRetention(store, { setting: () => 'day', active: () => false });
  try {
    await capture.accept(meeting.id, source, 0, 0, Buffer.alloc(64000), 'fictional-page');
    const queue = createRecordingEnds(async (_path, value) => {
      if (++calls === 1) throw new Error('Fictional connection lost');
      return capture.end(meeting.id, value.source, value.lastSequence);
    }, clock.options);
    const value = { source, lastSequence: 0, stopping: true };
    const first = queue.end('/api/meetings/fictional/pcm/end', value);
    await assert.rejects(first, /connection lost/);
    assert.equal(queue.end('/api/meetings/fictional/pcm/end', value), first, 'one owner for a duplicate end');
    assert.equal(store.recordingUnended(meeting.id), true);
    await clock.tick();
    await until(() => !store.recordingUnended(meeting.id));
    assert.equal(calls, 2); assert.equal(clock.timers.size, 0);
    assert.equal(store.recordingUnended(meeting.id), false);
    const chunks = store.chunks(meeting.id);
    assert.equal(chunks.length, 1); assert.equal(chunks[0].seconds, 1);
    store.completeChunk(chunks[0].id, { text: 'Fictional complete recording.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' });
    retention.observe(); assert.notEqual(store.meeting(meeting.id).audioDoneAt, null);
    assert.doesNotThrow(() => store.inspectMeetingDeletion(meeting.id));
  } finally { retention.close(); await capture.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('end retries are serialized with capped backoff, stop on acknowledgement, and do not retain the capture session', async () => {
  const clock = time(); let calls = 0;
  const payloads: unknown[] = [];
  const queue = createRecordingEnds(async (_path, value) => {
    payloads.push(value);
    if (++calls < 9) throw Object.assign(new Error('Fictional server unavailable'), { status: 503 });
    return { sealed: 0 };
  }, clock.options);
  const value = { source: 'mic:fictional', lastSequence: 2, stopping: true };
  await assert.rejects(queue.end('/api/meetings/fictional/pcm/end', value));
  value.lastSequence = 99;
  for (let i = 0; i < 8; i++) { assert.equal(clock.timers.size, 1); await clock.tick(); }
  assert.deepEqual(clock.waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(clock.timers.size, 0); assert.equal(calls, 9);
  assert.ok(payloads.every(p => (p as typeof value).lastSequence === 2), 'the end payload is an immutable snapshot');
});

test('a deleted meeting drops its pending end instead of retrying forever', async () => {
  const clock = time();
  const queue = createRecordingEnds(async () => { throw Object.assign(new Error('gone'), { status: 404 }); }, clock.options);
  await assert.rejects(queue.end('/api/meetings/fictional/pcm/end', { source: 'mic:fictional', lastSequence: null, stopping: true }));
  assert.equal(clock.timers.size, 0);
});
