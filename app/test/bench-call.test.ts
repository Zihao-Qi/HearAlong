// Pure parts of npm run bench:call, with fictional words and synthetic audio only: no corpus, model, server or browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallArgs } from '../scripts/bench/cli.ts';
import { blockAt, callLayout, farBlocks, hiddenGenuine, layoutSamples, linePieces, mixMicrophone, nearBlocks, pcm16Wav, placeClips, planClips,
  power, roomTaps, scoreCall, speakerEcho, stateOf, sumCallScores, wallToMeetingMs, PAIRS, ROOM_VERSION, type Line } from '../scripts/bench/call-mix.ts';
import { firstSample } from '../scripts/bench/call-helper.ts';
import { parseWav } from '../scripts/rehearsal-input.ts';
import { parseResult, type CallFile } from '../scripts/bench/results.ts';
import { renderBench } from '../scripts/bench/report.ts';
import type { ReferenceWord } from '../scripts/bench/ami.ts';

test('call layout repeats echo only, near only, double talk in 20 s blocks after a lead', () => {
  const full = callLayout(6);
  assert.deepEqual(farBlocks(full), [0, 2, 3, 5]);
  assert.deepEqual(nearBlocks(full), [1, 2, 4, 5]);
  assert.deepEqual([0, 1, 2, 3].map(stateOf), ['echoOnly', 'nearOnly', 'doubleTalk', 'echoOnly']);
  const smoke = callLayout(3);
  assert.equal(layoutSamples(smoke), (6 + 60 + 4) * 16000);
  assert.equal(blockAt(smoke, 5.99), null);
  assert.equal(blockAt(smoke, 6), 0);
  assert.equal(blockAt(smoke, 45.99), 1);
  assert.equal(blockAt(smoke, 66), null);
  assert.throws(() => callLayout(4), /multiple of three/);
  assert.equal(PAIRS.length, 5);
  assert.ok(PAIRS.every(pair => pair.near.meeting !== pair.far.meeting));
});

test('utterances pack into their blocks in order; a clip too long waits, and a thin block fails', () => {
  const layout = callLayout(3);
  const clips = [{ start: 0, end: 30 }, ...Array.from({ length: 7 }, (_, i) => ({ start: 100 + i * 10, end: 106 + i * 10 }))];
  const planned = planClips(clips, [0, 2], layout);
  assert.equal(planned.length, 4, "two 6.2 s clips fit before 19.1 s of each block is used");
  assert.deepEqual(planned.slice(0, 2).map(clip => [Number(clip.start.toFixed(2)), Number(clip.at.toFixed(2))]), [[99.9, 6.3], [109.9, 12.85]]);
  assert.equal(Number(planned[2].at.toFixed(2)), 46.3);
  assert.ok(planned.every(clip => blockAt(layout, clip.at) === blockAt(layout, clip.at + clip.end - clip.start)));
  assert.throws(() => planClips([{ start: 0, end: 3 }], [0], layout), /Insufficient speech in block 0/);
});

test('placed clips fade in, carry their words, and reach 0.06 RMS over active audio', () => {
  const audio = new Float32Array(20 * 16000).fill(0.5);
  const words: ReferenceWord[] = [{ text: 'lantern', start: 1.2, end: 1.5, speaker: 'A' }, { text: 'outside', start: 5, end: 5.5, speaker: 'A' }];
  const placed = placeClips(audio, [{ start: 1, end: 2, at: 7 }], words, 10 * 16000);
  assert.deepEqual(placed.words.map(word => [word.text, Number(word.start.toFixed(3))]), [['lantern', 7.2]]);
  assert.equal(placed.pcm[7 * 16000], 0);
  assert.ok(placed.pcm[7 * 16000 + 800] > 0);
  assert.equal(placed.pcm[6 * 16000], 0);
  let sum = 0, count = 0;
  for (let pos = 0; pos < placed.pcm.length; pos += 160) { const p = power(placed.pcm, pos, pos + 160); if (p > 1e-7) { sum += p; count++; } }
  assert.ok(Math.abs(Math.sqrt(sum / count) - 0.06) < 1e-6);
});

