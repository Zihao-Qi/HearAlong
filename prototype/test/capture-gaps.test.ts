import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { SampleCaptureClock, CaptureSuspension } from '../public/capture-clock.js';
import { captureGapText, mergeCaptureGaps, type CaptureGap } from '../public/capture-gaps.js';
import { detectCaptureGap } from '../src/capture-gaps.ts';
import { MeetingStore, FRAME_RATE } from '../src/store.ts';
import { transcriptRows } from '../public/transcript-view.js';

const pcm = Buffer.alloc(FRAME_RATE * 4);
const gap = (fromWallMs: number, toWallMs: number, atMs = 1000, reason: CaptureGap['reason'] = null): CaptureGap => ({ fromWallMs, toWallMs, atMs, reason });

test('capture time is sample-anchored, survives a paused context, and is unaffected by a 20 s upload backlog', () => {
  const clock = new SampleCaptureClock();
  const first = clock.at(0, FRAME_RATE, 100000);
  const second = clock.at(FRAME_RATE, FRAME_RATE, 101003); // render scheduling jitter is not drift
  assert.equal(second, first + 1000);
  // Receipt time is deliberately absent from detection: continuous first-sample times are continuous even if saved 20 s later.
  assert.equal(detectCaptureGap({ captureWallMs: first, samples: FRAME_RATE }, { captureWallMs: second }, 1000, FRAME_RATE), null);
  const wake = clock.at(2 * FRAME_RATE, FRAME_RATE, 602000);
  assert.equal(wake, 602000);
  assert.deepEqual(detectCaptureGap({ captureWallMs: second, samples: FRAME_RATE }, { captureWallMs: wake }, 2000, FRAME_RATE), gap(102000, 602000, 2000));
  const shortPause = clock.at(3 * FRAME_RATE, FRAME_RATE, wake + 5000);
  assert.equal(shortPause, wake + 5000, 'even a 4 s pause has an accurate capture time');
  assert.equal(detectCaptureGap({ captureWallMs: wake, samples: FRAME_RATE }, { captureWallMs: shortPause }, 3000, FRAME_RATE), null);
  const longPause = clock.at(4 * FRAME_RATE, FRAME_RATE, shortPause + 7000);
  assert.deepEqual(detectCaptureGap({ captureWallMs: shortPause, samples: FRAME_RATE }, { captureWallMs: longPause }, 4000, FRAME_RATE), gap(shortPause + 1000, longPause, 4000));
});

test('strict >5 s threshold, unknown capture times, and cause only from overlapping page suspension evidence', () => {
  const prev = { captureWallMs: 100000, samples: FRAME_RATE };
  for (const pause of [4000, 5000]) assert.equal(detectCaptureGap(prev, { captureWallMs: 101000 + pause }, 1000, FRAME_RATE), null);
  assert.deepEqual(detectCaptureGap(prev, { captureWallMs: 107000 }, 1000, FRAME_RATE), gap(101000, 107000));
  const suspension = new CaptureSuspension(100000);
  suspension.tick(107000);
  assert.deepEqual(detectCaptureGap(prev, { captureWallMs: 107000, suspension: suspension.interval! }, 1000, FRAME_RATE), gap(101000, 107000, 1000, 'sleep'));
  assert.equal(detectCaptureGap(prev, { captureWallMs: 200000, suspension: { fromWallMs: 90000, toWallMs: 100000 } }, 1000, FRAME_RATE)?.reason, null);
  assert.equal(detectCaptureGap({ samples: FRAME_RATE }, { captureWallMs: 107000 }, 1000, FRAME_RATE), null);
  assert.equal(detectCaptureGap(prev, undefined, 1000, FRAME_RATE), null);
  suspension.tick(108000, true);
  assert.deepEqual(suspension.interval, { fromWallMs: 100000, toWallMs: 108000 });
});

