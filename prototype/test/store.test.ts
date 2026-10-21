import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { JobManager } from '../src/jobs.ts';
import type { Recognition } from '../src/recognizer.ts';

const metrics: Recognition = { text: 'The experiment passed.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };

test('meetings need no project; periodic defaults and PCM deduplication persist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-store-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    assert.equal(meeting.mode, 'periodic');
    assert.equal(meeting.intervalSeconds, 60);
    const pcm = Buffer.alloc(16000 * 4);
    const first = await store.addPcm(meeting.id, 'mic:test', 0, 0, 16000, pcm);
    const repeat = await store.addPcm(meeting.id, 'mic:test', 0, 0, 16000, pcm);
    assert.equal(first.id, repeat.id);
    await assert.rejects(store.addPcm(meeting.id, 'mic:test', 0, 0, 16000, Buffer.alloc(16000 * 4, 1)), /different audio chunk/);
    store.updateMode(meeting.id, 'manual', 120);
    store.setStatus(first.id, 'running');
    store.close();
    store = new MeetingStore(directory);
    assert.equal(store.meeting(meeting.id).mode, 'manual');
    assert.equal(store.chunk(first.id)?.status, 'queued');
    assert.match(store.chunk(first.id)?.error ?? '', /Recovered/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('disk-backed queue isolates failed jobs and exports an honest transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-jobs-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Test meeting');
  let calls = 0;
  const manager = new JobManager(store, {
    async transcribe() { if (++calls === 1) throw new Error('Decoder failed'); return metrics; },
    close() {},
  });
  try {
    await store.addPcm(meeting.id, 'mic:test', 0, 0, 16000, Buffer.alloc(16000 * 4));
    await store.addPcm(meeting.id, 'mic:test', 1, 1000, 16000, Buffer.alloc(16000 * 4));
    manager.kick();
    await manager.wait();
    assert.deepEqual(store.chunks(meeting.id).map(chunk => chunk.status), ['failed', 'completed']);
    assert.match(store.markdown(meeting.id), /Decoder failed/);
    assert.match(store.markdown(meeting.id), /The experiment passed/);
  } finally { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('one-hour imported audio uses bounded decode windows, not one giant buffer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-import-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    store.addMedia(meeting.id, '/test/synthetic-hour.wav', 3600);
    const chunks = store.chunks(meeting.id);
    assert.equal(chunks.length, 180);
    assert.ok(chunks.every(chunk => chunk.seconds <= 20));
    assert.equal(chunks.at(-1)?.startMs, 3580000);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