test('the room tail is fixed, starts with the direct path, and ends by 80 ms', () => {
  const taps = roomTaps();
  assert.deepEqual(roomTaps(), taps);
  assert.equal(taps.length, 65);
  assert.deepEqual(taps[0], { samples: 0, gain: 1 });
  assert.equal(Math.max(...taps.map(tap => tap.samples)), 80 * 16);
  assert.ok(taps.slice(1).every(tap => Math.abs(tap.gain) < 1));
  assert.match(ROOM_VERSION, /seed7/);
  const impulse = new Float32Array(4000); impulse[0] = 1;
  const echo = speakerEcho(impulse, 10);
  const alpha = 1 - Math.exp(-2 * Math.PI * 3000 / 16000);
  assert.ok(echo.subarray(0, 160).every(value => value === 0), 'nothing before the delay');
  assert.ok(Math.abs(echo[160] - alpha) < 1e-6, 'the direct path, through the speaker low-pass');
  assert.ok(Math.abs(echo[160 + 80 * 16 + 300]) < 1e-3, 'the low-passed tail has died away');
});

test('the microphone mix sets the echo level, is deterministic, and never clips', () => {
  const n = 4 * 16000, near = new Float32Array(n), far = new Float32Array(n);
  let seed = 3;
  for (let i = 0; i < n; i++) {
    near[i] = 2 * Math.sin(i / 7) * (i < n / 2 ? 1 : 0.5);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; far[i] = seed / 2 ** 32 - 0.5;
  }
  const one = mixMicrophone(near, far, { delayMs: 50, gainDb: -10 }, 123), two = mixMicrophone(near, far, { delayMs: 50, gainDb: -10 }, 123);
  assert.deepEqual(one.mic, two.mic);
  assert.ok(one.room.commonScale < 1);
  assert.ok(Math.max(...one.mic.map(Math.abs)) <= 0.9 + 1e-6);
  assert.ok(Math.abs(one.call[100] - far[100] * one.room.commonScale) < 1e-7, 'the call source is the far audio, scaled with the mic');
  const echo = one.mic.map((value, i) => value - near[i] * one.room.commonScale);
  const ratio = 10 * Math.log10(power(echo) / power(near.map(value => value * one.room.commonScale)));
  assert.ok(Math.abs(ratio + 10) < 0.05, `echo ${ratio.toFixed(2)} dB below near`);
  assert.notDeepEqual(mixMicrophone(near, far, { delayMs: 50, gainDb: -10 }, 124).mic, one.mic);
  const wav = parseWav(pcm16Wav(one.mic));
  assert.equal(wav.format, 1); assert.equal(wav.sampleRate, 16000); assert.equal(wav.samples, n);
});

const layout = callLayout(3);
const timebase = { micZeroMs: 1000, callZeroMs: 1100 };
const ref = (text: string, start: number, speaker = 'A'): ReferenceWord[] => text.split(' ').map((word, i) => ({ text: word, start: start + i, end: start + i + 0.5, speaker }));
const farWords = [...ref('copper ribbon lantern cedar frame', 7), ...ref('amber spool', 47)];
const nearWords = [...ref('harbor reef shell kelp pebble', 27, 'B'), ...ref('harbor reef tide shell', 50, 'B')];
const me = (id: string, text: string, fileSeconds: number): Line => ({ id, source: 'mic:fictional', startMs: 1000 + fileSeconds * 1000, endMs: 1000 + fileSeconds * 1000 + 2000, text });
const them = (id: string, text: string, fileSeconds: number): Line => ({ id, source: 'app:fictional', startMs: 1100 + fileSeconds * 1000, endMs: 1100 + fileSeconds * 1000 + 2000, text });
const straddling: Line = { ...them('G', 'frame spool', 24), endMs: 1100 + 28000,
  words: [{ text: 'frame', startMs: 1100 + 24000, endMs: 1100 + 24500 }, { text: 'spool', startMs: 1100 + 27000, endMs: 1100 + 27500 }] };
const lines = [me('A', 'copper ribbon lantern cedar', 8), me('B', 'harbor reef shell kelp pebble', 27), me('C', 'harbor reef tide', 50),
  me('D', 'amber shell', 53), me('E', 'pebble', 2), them('F', 'copper ribbon lantern cedar', 7), straddling, them('H', 'amber spool', 47)];
const shown = new Set(['B', 'D', 'E', 'F', 'G', 'H']);
const score = scoreCall({ layout, timebase, nearWords, farWords, lines, shown });