test('worklet timestamps before transfer and leaves every PCM sample and its order intact across suspension', async () => {
  const code = (await readFile(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '');
  let Processor: any;
  const messages: any[] = [];
  let now = 100000;
  const sandbox: any = { SampleCaptureClock, sampleRate: FRAME_RATE, currentFrame: 0, Date: { now: () => now },
    AudioWorkletProcessor: class { port = { postMessage: (message: any) => messages.push(message) }; },
    registerProcessor: (_name: string, ctor: any) => { Processor = ctor; } };
  runInNewContext(code, sandbox);
  const processor = new Processor();
  const input = Float32Array.from({ length: 128 }, (_, i) => i / 128);
  for (let quantum = 0; quantum < 250; quantum++) {
    sandbox.currentFrame = quantum * 128;
    now = 100000 + quantum * 8 + (quantum >= 125 ? 6000 : 0);
    processor.process([[input]], []);
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[1].captureWallMs - messages[0].captureWallMs, 7000);
  for (const message of messages) assert.deepEqual([...new Float32Array(message.buffer)], Array.from({ length: FRAME_RATE }, (_, i) => input[i % 128]));
});

test('overlapping mic/tab gaps merge transitively; non-overlapping gaps remain separate and inputs are immutable', () => {
  const input = [gap(10000, 20000, 1000), gap(18000, 30000, 1100, 'sleep'), gap(29000, 40000, 1200), gap(50000, 60000, 5000)];
  const copy = structuredClone(input);
  assert.deepEqual(mergeCaptureGaps(input), [gap(10000, 40000, 1000, 'sleep'), gap(50000, 60000, 5000)]);
  assert.deepEqual(input, copy);
  assert.equal(transcriptRows({ segments: [], captureGaps: input }).filter(r => r.kind === 'gap').length, 2);
});

test('locale 12-hour line, seconds, and paragraph boundary at the gap (even within one chunk)', () => {
  const start = new Date(2032, 4, 12, 9, 23, 39).getTime();
  const g = gap(start, new Date(2032, 4, 12, 9, 29, 52).getTime(), 1000, 'sleep');
  assert.equal(captureGapText(g, 'en-US'), 'Not recorded for 6 minutes, 9:23–9:29 AM: the Mac was asleep.');
  assert.equal(captureGapText({ ...g, reason: null }, 'en-US'), 'Not recorded for 6 minutes, 9:23–9:29 AM.');
  assert.match(captureGapText(gap(start, start + 46000), 'en-US'), /^Not recorded for 46 seconds,.*\.$/);
  assert.match(captureGapText(gap(start, start + 59999), 'en-US'), /^Not recorded for 59 seconds,/);
  const rows = transcriptRows({ captureGaps: [g], segments: [
    { id: 'chunk:0', startMs: 0, endMs: 1000, text: 'Before.', revision: 0 },
    { id: 'chunk:1', startMs: 1000, endMs: 2000, text: 'After.', revision: 0 },
  ] });
  assert.deepEqual(rows.map(r => r.kind), ['final', 'gap', 'final']);
  assert.deepEqual(rows[1].segments, []);
});

test('additive migration, frame + gap persistence, idempotent retries, old pages, and Markdown placement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-gap-store-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Capture notes');
    store.db.exec('ALTER TABLE frames DROP COLUMN captureWallMs; DROP TABLE capture_gaps;');
    store.close(); store = new MeetingStore(directory);
    await store.addFrame(meeting.id, 'mic:test', 0, 0, pcm, { captureWallMs: 100000 });
    const next = { captureWallMs: 107000, suspension: { fromWallMs: 100000, toWallMs: 107000 } };
    await store.addFrame(meeting.id, 'mic:test', 1, 1000, pcm, next);
    const again = await store.addFrame(meeting.id, 'mic:test', 1, 1000, pcm, next);
    assert.equal(again.added, false);
    assert.equal(store.captureGaps(meeting.id).length, 1);
    const before = store.captureGaps(meeting.id);
    const frames = store.heldFrames(meeting.id, 'mic:test');
    for (const [i, text] of ['Before.', 'After.'].entries()) {
      const chunk = await store.sealWindow(meeting.id, [frames[i]]);
      assert.equal((await readFile(store.resolvePath(chunk.path))).equals(pcm), true);
      store.completeChunk(chunk.id, { text, words: [], backend: 'test', computeMs: 1, decodeMs: 1,
        audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    }
    assert.deepEqual(store.segments(meeting.id).map(s => s.text), ['Before.', 'After.'], 'metadata never becomes speech');
    const md = store.markdown(meeting.id);
    assert.match(md, /Before\.[\s\S]*\[00:00:01\] \*Not recorded for 6 seconds at [^\n]+the Mac was asleep\.\*[\s\S]*After\./);
    store.close(); store = new MeetingStore(directory);
    assert.deepEqual(store.captureGaps(meeting.id), before);
    assert.equal(store.markdown(meeting.id), md);
    // Old page frames never create gaps, nor does the first timestamp after an unknown predecessor.
    await store.addFrame(meeting.id, 'old', 0, 0, pcm);
    await store.addFrame(meeting.id, 'old', 1, 1000, pcm);
    await store.addFrame(meeting.id, 'old', 2, 2000, pcm, { captureWallMs: 900000 });
    assert.equal(store.captureGaps(meeting.id).length, 1);
    assert.equal((await readFile(store.resolvePath(store.heldFrames(meeting.id, 'old')[0].path))).equals(pcm), true);
    // Continuous capture uploaded much later has no gap.
    await store.addFrame(meeting.id, 'late', 0, 0, pcm, { captureWallMs: Date.now() - 20000 });
    const captureWallMs = store.heldFrames(meeting.id, 'late')[0].captureWallMs! + 1000;
    await store.addFrame(meeting.id, 'late', 1, 1000, pcm, { captureWallMs });
    assert.equal(store.captureGaps(meeting.id).length, 1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
