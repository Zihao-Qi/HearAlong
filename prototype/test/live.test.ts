import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveCapture, chooseCut, IDLE_SEAL_MS } from '../src/live.ts';
import { MeetingStore } from '../src/store.ts';
import type { LiveDrafts } from '../src/drafts.ts';

const SOURCE = 'mic:00000000-0000-0000-0000-000000000001';
/** A 1 s frame whose samples encode its number (for byte conservation); `quietEdges` silences its first and last 100 ms. */
function frame(n: number, quietEdges = false) {
  const pcm = new Float32Array(16000).fill(0.5);
  pcm[8000] = 0.5 + n / 1000;
  if (quietEdges) { pcm.fill(0, 0, 1600); pcm.fill(0, 14400); }
  return Buffer.from(pcm.buffer);
}
class FakeDrafts {
  calls: string[] = [];
  begin(_m: string, _s: string, window: string) { this.calls.push(`begin ${window}`); return true; }
  feed(window: string, pcm: Float32Array) { this.calls.push(`feed ${window} ${Math.round((pcm[8000] - 0.5) * 1000)}`); }
  drop(window: string) { this.calls.push(`drop ${window}`); }
  seal(window: string) { this.calls.push(`seal ${window}`); }
  release(source: string) { this.calls.push(`release ${source}`); }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-live-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting();
  let now = 1_000_000;
  const drafts = new FakeDrafts();
  const make = (s = store) => new LiveCapture(s, { drafts: drafts as unknown as LiveDrafts, clock: () => now });
  return { directory, store, meeting, drafts, make, advance: (ms: number) => { now += ms; }, async close() { try { this.store.close(); } catch { /* already closed */ } await rm(directory, { recursive: true, force: true }); } };
}

test('the cut is the quietest frame boundary between 16 and 24 s, the later one on ties', () => {
  const frames = Array.from({ length: 25 }, () => ({ samples: 16000 }));
  assert.equal(chooseCut(frames, i => (i === 19 ? 0.01 : 1)), 19);
  assert.equal(chooseCut(frames, () => 1), 24, 'ties go to the later boundary');
  assert.equal(chooseCut(frames, i => (i === 10 ? 0 : 1)), 24, 'a pause before 16 s is not eligible');
});

test('frames are sealed into 16–24 s windows at a pause; every sample lands in exactly one window', async () => {
  const f = await fixture();
  try {
    const live = f.make();
    // Frame 18 has quiet edges, so the boundaries before and after it are pauses; the later one (19) wins.
    for (let n = 0; n < 30; n++) await live.accept(f.meeting.id, SOURCE, n, n * 1000, frame(n, n === 18));
    let chunks = f.store.chunks(f.meeting.id);
    assert.deepEqual(chunks.map(c => [c.sequence, c.seconds, c.startMs]), [[0, 19, 0]], 'sealed once 24 s were held, cut at 19 s');
    assert.equal(f.store.heldFrames(f.meeting.id).length, 11);
    assert.equal(f.store.audioEndMs(f.meeting.id), 30_000);
    const ended = await live.end(f.meeting.id, SOURCE, 29);
    assert.equal(ended.sealed, 1);
    chunks = f.store.chunks(f.meeting.id);
    assert.deepEqual(chunks.map(c => [c.sequence, c.seconds, c.startMs]), [[0, 19, 0], [19, 11, 19_000]]);
    const all = Buffer.concat(await Promise.all(chunks.map(c => readFile(f.store.resolvePath(c.path)))));
    assert.ok(all.equals(Buffer.concat(Array.from({ length: 30 }, (_, n) => frame(n, n === 18)))), 'byte for byte, in order, nothing twice');
    // Frame files are removed once their audio is in a window.
    for (const fr of f.store.db.prepare('SELECT path FROM frames').all() as { path: string }[]) await assert.rejects(access(f.store.resolvePath(fr.path)));
    await assert.rejects(live.accept(f.meeting.id, SOURCE, 30, 30_000, frame(30)), /ended/);
    assert.deepEqual(await live.end(f.meeting.id, SOURCE, 29), { sealed: 0 }, 'end is idempotent');
  } finally { await f.close(); }
});