test('a line with word times splits at block edges by word start; one without goes by its start', () => {
  assert.deepEqual(linePieces(layout, timebase, straddling), [{ block: 0, text: 'frame' }, { block: 1, text: 'spool' }]);
  // Without words, a window's stretched last word cannot drag a line into the next block: only the start counts.
  assert.deepEqual(linePieces(layout, timebase, { ...them('X', 'frame', 24), endMs: 1100 + 45000 }), [{ block: 0, text: 'frame' }]);
  assert.deepEqual(linePieces(layout, timebase, me('E', 'pebble', 2)), [{ block: null, text: 'pebble' }]);
});

test('echo-only blocks: the rule hides echo lines, raw shows the leak, Them is scored', () => {
  const s = score.echoOnly;
  assert.equal(s.me.referenceWords, 0); assert.equal(s.me.insertions, 0);
  assert.equal(s.meRaw.insertions, 4);
  assert.deepEqual(s.leak, { farWords: 5, matched: 0, meWords: 0, rate: 0 });
  assert.deepEqual(s.leakRaw, { farWords: 5, matched: 4, meWords: 4, rate: 0.8 });
  assert.deepEqual(s.hidden, { lines: 1, words: 4, genuine: 0, recognizedGenuine: 0 });
  assert.equal(s.them.hits, 5); assert.equal(s.them.wer, 0);
});

test('near-only and double talk: Me WER on the shown view, hidden genuine words, far words in Me', () => {
  assert.equal(score.nearOnly.me.wer, 0);
  assert.equal(score.nearOnly.them.insertions, 1, 'the straddling Them word lands in the near-only block');
  assert.deepEqual(score.nearOnly.hidden, { lines: 0, words: 0, genuine: 0, recognizedGenuine: 5 });
  const s = score.doubleTalk;
  assert.equal(s.me.hits, 1); assert.equal(s.me.wer, 0.75);
  assert.equal(s.meRaw.hits, 4); assert.equal(s.meRaw.insertions, 1);
  assert.deepEqual(s.hidden, { lines: 1, words: 3, genuine: 3, recognizedGenuine: 4 });
  assert.deepEqual(s.leak, { farWords: 2, matched: 1, meWords: 2, rate: 0.5 });
  assert.equal(s.leakRaw.meWords, 5);
  assert.equal(s.them.wer, 0);
  assert.deepEqual(score.outside, { meWords: 1, themWords: 0, lines: 1 });
  assert.equal(score.straddling, 1);
});

test('hidden genuine words follow one alignment; scores sum across pairs', () => {
  const raw = [me('p', 'harbor reef', 27), me('q', 'harbor tide', 30)];
  assert.deepEqual(hiddenGenuine('harbor reef tide', raw, new Set(['p'])), { lines: 1, words: 2, genuine: 1, recognizedGenuine: 3 });
  assert.deepEqual(hiddenGenuine('', raw, new Set()), { lines: 2, words: 4, genuine: 0, recognizedGenuine: 0 });
  const both = sumCallScores([score, score]);
  assert.equal(both.doubleTalk.me.referenceWords, 8); assert.equal(both.doubleTalk.me.wer, 0.75);
  assert.equal(both.echoOnly.leakRaw.rate, 0.8);
  assert.equal(both.doubleTalk.hidden.genuine, 6);
  assert.equal(both.straddling, 2);
});

test('wall-to-meeting offsets use the median frame; the helper starts at the sample being played', () => {
  assert.equal(wallToMeetingMs([{ startMs: 0, captureWallMs: 5000 }, { startMs: 1000, captureWallMs: 6010 }, { startMs: 2000, captureWallMs: 7000 }]), -5000);
  assert.equal(wallToMeetingMs([]), null);
  assert.equal(firstSample(1000, 1500), 8000);
  assert.equal(firstSample(1000, 900), 0);
  assert.equal(firstSample(1000, 1000.01), 1);
});

test('call flags: five pairs of six blocks by default; --smoke is one pair and one block of each state', () => {
  assert.deepEqual(parseCallArgs([], 5), { pairs: [1, 2, 3, 4, 5], blocks: 6, smoke: false, label: null, allowDirty: false });
  assert.deepEqual(parseCallArgs(['--smoke'], 5), { pairs: [1], blocks: 3, smoke: true, label: null, allowDirty: false });
  assert.deepEqual(parseCallArgs(['--smoke', '--pairs', '3,2', '--run-label', 'x', '--allow-dirty'], 5), { pairs: [3], blocks: 3, smoke: true, label: 'x', allowDirty: true });
  assert.throws(() => parseCallArgs(['--pairs', '6'], 5), /1 to 5/);
  assert.throws(() => parseCallArgs(['--smoke', '--smoke'], 5), /Repeated/);
  assert.throws(() => parseCallArgs(['--minutes', '1'], 5), /Unknown/);
});

