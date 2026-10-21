import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { CaptureSuspension, SampleCaptureClock } from '../public/capture-clock.js';
import { captureGapText } from '../public/capture-gaps.js';
import { transcriptRows } from '../public/transcript-view.js';
import { captureDiscontinuities, detectCaptureGap, detectFrameCaptureGaps } from '../src/capture-gaps.ts';
import { MeetingStore, FRAME_RATE } from '../src/store.ts';
import type { Preview, PendingPreview } from '../public/preview-composition.js';

async function worklet() {
  const code = (await readFile(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '');
  let Processor: any;
  const messages: any[] = [];
  let quantum = 0, elapsedSleep = 0;
  const sandbox: any = { SampleCaptureClock, sampleRate: FRAME_RATE, currentFrame: 0, Date: { now: () => 100000 + quantum * 8 + elapsedSleep },
    AudioWorkletProcessor: class { port = { postMessage: (message: any) => messages.push(structuredClone(message)) }; },
    registerProcessor: (_name: string, ctor: any) => { Processor = ctor; } };
  runInNewContext(code, sandbox);
  const processor = new Processor();
  const input = Float32Array.from({ length: 128 }, (_, i) => i / 128);
  return { messages, input,
    capture(count: number) { for (let i = 0; i < count; i++, quantum++) { sandbox.currentFrame = quantum * 128; processor.process([[input]], []); } },
    sleep(ms: number) { elapsedSleep += ms; },
    flush() { processor.port.onmessage({ data: 'flush' }); },
  };
}

test('fix 1: a 382 s sleep inside the terminal frame persists at its sample offset without changing PCM', async () => {
  const w = await worklet();
  w.capture(175); // one full frame, then 400 ms in the last frame
  w.sleep(382000);
  w.capture(25); // 200 ms after wake; Stop before any later frame can reveal the sleep
  w.flush();
  const frames = w.messages.filter(m => m.kind === 'pcm');
  assert.deepEqual(frames.map(m => m.buffer.byteLength / 4), [16000, 9600]);
  for (const frame of frames) assert.deepEqual([...new Float32Array(frame.buffer)],
    Array.from({ length: frame.buffer.byteLength / 4 }, (_, i) => w.input[i % 128]));
  const directory = await mkdtemp(join(tmpdir(), 'gap-terminal-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    for (const [i, frame] of frames.entries()) await store.addFrame(meeting.id, 'mic:test', i, i * 1000, Buffer.from(frame.buffer), frame);
    const gaps = store.captureGaps(meeting.id);
    assert.equal(gaps.length, 1, 'terminal sleep must not disappear just because no next frame arrives');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM capture_gaps').get() as { n: number }).n, 1);
    assert.deepEqual({ ...gaps[0] }, { meetingId: meeting.id, source: 'mic:test', atMs: 1400, fromWallMs: 101400, toWallMs: 483400, reason: null });
    await store.addFrame(meeting.id, 'mic:test', 1, 1000, Buffer.from(frames[1].buffer), frames[1]);
    assert.equal(store.captureGaps(meeting.id).length, 1, 'retry is idempotent');
    await assert.rejects(store.addFrame(meeting.id, 'mic:test', 2, 1600, Buffer.alloc(64000)), /last \(partial\) frame/);
    const chunk = await store.sealWindow(meeting.id, store.heldFrames(meeting.id, 'mic:test'));
    assert.deepEqual(await readFile(store.resolvePath(chunk.path)), Buffer.concat(frames.map(f => Buffer.from(f.buffer))));
    store.close(); store = new MeetingStore(directory);
    assert.deepEqual(store.captureGaps(meeting.id), gaps);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fix 1 boundaries: interior sleeps are not rediscovered by the next frame, and boundary sleeps are not sent twice', async () => {
  for (const boundary of [false, true]) {
    const w = await worklet();
    w.capture(boundary ? 125 : 50);
    w.sleep(382000);
    w.capture(boundary ? 125 : 200);
    const frames = w.messages.filter(m => m.kind === 'pcm');
    assert.equal(frames.length, 2);
    assert.equal(frames.flatMap(m => m.discontinuities ?? []).length, boundary ? 0 : 1);
    const directory = await mkdtemp(join(tmpdir(), 'gap-boundary-'));
    let store = new MeetingStore(directory);
    try {
      const meeting = store.createMeeting();
      await store.addFrame(meeting.id, 'mic:test', 0, 0, Buffer.from(frames[0].buffer), frames[0]);
      store.close(); store = new MeetingStore(directory); // effective wall end must survive a restart too
      await store.addFrame(meeting.id, 'mic:test', 1, 1000, Buffer.from(frames[1].buffer), frames[1]);
      const gaps = store.captureGaps(meeting.id);
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0].atMs, boundary ? 1000 : 400);
      assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM capture_gaps').get() as { n: number }).n, 1, 'check raw storage, not just merged output');
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('fix 1 thresholds: in-frame pauses must exceed 5 s, and multiple in-frame sleeps retain separate offsets', async () => {
  for (const pause of [4000, 5000, 6000]) {
    const w = await worklet(); w.capture(50); w.sleep(pause); w.capture(25); w.flush();
    const frame = w.messages[0];
    assert.equal(frame.discontinuities.length, pause > 5000 ? 1 : 0);
    if (pause > 5000) assert.deepEqual(frame.discontinuities, [{ offsetSamples: 6400, fromWallMs: 100400, toWallMs: 106400 }]);
  }
  const w = await worklet(); w.capture(25); w.sleep(6000); w.capture(25); w.sleep(7000); w.capture(25); w.flush();
  assert.deepEqual(w.messages[0].discontinuities.map((d: any) => d.offsetSamples), [3200, 6400]);
  const evidence = detectFrameCaptureGaps(undefined, { ...w.messages[0], suspension: { fromWallMs: 100000, toWallMs: 114000 } }, 0, 9600, FRAME_RATE);
  assert.deepEqual(evidence.gaps.map(g => [g.atMs, g.reason]), [[200, 'sleep'], [400, 'sleep']]);
  assert.equal(evidence.endWallMs, 113600);
  const valid = w.messages[0].discontinuities;
  for (const invalid of [null, {}, 'bad JSON', [{ ...valid[0], offsetSamples: 0 }], [{ ...valid[0], offsetSamples: 9600 }],
    [valid[1], valid[0]], [{ ...valid[0], toWallMs: NaN }], Array(129).fill(valid[0])]) {
    assert.deepEqual(captureDiscontinuities(invalid, 9600), [], 'ignore malformed optional evidence');
  }
});

test('fix 2: Gemini spanning draft and pending words sit on both sides of the gap with stable run keys', () => {
  const words = 'Please stack the blue crates beside the kiln before opening'.split(' ').map((text, i) => ({ text, startMs: 526000 + i * 240, endMs: 526240 + i * 240 }));
  const preview: Preview = { source: 'mic:test', window: 'same-window', windowStartMs: 526000, coveredUntilMs: 528400, words,
    text: words.map(w => w.text).join(' '), behind: false };
  const gap = { atMs: 526960, fromWallMs: 100000, toWallMs: 482000, reason: 'sleep' as const };
  for (const kind of ['draft', 'pending-before', 'pending-tail'] as const) {
    const pending: PendingPreview = { ...preview, chunkId: 'c1', cutMs: kind === 'pending-before' ? 529600 : 525000 };
    const snapshot = { segments: [], captureGaps: [gap], drafts: kind === 'draft' ? [preview] : [], pending: kind === 'draft' ? [] : [pending] };
    const rows = transcriptRows(snapshot);
    assert.deepEqual(rows.map(r => r.preview?.text ?? 'GAP'), ['Please stack the blue', 'GAP', 'crates beside the kiln before opening'], kind);
    assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
    const shorter = { ...preview, words: words.slice(0, -1) };
    const earlier = transcriptRows({ ...snapshot, drafts: kind === 'draft' ? [shorter] : [], pending: kind === 'draft' ? [] : [{ ...pending, words: shorter.words }] });
    assert.deepEqual(rows.map(r => r.key), earlier.map(r => r.key), 'word growth must not replace either gap-bounded node');
    const lateSource = transcriptRows({ ...snapshot, captureGaps: [gap, { ...gap, fromWallMs: gap.fromWallMs - 200 }] });
    assert.deepEqual(rows.map(r => r.key).filter(k => !k.startsWith('gap:')), lateSource.map(r => r.key).filter(k => !k.startsWith('gap:')), 'wall-time merging must not rekey preview runs');
    assert.deepEqual(rows.flatMap(r => r.preview?.words ?? []), words, 'every word exactly once, unchanged');
    if (kind === 'draft') {
      const handoff = transcriptRows({ ...snapshot, segments: [{ id: 'pre-gap:0', startMs: 526000, endMs: 526960, text: 'Please stack the blue', revision: 0 }],
        drafts: [{ ...preview, words: words.slice(4) }] });
      const ordinaryHandoff = transcriptRows({ segments: [{ id: 'pre-gap:0', startMs: 526000, endMs: 526960, text: 'Please stack the blue', revision: 0 }],
        drafts: [{ ...preview, words: words.slice(4) }] });
      assert.deepEqual(handoff.find(r => r.preview), ordinaryHandoff.find(r => r.preview),
        'once only unaffected words remain, the lane must have exactly its ordinary M9a identity/grouping');
    }
  }
});

test('fix 3: Gemini timer-then-resume ordering preserves the detected sleep cause', () => {
  const suspension = new CaptureSuspension(100000);
  suspension.tick(482000);
  suspension.tick(482005, true);
  const gap = detectCaptureGap({ captureWallMs: 99000, samples: FRAME_RATE },
    { captureWallMs: 482000, suspension: suspension.interval! }, 1000, FRAME_RATE);
  assert.equal(gap?.reason, 'sleep');
  assert.deepEqual(suspension.interval, { fromWallMs: 100000, toWallMs: 482005 });
  const normal = new CaptureSuspension(100000);
  normal.tick(101000);
  normal.tick(101005, true);
  assert.deepEqual(normal.interval, { fromWallMs: 101000, toWallMs: 101005 }, 'resume without a detected jump starts only at the last tick');
});

test('fix 4: a same-minute sub-minute gap says at, with or without the cause', () => {
  const fromWallMs = new Date(2031, 3, 9, 9, 23, 12).getTime();
  for (const reason of [null, 'sleep'] as const) assert.equal(captureGapText({ atMs: 0, fromWallMs, toWallMs: fromWallMs + 18000, reason }, 'en-US'),
    `Not recorded for 18 seconds at 9:23 AM${reason ? ': the Mac was asleep' : ''}.`);
  assert.equal(captureGapText({ atMs: 0, fromWallMs: fromWallMs + 40000, toWallMs: fromWallMs + 58000, reason: null }, 'en-US'),
    'Not recorded for 18 seconds, 9:23–9:24 AM.');
});
