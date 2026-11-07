import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capPass, capWordEnd, wordCapMs, MAX_WORD_MS, MIN_WORD_MS, MAX_NUMBER_MS } from '../src/word-ends.ts';
import { buildSegments, usableTimes, wordSegments, EARLIER_SHORT_SENTENCE_PAUSE_MS } from '../src/segments.ts';
import { transcribeRecovering, type Word } from '../src/recovery.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import { MeetingStore, type Chunk } from '../src/store.ts';
import { echoesFor, rolesFor, type EchoSegment } from '../src/speakers.ts';
import { handoffAt } from '../public/transcript-view.js';
import { coversTime, midpoint } from '../public/preview-composition.js';

const words = (...items: [string, number, number][]): Word[] => items.map(([text, t0Ms, t1Ms]) => ({ text, t0Ms, t1Ms }));
const lines = (parts: { text: string; startMs: number; endMs: number }[]) => parts.map(p => [p.text, p.startMs, p.endMs]);
const recognition = (text: string, list: Word[], extra: object = {}) => ({ text, words: list, backend: 'fixture', computeMs: 1, decodeMs: 0,
  audioSeconds: 20, processRssBytes: 0, timestampKind: 'word', ...extra });

test('a word ends at most 90 ms per character after its start, within 400–1200 ms', () => {
  assert.equal(wordCapMs('ox'), MIN_WORD_MS, 'short words get the floor');
  assert.equal(wordCapMs('  marsh '), 450, 'trimmed characters count');
  assert.equal(wordCapMs('onward.'), 630, 'punctuation counts as characters');
  assert.equal(wordCapMs('counterbalancing'), MAX_WORD_MS, 'long words get the ceiling');
  assert.equal(wordCapMs(''), MIN_WORD_MS);
  assert.deepEqual(capWordEnd({ text: 'ox', t0Ms: 1000, t1Ms: 3000 }), { text: 'ox', t0Ms: 1000, t1Ms: 1400 });
  assert.deepEqual(capWordEnd({ text: 'counterbalancing', t0Ms: 1000, t1Ms: 9000 }), { text: 'counterbalancing', t0Ms: 1000, t1Ms: 2200 });
  assert.deepEqual(capWordEnd({ text: 'onward.', t0Ms: 5480, t1Ms: 20000 }), { text: 'onward.', t0Ms: 5480, t1Ms: 6110 }, 'a stretched last word at the window end');
  const short = { text: 'marsh', t0Ms: 560, t1Ms: 900 };
  assert.equal(capWordEnd(short), short, 'a word already shorter than its cap is unchanged');
  for (const word of [{ text: 'ox', t0Ms: 700, t1Ms: 650 }, { text: 'ox', t0Ms: NaN, t1Ms: 900 }, { text: 'ox', t0Ms: 0, t1Ms: Infinity }]) {
    assert.equal(capWordEnd(word), word, 'the start never moves and broken times are left for the publication checks');
  }
});

test('a native segment ends at the latest capped end of the words starting inside it', () => {
  const pass = capPass({ text: 'Quill hums. Marsh.', words: words(['Quill', 0, 300], ['hums.', 400, 3000], ['Marsh.', 9000, 20000]),
    segments: words(['Quill hums.', 0, 8900], ['Marsh.', 9000, 20000], ['Fen', 21000, 21500], ['Reed', 22000, 22100]) }, 25_000);
  assert.deepEqual(pass.words.map(w => w.t1Ms), [300, 850, 9540]);
  assert.deepEqual(pass.segments!.map(s => [s.t0Ms, s.t1Ms]), [[0, 850], [9000, 9540], [21000, 21500], [22000, 22100]],
    'segments without words keep their ends; ends are never extended');
  assert.deepEqual(capPass({ text: 'x', words: [] }, 20_000), { text: 'x', words: [] });
});

