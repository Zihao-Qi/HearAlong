import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { echoesFor, rolesFor, type EchoSegment } from '../src/speakers.ts';
import { MeetingStore } from '../src/store.ts';

const rest = 'paper lamps turn amber shades beside folded copper frames after sunset today'.split(' ');
function edge(prefix = 'paper lamps turn amber', trailing = false) {
  const leading = prefix.split(' '), before = leading.map((text, i) => ({ text, startMs: 4300 + i * 35, endMs: 4330 + i * 35 }));
  const inside = rest.map((text, i) => ({ text, startMs: 4600 + i * 350, endMs: 4800 + i * 350 }));
  const words = trailing ? [...inside, ...before.map(w => ({ ...w, startMs: w.startMs + 5000, endMs: w.endMs + 5000 }))] : [...before, ...inside];
  const mic: EchoSegment = { id: 'mic', source: 'mic:room', startMs: words[0].startMs, endMs: words.at(-1)!.endMs, text: words.map(w => w.text).join(' '), words };
  const remote: EchoSegment = { id: 'call', source: 'app:call', startMs: 4500, endMs: 9000, text: rest.join(' ') };
  const roles = rolesFor([{ source: mic.source, startMs: 0, endMs: 15000 }, { source: remote.source, startMs: 4500, endMs: trailing ? 9000 : 15000 }]);
  return { mic, remote, roles };
}

test('clipping is allowed when four outside words themselves match, despite the 75% whole-segment ratio', () => {
  const { mic, remote, roles } = edge();
  assert.deepEqual([...echoesFor([mic, remote], roles)], ['mic']);
  assert.deepEqual([...echoesFor([{ ...mic, words: undefined }, remote], roles)], [], 'no timings: old whole-segment behavior');
});

test('unmatched room words before the call keep the entire mixed segment visible', () => {
  const { mic, remote, roles } = edge('please mute notifications now');
  assert.deepEqual([...echoesFor([mic, remote], roles)], []);
});

test('a 75% outside-word match now keeps the whole user-shaped sixteen-word segment visible', () => {
  const { mic, remote, roles } = edge('paper lamps turn softly');
  assert.deepEqual([...echoesFor([mic, remote], roles)], []);
});

test('negated genuine pre-call speech is preserved even though only do/not are novel', () => {
  const { mic, remote, roles } = edge('do not approve this plan');
  const rest = 'approve this plan tomorrow with the team after final checks are complete'.split(' ');
  const words = [...mic.words!.slice(0, 5), ...rest.map((text, i) => ({ text, startMs: 4600 + i * 350, endMs: 4800 + i * 350 }))];
  assert.deepEqual([...echoesFor([{ ...mic, text: words.map(w => w.text).join(' '), words }, { ...remote, text: rest.join(' ') }], roles)], []);
});

for (const prefix of ['softly', 'turn paper', 'paper softly', 'paper lamps softly']) test(`outside words must match in order: ${prefix}`, () => {
  const { mic, remote, roles } = edge(prefix);
  assert.deepEqual([...echoesFor([mic, remote], roles)], []);
});

for (const prefix of ['paper', 'paper lamps', 'paper lamps turn amber softly']) test(`outside words meeting their own ordered threshold may be clipped: ${prefix}`, () => {
  const { mic, remote, roles } = edge(prefix);
  assert.deepEqual([...echoesFor([mic, remote], roles)], ['mic']);
});

test('capture-end clipping is symmetric, and a genuine trailing clause is preserved too', () => {
  const echo = edge(undefined, true), genuine = edge('please mute notifications now', true);
  assert.deepEqual([...echoesFor([echo.mic, echo.remote], echo.roles)], ['mic']);
  assert.deepEqual([...echoesFor([genuine.mic, genuine.remote], genuine.roles)], []);
});

test('fewer than three remaining captured words stay visible; changed text cannot borrow stale word timing', () => {
  const { mic, remote, roles } = edge();
  const short = { ...mic, words: mic.words!.slice(0, 6), text: mic.words!.slice(0, 6).map(w => w.text).join(' ') };
  assert.deepEqual([...echoesFor([short, remote], roles)], []);
  assert.deepEqual([...echoesFor([{ ...mic, text: 'please mute notifications now ' + remote.text }, remote], roles)], []);
});

