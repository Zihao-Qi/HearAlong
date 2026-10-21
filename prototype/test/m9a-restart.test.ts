import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { LiveCapture } from '../src/live.ts';

test('M9a restart mid meeting: two sources resume their saved sequence and every audio byte reaches exactly one chunk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm9a-restart-'));
  let store = new MeetingStore(directory);
  const meeting = store.createMeeting();
  const sources = ['mic:a', 'tab:b'];
  const audio = sources.map((_, s) => Array.from({ length: 54 }, (_, i) => {
    const pcm = new Float32Array(16_000).fill((s + 1) / 10);
    pcm[8000] = (i + s * 100) / 1000;
    return Buffer.from(pcm.buffer);
  }));
  try {
    let capture = new LiveCapture(store);
    for (let i = 0; i < 23; i++) for (const [s, source] of sources.entries()) await capture.accept(meeting.id, source, i, i * 1000, audio[s][i]);
    assert.equal(store.heldFrames(meeting.id).length, 46);
    // Abrupt restart: do NOT call capture.close(), which would seal held audio on graceful shutdown.
    store.close();
    store = new MeetingStore(directory); capture = new LiveCapture(store);
    for (let i = 23; i < 54; i++) for (const [s, source] of sources.entries()) await capture.accept(meeting.id, source, i, i * 1000, audio[s][i]);
    for (const source of sources) await capture.end(meeting.id, source, 53);
    for (const [s, source] of sources.entries()) {
      const chunks = store.chunks(meeting.id).filter(c => c.source === source).sort((a, b) => a.sequence - b.sequence);
      const bytes = Buffer.concat(await Promise.all(chunks.map(c => readFile(c.path))));
      assert.ok(bytes.equals(Buffer.concat(audio[s])), `${source}: byte-for-byte, no gaps, no duplication`);
      assert.equal(chunks.reduce((n, c) => n + c.seconds, 0), 54);
    }
    assert.equal(store.heldFrames(meeting.id).length, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