test('a pause after an unpunctuated word now splits the line; punctuated sentence ends split as before', () => {
  const stretched = words(['maple', 0, 300], ['drift', 350, 2600], ['onward', 2700, 3000]);
  const text = 'maple drift onward';
  assert.deepEqual(lines(buildSegments(20_000, { text, words: stretched })), [['maple drift onward', 0, 3000]], 'the pause was hidden in a word');
  assert.deepEqual(lines(buildSegments(20_000, { text, words: capPass({ text, words: stretched }, 20_000).words })),
    [['maple drift', 0, 800], ['onward', 2700, 3000]]);
  const sentence = words(['Maple', 0, 300], ['drifts', 350, 600], ['north.', 650, 3500], ['Fern', 3600, 3900]);
  const said = 'Maple drifts north. Fern';
  assert.deepEqual(buildSegments(20_000, { text: said, words: sentence }).map(p => p.text), ['Maple drifts north.', 'Fern']);
  assert.deepEqual(lines(buildSegments(20_000, { text: said, words: capPass({ text: said, words: sentence }, 20_000).words })),
    [['Maple drifts north.', 0, 1190], ['Fern', 3600, 3900]]);
});

test('recovered halves are each capped before the right half is offset', async () => {
  const pcm = new Float32Array(20 * 16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin(i / 10);
  let calls = 0, cutMs = 0;
  const result = await transcribeRecovering(pcm, async part => {
    calls++;
    if (calls === 2) cutMs = part.length / 16;
    const pass = calls === 1 ? { text: '', words: [] }
      : { text: calls === 2 ? 'Quill' : 'marsh', words: words([calls === 2 ? 'Quill' : 'marsh', 100, 9000]), segments: words(['x', 100, 9000]) };
    return capPass(pass, part.length / 16);
  });
  assert.equal(result.recoveredBy, 'halves');
  assert.deepEqual(result.words.map(w => [w.t0Ms, w.t1Ms]), [[100, 550], [cutMs + 100, cutMs + 550]]);
  assert.deepEqual(result.segments!.map(s => [s.t0Ms, s.t1Ms]), [[100, 550], [cutMs + 100, cutMs + 550]]);
});

test('the speech worker returns capped words and the published lines end at them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-worker-'));
  const recognizer = new LocalRecognizer('/fictional/model', new URL('./fixtures/stretched-worker.ts', import.meta.url));
  const store = new MeetingStore(directory);
  t.after(async () => { await recognizer.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'fictional.f32');
  await writeFile(path, Buffer.alloc(4 * 16000 * 20));
  const result = await recognizer.transcribe({ id: 'fictional', path, decodeStart: 0, seconds: 20, sampleRate: 16000 } as Chunk);
  assert.deepEqual(result.words.map(w => [w.text.trim(), w.t0Ms, w.t1Ms]),
    [['Quill', 200, 500], ['marsh', 560, 900], ['hums', 960, 1360], ['gently', 5000, 5400], ['onward.', 5480, 6110]]);
  assert.deepEqual(result.segments!.map(s => [s.t0Ms, s.t1Ms]), [[200, 6110]]);
  const meeting = store.createMeeting('Fictional marsh');
  const chunk = await store.addPcm(meeting.id, 'mic:test', 0, 10_000, 16000, Buffer.alloc(4 * 16000 * 20));
  store.completeChunk(chunk.id, result);
  assert.deepEqual(store.segments(meeting.id).map(s => [s.text, s.startMs - 10_000, s.endMs - 10_000]),
    [['Quill marsh hums', 200, 1360], ['gently onward.', 5000, 6110]]);
  assert.deepEqual(store.recentCallWords(meeting.id, new Set(['mic:test']), 0).map(w => [w.text, w.startMs - 10_000, w.endMs - 10_000]),
    [['Quill', 200, 500], ['marsh', 560, 900], ['hums', 960, 1360], ['gently', 5000, 5400], ['onward.', 5480, 6110]], 'reconstruction matches publication');
});

