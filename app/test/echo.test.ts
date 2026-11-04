import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { echoesFor, rolesFor } from '../src/speakers.ts';
import { MeetingStore } from '../src/store.ts';
import { takeSnapshot, notesInput } from '../src/notes.ts';
import { captureContext, actionInput } from '../src/actions.ts';
import { scanWindow, scanInput } from '../src/board.ts';
import { simpleEchoesFor } from './helpers/echo-reference.ts';

test('interval-indexed echo detection equals the simple rule on 250 randomized fictional meetings', () => {
  const vocabulary = ['paper', 'lantern', 'cedar', 'copper', 'ribbon', 'reef', 'shell', 'kelp', '12', '1.2', '1,200', '-3', '−3', "can't", 'sky-blue', 'café'];
  for (let seed = 1; seed <= 250; seed++) {
    let state = seed;
    const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const lines: { id: string; source: string; startMs: number; endMs: number; text: string; ord: number; words?: { text: string; startMs: number; endMs: number }[] }[] = [];
    for (let i = 0; i < 25; i++) {
      const startMs = random(60001), endMs = startMs + random(i % 5 === 0 ? 120000 : 5000);
      const text = Array.from({ length: random(15) }, () => vocabulary[random(vocabulary.length)]).join(' ');
      lines.push({ id: `remote-${i}`, source: i % 2 ? 'tab:call' : 'app:call', startMs, endMs, text, ord: random(4) });
    }
    // A long interval before many short ones defeats a binary search that assumes sorted end times.
    lines.push({ id: 'long', source: 'app:call', startMs: 0, endMs: 200000, text: 'folded amber workshop', ord: 0 });
    for (let i = 0; i < 30; i++) {
      const partner = lines[random(25)], startMs = partner.startMs + random(8001) - 4000;
      const text = random(2) ? `${partner.text.toUpperCase()}! extra` : Array.from({ length: random(16) }, () => vocabulary[random(vocabulary.length)]).join(' ');
      lines.push({ id: `mic-${i}`, source: i % 7 ? 'mic:room' : 'file:fixture', startMs, endMs: startMs + random(20000), text, ord: random(4) });
    }
    for (let i = lines.length - 1; i > 0; i--) { const j = random(i + 1); [lines[i], lines[j]] = [lines[j], lines[i]]; }
    for (const line of lines) if (line.source.startsWith('mic:') && random(2)) {
      const pieces = line.text.split(/\s+/).filter(Boolean), step = (line.endMs - line.startMs) / Math.max(1, pieces.length);
      line.words = pieces.map((text, i) => ({ text, startMs: line.startMs + i * step, endMs: line.startMs + (i + 1) * step }));
    }
    const before = structuredClone(lines), roles = seed % 2 ? rolesFor(lines) : rolesFor([
      { source: 'mic:room', startMs: -10000, endMs: 240000 }, { source: 'app:call', startMs: 20000, endMs: 60000 },
      { source: 'tab:call', startMs: 80000, endMs: 100000 },
    ]);
    assert.deepEqual(echoesFor(lines, roles), simpleEchoesFor(lines, roles), `seed ${seed}`);
    assert.deepEqual(lines, before, `input mutation at seed ${seed}`);
  }
});

const mic = (text: string, startMs = 10000, endMs = 12000) => ({ id: 'mic', source: 'mic:room', text, startMs, endMs });
const them = (text: string, startMs = 10000, endMs = 12000, id = 'them') => ({ id, source: 'app:call', text, startMs, endMs });
const speakers = rolesFor([{ source: 'mic:room', startMs: 0, endMs: 60000 }, { source: 'app:call', startMs: 0, endMs: 60000 }]);
const hidden = (...segments: ReturnType<typeof mic>[]) => [...echoesFor(segments, speakers)];

for (const [name, me, remote] of [
  ['identical', 'The paper lantern is ready', 'The paper lantern is ready'],
  ['case, punctuation and hyphens', 'The SKY-blue lantern, is ready!', 'the sky blue lantern is ready'],
  ['apostrophes', "We can't move the lantern", 'we cant move the lantern'],
  ['missing mic words', 'blue lantern is ready', 'The blue paper lantern is finally ready'],
  ['80 percent exactly', 'one two three four extra', 'one two three four'],
  ['100 percent with numeric punctuation', 'Use -3 and 1.2 units', 'Use −3 and 1.2 units!'],
  ['numeric comma kept', 'Bring 1,200 paper lanterns', 'bring 1,200 paper lanterns.'],
] as const) test(`echo: ${name}`, () => assert.deepEqual(hidden(mic(me), them(remote)), ['mic']));