test('word midpoints exactly on capture edges are included', () => {
  const words = [{ text: 'paper', startMs: 4400, endMs: 4600 }, { text: 'lamps', startMs: 5000, endMs: 5100 }, { text: 'turn', startMs: 8900, endMs: 9100 }];
  const roles = rolesFor([{ source: 'mic:room', startMs: 0, endMs: 10000 }, { source: 'app:call', startMs: 4500, endMs: 9000 }]);
  assert.deepEqual([...echoesFor([{ id: 'm', source: 'mic:room', startMs: 4400, endMs: 9100, text: 'paper lamps turn', words },
    { id: 'r', source: 'app:call', startMs: 4500, endMs: 9000, text: 'paper lamps turn' }], roles)], ['m']);
});

test('MeetingStore reconstructs per-word times from chunk metrics without migration, and invalidates capture/metrics changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-edge-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional lantern call');
  try {
    const { mic } = edge();
    // Native words are relative to their chunk; segments carry only ord/timing, not word arrays.
    const chunk = await store.addPcm(meeting.id, 'mic:room', 0, 4000, 16000, Buffer.alloc(4 * 16000 * 6));
    store.completeChunk(chunk.id, { text: mic.text, words: mic.words!.map(w => ({ text: w.text, t0Ms: w.startMs - 4000, t1Ms: w.endMs - 4000 })),
      backend: 'fixture', computeMs: 1, decodeMs: 0, audioSeconds: 6, processRssBytes: 0, timestampKind: 'word' });
    const call = await store.addPcm(meeting.id, 'app:call', 0, 4500, 16000, Buffer.alloc(4 * 16000 * 6));
    store.completeChunk(call.id, { text: rest.join(' '), words: [], backend: 'fixture', computeMs: 1, decodeMs: 0,
      audioSeconds: 6, processRssBytes: 0, timestampKind: 'chunk' });
    assert.equal(store.segment(`${chunk.id}:0`)?.timing, 'word');
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), false);
    const original = store.chunk(chunk.id)!.metrics;
    store.db.prepare('UPDATE chunks SET metrics=? WHERE id=?').run(JSON.stringify({ words: [] }), chunk.id);
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), true, 'metadata update invalidates timing cache');
    store.db.prepare('UPDATE chunks SET metrics=? WHERE id=?').run(original, chunk.id);
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), false);
    store.db.prepare(`INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash)
      VALUES ('earlier',?,'app:call',0,'',4000,16000,'fixture')`).run(meeting.id);
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), true, 'earlier capture now includes all sixteen words (75%)');
    store.db.exec("DELETE FROM frames WHERE id='earlier'");
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), false);
    const words = store.recentCallWords(meeting.id, new Set(['mic:room']), 7000);
    assert.ok(words.length > 0 && words.every(w => w.endMs >= 7000));
    assert.ok(words[0].startMs >= 4000, 'chunk-relative word times became meeting times');
    const trailing = edge(undefined, true).mic;
    store.db.prepare('UPDATE chunks SET metrics=? WHERE id=?').run(JSON.stringify({ words: trailing.words!.map(w => ({ text: w.text, t0Ms: w.startMs - 4000, t1Ms: w.endMs - 4000 })) }), chunk.id);
    store.db.prepare('UPDATE segments SET text=?,originalText=?,startMs=?,endMs=? WHERE id=?').run(trailing.text, trailing.text, trailing.startMs, trailing.endMs, `${chunk.id}:0`);
    store.db.prepare('UPDATE chunks SET seconds=4.5 WHERE id=?').run(call.id);
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), false);
    store.db.prepare(`INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash)
      VALUES ('later',?,'app:call',1,'',9000,16000,'fixture')`).run(meeting.id);
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), true, 'capture end advances without a segment write or first-share change');
    store.db.exec("DELETE FROM frames WHERE id='later'");
    assert.equal(store.segments(meeting.id).some(s => s.source === 'mic:room'), false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