test('an old chunk with stretched words keeps its saved lines and still reconstructs its word times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-old-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional old meeting');
    const chunk = await store.addPcm(meeting.id, 'tab:call', 0, 0, 16000, Buffer.alloc(4 * 16000 * 20));
    const old = words(['Brindle', 100, 400], ['ferns', 450, 3800], ['wobble', 3900, 4200], ['softly.', 4300, 20000]);
    store.completeChunk(chunk.id, recognition('Brindle ferns wobble softly.', old));
    assert.deepEqual(lines(store.segments(meeting.id)), [['Brindle ferns wobble softly.', 100, 20000]], 'saved as the old code saved it');
    assert.deepEqual(lines(wordSegments(20_000, old)), lines(store.segments(meeting.id)));
    assert.deepEqual(store.recentCallWords(meeting.id, new Set(['tab:call']), 0), old.map(w => ({ text: w.text, startMs: w.t0Ms, endMs: w.t1Ms })));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the echo rule still hides a doubled Me line when both channels have capped word times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-echo-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional lantern call');
    const text = 'copper lanterns glow amber tonight.';
    const said = (shift: number, end: number) => words(['copper', shift, shift + 300], ['lanterns', shift + 400, shift + 700],
      ['glow', shift + 800, shift + 1100], ['amber', shift + 1200, shift + 1500], ['tonight.', shift + 1600, end]);
    const call = await store.addPcm(meeting.id, 'app:call', 0, 4500, 16000, Buffer.alloc(4 * 16000 * 6));
    store.completeChunk(call.id, recognition(text, capPass({ text, words: said(0, 6000) }, 6000).words));
    const mic = await store.addPcm(meeting.id, 'mic:room', 0, 4000, 16000, Buffer.alloc(4 * 16000 * 8));
    store.completeChunk(mic.id, recognition(text, capPass({ text, words: said(600, 8000) }, 8000).words));
    const all = store.db.prepare('SELECT source, startMs, endMs FROM segments WHERE meetingId=? ORDER BY source').all(meeting.id);
    assert.deepEqual(all.map(s => ({ ...s })), [{ source: 'app:call', startMs: 4500, endMs: 6820 }, { source: 'mic:room', startMs: 4600, endMs: 6920 }]);
    assert.deepEqual(store.segments(meeting.id).map(s => s.source), ['app:call'], 'the Me echo is hidden');
    assert.equal(store.recentCallWords(meeting.id, new Set(['app:call']), 0).at(-1)!.endMs, 6820);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('numbers get 300 ms per digit or symbol (400–2500 ms), acronyms 300 ms per letter (400–2000 ms)', () => {
  assert.equal(wordCapMs('2.1.3'), 900, 'three digits; the dots are not counted');
  assert.equal(wordCapMs('42,'), 600);
  assert.equal(wordCapMs('7'), MIN_WORD_MS, 'at least one symbol, then the floor');
  assert.equal(wordCapMs('50%'), 900);
  assert.equal(wordCapMs('$1,250,000'), 2400, 'the currency sign and seven digits');
  assert.equal(wordCapMs('1234567890'), MAX_NUMBER_MS);
  assert.equal(wordCapMs('AB12'), 600, 'a word with a digit is counted as a number');
  assert.equal(wordCapMs('NASA'), 1200);
  assert.equal(wordCapMs('U.S.'), 600, 'non-letters are removed first');
  assert.equal(wordCapMs('FBI.'), 900);
  assert.equal(wordCapMs('ABCDEF'), 1800);
  assert.equal(wordCapMs('ABCDEFG'), 630, 'seven letters are not an acronym');
  assert.equal(wordCapMs('I'), MIN_WORD_MS, 'one letter is not an acronym');
  assert.equal(wordCapMs('Ok'), MIN_WORD_MS, 'not all uppercase');
  assert.equal(wordCapMs('Maple'), 450);
  assert.equal(wordCapMs('你好'), MIN_WORD_MS, 'letters without case are not an acronym');
  assert.deepEqual(capWordEnd({ text: '2.1.3', t0Ms: 1000, t1Ms: 2100 }), { text: '2.1.3', t0Ms: 1000, t1Ms: 1900 });
  const said = { text: '2.1.3', t0Ms: 1000, t1Ms: 1800 };
  assert.equal(capWordEnd(said), said);
});