for (const [name, me, remote] of [
  ['60 percent no longer sufficient', 'one two three extra words', 'one two three'],
  ['just below 80 percent', 'one two three extra', 'one two three'],
  ['negated genuine reply', 'No we should not ship', 'We should ship'],
  ['genuine Friday reply', 'I can do Friday', 'Can you do Friday?'],
  ['decimal point is not dropped', 'Set 1.2 units', 'Set 12 units'],
  ['numeric comma is not dropped', 'Bring 1,200 lanterns', 'Bring 1200 lanterns'],
  ['minus sign is not dropped', 'Set -3 units', 'Set 3 units'],
  ['negative decimal distinct', 'Set -1.2 units', 'Set 12 units'],
  ['reordered words are not a bag match', 'one two three four five', 'five four three two one'],
  ['actual user speech', 'I prefer a round green lantern', 'The paper lantern is ready'],
  ['headphones', 'Please bring the spare battery tomorrow', 'The paper lantern is ready'],
  ['one-word reply', 'yes', 'yes'],
  ['two-word reply', 'okay then', 'okay then'],
  ['digits are not spelled out', '12 34 56', 'twelve thirty-four fifty-six'],
] as const) test(`kept: ${name}`, () => assert.deepEqual(hidden(mic(me), them(remote)), []));

for (const offset of [-3000, 3000]) test(`echo: microphone edge within ${offset} ms`, () => {
  const me = offset < 0 ? mic('The paper lantern is ready', 5000, 7000) : mic('The paper lantern is ready', 15000, 17000);
  assert.deepEqual(hidden(me, them(me.text)), ['mic']);
});
for (const offset of [-3001, 3001]) test(`kept: microphone edge outside ${offset} ms`, () => {
  const me = offset < 0 ? mic('The paper lantern is ready', 4999, 6999) : mic('The paper lantern is ready', 15001, 17001);
  assert.deepEqual(hidden(me, them(me.text)), []);
});

test('echo: remote sentence split over two segments is concatenated in time order, without mutating input', () => {
  const all = [them('lantern is ready', 11000, 12000, 'later'), mic('The blue paper lantern is ready'), them('The blue paper', 10000, 11000, 'earlier')];
  const before = structuredClone(all);
  assert.deepEqual(hidden(...all), ['mic']);
  assert.deepEqual(all, before);
});

test('no call source and unlabelled room speech stay unchanged', () => {
  const all = [mic('The paper lantern is ready')];
  assert.deepEqual([...echoesFor(all, rolesFor(all))], []);
  const early = mic('The paper lantern is ready', 0, 1000);
  const lateCall = rolesFor([{ source: early.source, startMs: 0, endMs: 60000 }, { source: 'app:call', startMs: 10000, endMs: 60000 }]);
  assert.deepEqual([...echoesFor([early, them(early.text, 2000, 3000)], lateCall)], []);
});

test('all transcript readers hide echoes at read time; pending partner arrival and reopen need no migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional lantern review');
    const add = async (source: string, text: string) => {
      const chunk = await store.addPcm(meeting.id, source, 0, 0, 16000, Buffer.alloc(4 * 16000));
      store.completeChunk(chunk.id, { text, words: [], backend: 'fixture', computeMs: 1, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
      return `${chunk.id}:0`;
    };
    const text = 'The paper lantern is ready';
    const micId = await add('mic:room', text);
    assert.equal(store.segments(meeting.id).length, 1, 'mic final can appear before its partner');
    const callId = await add('app:call', text);
    const verify = () => {
      assert.deepEqual(store.segments(meeting.id).map(s => s.id), [callId]);
      assert.deepEqual(store.visibleSegments(meeting.id).map(s => s.id), [callId]);
      assert.equal(store.segment(micId)?.text, text, 'old citations still resolve');
      assert.equal(store.citationSegment(meeting.id, micId), callId, 'hidden citation resolves to surviving span');
      const pinned = { [micId]: { text }, [callId]: { text } };
      assert.deepEqual(Object.keys(store.withoutEchoes(meeting.id, pinned)), [callId], 'old pinned prompt evidence uses the same rule');
      assert.deepEqual(Object.keys(pinned), [micId, callId], 'saved evidence itself is never rewritten');
      assert.equal((store.db.prepare('SELECT count(*) AS n FROM segments WHERE meetingId=?').get(meeting.id) as { n: number }).n, 2, 'neither stored line is deleted');
      for (const exported of [store.markdown(meeting.id), store.markdown(meeting.id, 'raw'), store.plainText(meeting.id)]) {
        assert.equal(exported.split(text).length - 1, 1); assert.doesNotMatch(exported, /Me:/);
      }
      const snapshot = takeSnapshot(store, meeting.id, Date.now(), null);
      assert.deepEqual(snapshot.segments.map(s => s.id), [callId]);
      assert.doesNotMatch(notesInput(snapshot), /Me:/);
      const context = captureContext(store, meeting.id, { text, segmentIds: [callId] }, Date.now(), null, []);
      assert.deepEqual(context.lines.map(s => s.id), [callId]);
      assert.doesNotMatch(actionInput({ action: 'explain', prompt: null, context } as never), /\] Me:/);
      const window = scanWindow(store.visibleSegments(meeting.id), {}, store.speakers(meeting.id))!;
      assert.deepEqual(window.lines.map(l => l.segment.id), [callId]);
      assert.doesNotMatch(scanInput(window, [], [], 'Fictional review'), /Me:/);
    };
    verify(); store.close(); store = new MeetingStore(directory); verify();
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