test('the draft follows the window: the sealed draft is frozen and the frames after the cut are replayed in order', async () => {
  const f = await fixture();
  try {
    const live = f.make();
    for (let n = 0; n < 25; n++) await live.accept(f.meeting.id, SOURCE, n, n * 1000, frame(n, n === 20));
    const calls = f.drafts.calls;
    assert.equal(calls[0], `begin ${SOURCE}:0`);
    const drop = calls.indexOf(`seal ${SOURCE}:0`);
    assert.ok(drop > 0);
    // Cut at 21 s: frames 21–24 start the next window's draft, fed in order.
    assert.deepEqual(calls.slice(drop + 1), [`begin ${SOURCE}:21`, `feed ${SOURCE}:21 21`, `feed ${SOURCE}:21 22`, `feed ${SOURCE}:21 23`, `feed ${SOURCE}:21 24`]);
    await live.accept(f.meeting.id, SOURCE, 25, 25_000, frame(25));
    assert.equal(calls.at(-1), `feed ${SOURCE}:21 25`, 'newer frames continue the new window');
  } finally { await f.close(); }
});

test('a quiet source is sealed by the sweep, including a short tail, and frames saved before a restart are recovered', async () => {
  const f = await fixture();
  try {
    const live = f.make();
    const tiny = Buffer.from(new Float32Array(1600).fill(0.3).buffer); // 0.1 s: kept, not dropped
    await live.accept(f.meeting.id, SOURCE, 0, 0, frame(0));
    await live.accept(f.meeting.id, SOURCE, 1, 1000, tiny);
    await live.sweep();
    assert.equal(f.store.chunks(f.meeting.id).length, 0, 'not idle yet');
    f.advance(IDLE_SEAL_MS + 1);
    await live.sweep();
    assert.deepEqual(f.store.chunks(f.meeting.id).map(c => c.seconds), [1.1]);

    // A restart: frames held in the database are sealed by a fresh LiveCapture once idle.
    const other = 'mic:00000000-0000-0000-0000-000000000002';
    await live.accept(f.meeting.id, other, 0, 5000, frame(7));
    f.store.close();
    const reopened = new MeetingStore(f.directory);
    try {
      await reopened.removeSealedFrameFiles();
      const after = f.make(reopened);
      f.advance(IDLE_SEAL_MS + 1);
      await after.sweep(); // first sight of the source starts its idle clock
      assert.equal(reopened.chunks(f.meeting.id).length, 1);
      f.advance(IDLE_SEAL_MS + 1);
      await after.sweep();
      assert.deepEqual(reopened.chunks(f.meeting.id).map(c => [c.source, c.startMs]), [[SOURCE, 0], [other, 5000]]);
    } finally { reopened.close(); f.store = new MeetingStore(f.directory); }
  } finally { await f.close(); }
});

test('a window cannot be sealed twice; frames must be 1 s, in sequence and contiguous, with only the last one shorter', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 3; n++) await f.store.addFrame(f.meeting.id, SOURCE, n, n * 1000, frame(n));
    const held = f.store.heldFrames(f.meeting.id, SOURCE);
    const [first, second] = await Promise.allSettled([f.store.sealWindow(f.meeting.id, held), f.store.sealWindow(f.meeting.id, held)]);
    assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.store.chunks(f.meeting.id).length, 1);
    await assert.rejects(f.store.addFrame(f.meeting.id, SOURCE, 5, 5000, frame(5)), /out of order/);
    await assert.rejects(f.store.addFrame(f.meeting.id, SOURCE, 1, 1000, frame(9)), /different audio frame/);
    assert.equal((await f.store.addFrame(f.meeting.id, SOURCE, 2, 2000, frame(2))).added, false, 'a repeat is recognised as one');
    await assert.rejects(f.store.addFrame(f.meeting.id, SOURCE, 3, 2500, frame(3)), /does not start where/, 'overlap');
    await assert.rejects(f.store.addFrame(f.meeting.id, SOURCE, 3, 4000, frame(3)), /does not start where/, 'gap');
    await assert.rejects(f.store.addFrame(f.meeting.id, SOURCE, 3, 3000, Buffer.alloc(16001 * 4)), /at most 1 s/);
    await f.store.addFrame(f.meeting.id, SOURCE, 3, 3000, Buffer.from(new Float32Array(800).fill(0.2).buffer));
    await assert.rejects(f.store.addFrame(f.meeting.id, SOURCE, 4, 3050, frame(4)), /last \(partial\) frame/);
  } finally { await f.close(); }
});

test('a retried frame is not fed to the draft again', async () => {
  const f = await fixture();
  try {
    const live = f.make();
    await live.accept(f.meeting.id, SOURCE, 0, 0, frame(0));
    await live.accept(f.meeting.id, SOURCE, 1, 1000, frame(1));
    await live.accept(f.meeting.id, SOURCE, 1, 1000, frame(1)); // lost reply, same bytes again
    assert.deepEqual(f.drafts.calls.filter(c => c.startsWith('feed')), [`feed ${SOURCE}:0 0`, `feed ${SOURCE}:0 1`]);
  } finally { await f.close(); }
});