test('native segments are not shortened by blank words or by a word list with broken times', () => {
  const blank = { text: 'Quill hums', words: words([' ', 100, 300], ['', 400, 500]), segments: words(['Quill hums', 100, 900]) };
  assert.deepEqual(capPass(blank, 20_000).segments, blank.segments);
  assert.deepEqual(buildSegments(20_000, capPass(blank, 20_000)), [{ startMs: 100, endMs: 900, text: 'Quill hums', timing: 'segment' }]);
  for (const broken of [words(['Quill', 100, 300], ['hums', NaN, 800]), words(['Quill', 100, 300], ['hums', 2000, 1500]),
    words(['Quill', 100, 300], ['hums', 400, Infinity])]) {
    const pass = { text: 'Quill hums', words: broken, segments: words(['Quill hums', 100, 3000]) };
    assert.deepEqual(capPass(pass, 20_000).segments, pass.segments);
    assert.deepEqual(buildSegments(20_000, capPass(pass, 20_000)), [{ startMs: 100, endMs: 3000, text: 'Quill hums', timing: 'segment' }]);
  }
});

test('native segments are shortened exactly when publication would use the word times', () => {
  const segments = words(['Quill hums', 100, 5000]);
  for (const [why, list] of [['backwards by more than 250 ms', words(['Quill', 1000, 1300], ['hums', 600, 900])],
    ['past the window', words(['Quill', 100, 300], ['hums', 20_500, 20_600])]] as const) {
    assert.equal(usableTimes(list, 20_000), false, why);
    const pass = { text: 'Quill hums', words: list, segments };
    assert.deepEqual(capPass(pass, 20_000).segments, segments, why);
    assert.deepEqual(buildSegments(20_000, capPass(pass, 20_000)), [{ startMs: 100, endMs: 5000, text: 'Quill hums', timing: 'segment' }], why);
  }
  const drift = words(['Quill', 100, 300], ['hums', 1000, 900]);
  assert.equal(usableTimes(drift, 20_000), true, 'a 100 ms end-before-start drift is tolerated');
  assert.deepEqual(capPass({ text: 'Quill hums', words: drift, segments }, 20_000).segments, words(['Quill hums', 100, 900]));
});

test('a 1–2 word sentence stays with the next one across a 200 ms pause and splits at 500 ms', () => {
  const said = (next: number) => words(['Okay.', 0, 300], ['maple', next, next + 300], ['drifts', next + 350, next + 600], ['north.', next + 650, next + 900]);
  const text = 'Okay. maple drifts north.';
  assert.deepEqual(lines(buildSegments(20_000, { text, words: capPass({ text, words: said(500) }, 20_000).words })), [['Okay. maple drifts north.', 0, 1400]]);
  assert.deepEqual(lines(buildSegments(20_000, { text, words: capPass({ text, words: said(800) }, 20_000).words })),
    [['Okay.', 0, 300], ['maple drifts north.', 800, 1700]]);
});