const point = (value: number, n = 4) => ({ mean: value, p50: value, p95: value, max: value, n });
function callRun(createdAt = '2026-01-02T00:00:00Z', error: string | null = null): CallFile {
  const lag = { me: { preview: point(3000), final: point(9000) }, them: { preview: point(2500), final: point(11000) } };
  const pair = { name: 'pair-1', pair: 'FictionA.B+FictionB.A', delayMs: 30, gainDb: -6, audioSeconds: 70, error, failedChunks: 0, unfinishedChunks: 0,
    score, lag, diagnostic: lag, aec: { micFrames: 70, aecFrames: 68, failures: 0, referenceCoverage: 0.99, meanWaitMs: 1000, maxWaitMs: 1040, notices: [] },
    timebase: { micZeroMs: -31, callZeroMs: -11, clockOffsetMs: 0.5, callStartMs: 1500 } };
  return { commit: 'fictional-commit', dirty: false, nodeVersion: 'v22.0.0', logicalCores: 8, macos: '99.0', chip: 'Fictional Chip', ramBytes: 16 * 2 ** 30,
    normalizer: 'hearalong-2', scoringCommit: 'fictional-commit', scoringDirty: false,
    model: 'fiction.gguf', modelIdentity: { basename: 'fiction.gguf', sha256: 'a'.repeat(64), bytes: 3 }, createdAt, runLabel: null, error,
    kind: 'call', failedChunks: 0, unfinishedChunks: 0, condition: { pairs: ['1:FictionA.B+FictionB.A'], blocks: 3, smoke: true, room: ROOM_VERSION },
    pairs: [pair], totals: { pairs: error ? 0 : 1, score: sumCallScores(error ? [] : [score]), lag, diagnostic: lag, aec: { micFrames: 70, aecFrames: 68, failures: 0, notices: 0 } } };
}

test('call results round-trip through JSON and render in their own section, idempotently', () => {
  const parsed = parseResult(JSON.parse(JSON.stringify(callRun())));
  assert.equal(parsed.kind, 'call');
  assert.equal(parsed.kind === 'call' && parsed.pairs[0].score.echoOnly.me.wer, 0);
  assert.equal(parsed.kind === 'call' && parsed.pairs[0].score.nearOnly.them.wer, Infinity, 'an empty reference with insertions survives JSON');
  const doc = 'A\n<!-- bench:begin -->\nold\n<!-- bench:end -->\nB\n<!-- bench-call:begin -->\nold\n<!-- bench-call:end -->\nC\n';
  const runs = [callRun(), callRun('2026-01-03T00:00:00Z'), callRun('2026-01-04T00:00:00Z', 'pair-1: fictional failure')];
  const once = renderBench(doc, runs);
  assert.equal(renderBench(once, runs), once);
  const [main, call] = once.split('<!-- bench-call:begin -->');
  assert.match(main, /not yet measured/);
  assert.match(call, /### Call cohort 1/);
  assert.match(call, /3 runs; 2 finished/);
  assert.match(call, /Run 1 stopped early: pair-1: fictional failure/);
  assert.match(call, /Median Me double-talk WER across 2 eligible runs: 75\.00%/);
  assert.match(call, /\| 2 \| 1 \| 0\.00% \| 75\.00% \| 0 \| 0 of 5 \(0\.00%\) \| 1 of 2 \(50\.00%\) \| 3 of 9 \(33\.33%\) \|/);
  assert.match(call, /\| 2 \| Echo only \| 1 \| 4 \| 4 of 5 \(80\.00%\) \| 0 of 5 \(0\.00%\) \| 0 \| n\/a \| n\/a \|/);
  assert.match(once, /^C$/m);
  assert.match(renderBench(doc, []), /bench-call:begin -->\nnot yet measured\n/);
  const plain = '<!-- bench:begin -->\nold\n<!-- bench:end -->';
  assert.equal(renderBench(plain, []), '<!-- bench:begin -->\nnot yet measured\n<!-- bench:end -->', 'a document without the call section is left as it was');
  assert.throws(() => renderBench(plain, [callRun()]), /bench-call:begin/);
});