test('startup cleanup keeps frame files when their window file is missing (they are then the only copy)', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 2; n++) await f.store.addFrame(f.meeting.id, SOURCE, n, n * 1000, frame(n));
    const held = f.store.heldFrames(f.meeting.id, SOURCE);
    // A seal whose frame cleanup did not happen (crash), and whose window file was then lost.
    const chunk = await f.store.sealWindow(f.meeting.id, held.slice(0, 1));
    await writeFile(f.store.resolvePath(held[0].path), frame(0)); // the frame file survived (crash before cleanup)...
    await rm(f.store.resolvePath(chunk.path)); // ...and the window file was lost
    await f.store.removeSealedFrameFiles();
    await access(f.store.resolvePath(held[0].path)); // kept: it is the only copy
    assert.equal(chunk.status, 'queued', 'a committed window is queued even though cleanup is best effort');
    const live = f.make();
    await live.end(f.meeting.id, SOURCE, 1);
    const second = f.store.chunks(f.meeting.id).find(c => c.sequence === 1)!;
    await f.store.removeSealedFrameFiles();
    await assert.rejects(access(f.store.resolvePath(held[1].path)), 'frame files go once their window file exists');
    await access(f.store.resolvePath(second.path));
  } finally { await f.close(); }
});

test('a recording source is quiet after a minute without sound at its level; the tab and the microphone have their own level', async () => {
  const f = await fixture();
  const TAB = 'tab:00000000-0000-0000-0000-000000000002';
  const level = (value: number) => Buffer.from(new Float32Array(16000).fill(value).buffer);
  try {
    const live = f.make();
    const at = () => Object.fromEntries(live.liveSources(f.meeting.id).map(s => [s.source.slice(0, 3), s.quiet]));
    await live.accept(f.meeting.id, SOURCE, 0, 0, level(0.0005)); // room noise at −66 dBFS: sound for a microphone
    await live.accept(f.meeting.id, TAB, 0, 0, level(0.0005)); // the same level from a tab is silence
    for (let n = 1; n <= 61; n++) {
      f.advance(1000);
      await live.accept(f.meeting.id, SOURCE, n, n * 1000, level(n < 30 ? 0.0005 : 0.0001));
      await live.accept(f.meeting.id, TAB, n, n * 1000, level(0.0005));
    }
    assert.deepEqual(at(), { mic: false, tab: true }, 'the microphone had sound 32 s ago; the tab never had any');
    f.advance(1000); await live.accept(f.meeting.id, TAB, 62, 62_000, level(0.01));
    for (let n = 62; n <= 91; n++) { f.advance(1000); await live.accept(f.meeting.id, SOURCE, n, n * 1000, level(0)); await live.accept(f.meeting.id, TAB, n + 1, (n + 1) * 1000, level(0)); }
    assert.deepEqual(at(), { mic: true, tab: false }, 'tab sound clears its notice; a minute of near-zero microphone sets one');
    f.advance(16_000);
    assert.deepEqual(at(), {}, 'a source with no frame for 15 s is not listed');
    f.advance(-16_000);
    await live.end(f.meeting.id, TAB, 92);
    assert.deepEqual(Object.keys(at()), ['mic'], 'an ended source is not listed');
  } finally { await f.close(); }
});

test('closing seals what each source still holds, and refuses frames after it began', async () => {
  const f = await fixture();
  try {
    const live = f.make();
    for (let n = 0; n < 5; n++) await live.accept(f.meeting.id, SOURCE, n, n * 1000, frame(n));
    assert.equal(f.store.heldFrames(f.meeting.id).length, 5, 'five seconds held: too short for a window yet');
    assert.equal(live.recording(), true);
    await live.close();
    assert.equal(f.store.heldFrames(f.meeting.id).length, 0, 'nothing held after the close');
    assert.equal(f.store.chunks(f.meeting.id).length, 1, 'one window with the five seconds');
    await assert.rejects(live.accept(f.meeting.id, SOURCE, 5, 5000, frame(5)), /stopped/);
  } finally { await f.close(); }
});

test('frames queued before a close are saved and sealed by it; a frame arriving after it began is refused', async () => {
  const f = await fixture();
  try {
    const live = f.make();
    const queued = [0, 1, 2].map(n => live.accept(f.meeting.id, SOURCE, n, n * 1000, frame(n)));
    const closing = live.close();
    await assert.rejects(live.accept(f.meeting.id, SOURCE, 3, 3000, frame(3)), /stopped/);
    await Promise.all(queued);
    await closing;
    const chunks = f.store.chunks(f.meeting.id);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].seconds, 3, 'all three queued seconds are in the window');
    assert.equal(f.store.heldFrames(f.meeting.id).length, 0);
  } finally { await f.close(); }
});