test('lines saved under the earlier 150 ms short-sentence rule still reconstruct their word times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-short-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional short sentence');
    const chunk = await store.addPcm(meeting.id, 'mic:room', 0, 0, 16000, Buffer.alloc(4 * 16000 * 20));
    const said = words(['Okay.', 0, 300], ['maple', 550, 800], ['drifts', 850, 1100], ['north.', 1150, 1400]);
    store.completeChunk(chunk.id, recognition('Okay. maple drifts north.', said));
    assert.deepEqual(lines(store.db.prepare('SELECT text, startMs, endMs FROM segments WHERE chunkId=?').all(chunk.id) as never),
      [['Okay. maple drifts north.', 0, 1400]], 'the current rule keeps the short sentence attached');
    const earlier = wordSegments(20_000, said, EARLIER_SHORT_SENTENCE_PAUSE_MS);
    assert.deepEqual(lines(earlier), [['Okay.', 0, 300], ['maple drifts north.', 550, 1400]]);
    store.db.prepare('DELETE FROM segments WHERE chunkId=?').run(chunk.id);
    const insert = store.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    earlier.forEach((s, ord) => insert.run(`${chunk.id}:${ord}`, meeting.id, chunk.id, 'mic:room', ord, s.startMs, s.endMs, s.text, s.text, 'word'));
    assert.deepEqual(store.recentCallWords(meeting.id, new Set(['mic:room']), 0).map(w => [w.text, w.startMs, w.endMs]),
      said.map(w => [w.text, w.t0Ms, w.t1Ms]), 'each saved line finds its own words');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the echo rule at a capture edge reads capped word times: a pre-call word no longer stretches into the call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-edge-'));
  const store = new MeetingStore(directory);
  try {
    const rest = 'paper lamps turn amber shades beside folded copper frames after sunset today'.split(' ');
    // Meeting times; the mic chunk starts at 3000 and the call at 4500. "please" is said at 4000, before the call starts.
    const said = [{ text: 'please', t0Ms: 4000, t1Ms: 5050 }, ...rest.map((text, i) => ({ text, t0Ms: 5150 + i * 350, t1Ms: 5350 + i * 350 }))];
    const text = said.map(w => w.text).join(' ');
    const run = async (micWords: Word[]) => {
      const meeting = store.createMeeting('Fictional lamp call');
      const mic = await store.addPcm(meeting.id, 'mic:room', 0, 3000, 16000, Buffer.alloc(4 * 16000 * 8));
      store.completeChunk(mic.id, recognition(text, micWords.map(w => ({ ...w, t0Ms: w.t0Ms - 3000, t1Ms: w.t1Ms - 3000 }))));
      const call = await store.addPcm(meeting.id, 'app:call', 0, 4500, 16000, Buffer.alloc(4 * 16000 * 6));
      store.completeChunk(call.id, recognition(rest.join(' '), [], { audioSeconds: 6, timestampKind: 'chunk' }));
      return meeting.id;
    };
    const stretched = await run(said);
    assert.equal(store.segments(stretched).some(s => s.source === 'mic:room'), false, 'the stretched word looked as if it were inside the call');
    const capped = await run(capPass({ text, words: said }, 20_000).words);
    const line = store.db.prepare("SELECT startMs, endMs, timing FROM segments WHERE meetingId=? AND source='mic:room'").get(capped);
    assert.deepEqual({ ...line }, { startMs: 4000, endMs: 9200, timing: 'word' }, 'one line, not fully inside the call');
    assert.deepEqual(store.recentCallWords(capped, new Set(['mic:room']), 0)[0], { text: 'please', startMs: 4000, endMs: 4540 });
    assert.equal(store.segments(capped).some(s => s.source === 'mic:room'), true, 'the unmatched pre-call word keeps the Me line visible');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a 1–2 word Me line is hidden only as a time-aligned continuation of a hidden echo right next to it', () => {
  const roles = rolesFor([{ source: 'mic:room', startMs: 0, endMs: 60000 }, { source: 'app:call', startMs: 0, endMs: 60000 }]);
  // One word every 400 ms from `at`, each lasting 300 ms.
  const line = (source: string, chunkId: string, ord: number, text: string, at: number, timed = true): EchoSegment => {
    const words = text.split(' ').map((word, i) => ({ text: word, startMs: at + i * 400, endMs: at + i * 400 + 300 }));
    return { id: `${chunkId}:${ord}`, chunkId, ord, source, text, startMs: at, endMs: words.at(-1)!.endMs, ...(timed ? { words } : {}) };
  };
  const me = (ord: number, text: string, at: number, timed = true, chunkId = 'mic') => line('mic:room', chunkId, ord, text, at, timed);
  const call = (ord: number, text: string, at: number, timed = true) => line('app:call', 'call', ord, text, at, timed);
  const hidden = (...all: EchoSegment[]) => [...echoesFor(all, roles)].sort();
  // The call says "Thank you." at 11000 and 11400; the echo of the sentence before it ends at 11050.
  const remote = call(0, 'The paper lantern is ready. Thank you.', 9000), echo = me(0, 'The paper lantern is ready.', 9150);
  assert.deepEqual(hidden(remote, echo, me(1, 'Thank you.', 11150)), ['mic:0', 'mic:1'], 'an echo tail 150 ms after the call words');
  assert.deepEqual(hidden(call(0, 'Okay. The paper lantern is ready.', 9000), me(0, 'Okay.', 9100), me(1, 'The paper lantern is ready.', 9500)),
    ['mic:0', 'mic:1'], 'an echo head before the echo');
  const okay = call(0, 'The paper lantern is ready. Okay.', 9000);
  assert.deepEqual(hidden(okay, echo, me(1, 'Okay.', 11200)), ['mic:0', 'mic:1'], 'the same word at the same moment (200 ms) is an echo tail');
  assert.deepEqual(hidden(okay, echo, me(1, 'Okay.', 11600)), ['mic:0'], 'a reply 600 ms after the call said the same word stays');
  // The echoed question already matched "on Tuesday"; the reply reuses those call words, at times that align with them.
  assert.deepEqual(hidden(call(0, 'Okay, should we plant on Tuesday?', 20000), me(0, 'Okay, should we plant on Tuesday?', 20100),
    me(1, 'On Tuesday.', 22000)), ['mic:0'], 'a reply reusing words of the echoed question stays');
  assert.deepEqual(hidden(call(0, 'The paper lantern is ready.', 9000), echo, call(1, 'Thank you.', 14900), me(1, 'Thank you.', 15000)), ['mic:0'],
    'a reply after a long silence stays, although its ord is adjacent and the call said the same words then');
  assert.deepEqual(hidden(remote, echo, me(1, 'Thank you.', 11150, false)), ['mic:0'], 'no word times for the short line');
  assert.deepEqual(hidden(call(0, remote.text, 9000, false), echo, me(1, 'Thank you.', 11150)), ['mic:0'], 'no word times for the call');
  assert.deepEqual(hidden(remote, me(1, 'Thank you.', 11150)), [], 'never on its own');
  assert.deepEqual(hidden(remote, me(0, 'I prefer a round green lantern.', 9150), me(1, 'Thank you.', 11150)), [], 'the neighbouring line is genuine');
  assert.deepEqual(hidden(remote, echo, me(1, 'Yes please.', 11150)), ['mic:0'], 'a genuine reply beside an echo');
  assert.deepEqual(hidden(remote, echo, me(1, 'you thank', 11150)), ['mic:0'], 'words must continue the match in order');
  assert.deepEqual(hidden(remote, echo, me(1, 'Thank you.', 11150, true, 'other')), ['mic:0'], 'another chunk');
  assert.deepEqual(hidden(remote, echo, me(2, 'Thank you.', 11150)), ['mic:0'], 'not adjacent');
});

test('the transcript view hands a stretched preview word to the final line that holds its capped end', () => {
  const final = { startMs: 2000, endMs: 4330 }; // "maple drifts onward." with "onward." from 3700, capped at 4330
  const stretched = { text: 'onward.', startMs: 3700, endMs: 9000 };
  assert.equal(coversTime(final, midpoint(stretched)), false, 'the stretched midpoint falls after the final line');
  assert.equal(handoffAt(stretched), 3900);
  assert.equal(coversTime(final, handoffAt(stretched)), true);
  // Final lines: "Okay." from 1000, capped at 1450, then a pause; "no." from 1000, capped at 1400, then the next line.
  const ownLine = { startMs: 1000, endMs: 1450 };
  assert.equal(coversTime(ownLine, handoffAt({ startMs: 1000, endMs: 6000 })), true, '"Okay." hands off to its own line');
  for (const pauseMs of [150, 400]) {
    const next = { startMs: 1400 + pauseMs, endMs: 3000 };
    const at = handoffAt({ startMs: 1000, endMs: 3000 });
    assert.equal(coversTime(next, at), false, `"no." before a ${pauseMs} ms pause does not hand off to the next line`);
    assert.equal(coversTime({ startMs: 1000, endMs: 1400 }, at), true);
  }
  const plain = { text: 'maple', startMs: 2000, endMs: 2300 };
  assert.equal(handoffAt(plain), midpoint(plain), 'an ordinary word uses its midpoint');
  assert.equal(handoffAt({ startMs: 5000, endMs: 5000 }), 5000);
});
