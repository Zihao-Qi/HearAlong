import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LagMeter } from '../scripts/lag-meter.ts';
import { ANNOTATIONS_URL, SC_MEETINGS, benchPaths, reference, referenceText } from '../scripts/bench/ami.ts';
import { downloadAction, planFetches, wordsOutputName } from '../scripts/bench/ami-fetch.ts';
import { clockToSeconds, parseLiveArgs, parseWerArgs } from '../scripts/bench/cli.ts';
import { classifyWords, scoreBreakdown } from '../scripts/bench/breakdown.ts';
import { planIhm, readSegments, speakerChannels } from '../scripts/bench/ihm.ts';
import { rescore } from '../scripts/bench/rescore.ts';
import { loadResults, renderBench } from '../scripts/bench/report.ts';
import { parseResult, type LiveFile, type WerFile, type WerSession } from '../scripts/bench/results.ts';
import { parsePs, serverUsage, speechWorkerUsage } from '../scripts/bench/ps.ts';
import { applySnapshot, domSight, frameEndMs, headlineLagWarning, mergeSights, rememberSegmentEnds, spokenAt, spokenFrame, visibleLags } from '../scripts/bench/snapshot.ts';
import { medianSpread, percentile, summarize } from '../scripts/bench/stats.ts';
import { align, backtrace, corpusWer, normalize, normalizeReference, wer } from '../scripts/bench/wer.ts';

const werScript = fileURLToPath(new URL('../scripts/bench/wer.ts', import.meta.url));
const benchmarks = fileURLToPath(new URL('../../docs/benchmarks.md', import.meta.url));

test('SC set and both microphone paths are fixed', () => {
  assert.deepEqual([...SC_MEETINGS], [
    'ES2004a', 'ES2004b', 'ES2004c', 'ES2004d',
    'IS1009a', 'IS1009b', 'IS1009c', 'IS1009d',
    'TS3003a', 'TS3003b', 'TS3003c', 'TS3003d',
    'EN2002a', 'EN2002b', 'EN2002c', 'EN2002d',
  ]);
  const root = join(tmpdir(), 'bench-paths');
  const paths = benchPaths(root);
  assert.equal(paths.wav('ES2004a', 'Mix-Headset'), join(root, 'ami', 'audio', 'ES2004a', 'ES2004a.Mix-Headset.wav'));
  assert.equal(paths.wordsFile('ES2004a', 'A'), join(root, 'ami', 'annotations', 'words', 'ES2004a.A.words.xml'));
});

test('normalizer folds case, punctuation, apostrophes, hyphens, and spaces', () => {
  assert.deepEqual(normalize('  Hello,   WORLD! '), ['hello', 'world']);
  assert.deepEqual(normalize("Don't stop"), ['don\'t', 'stop']);
  assert.deepEqual(normalize("'quoted'"), ['quoted']);
  assert.deepEqual(normalize('well-known trail'), ['well', 'known', 'trail']);
  assert.deepEqual(normalize('well--known'), ['well', 'known']);
  assert.deepEqual(normalize('well—known'), ['well', 'known']);
  assert.deepEqual(normalize('It’s a “fine” day.'), ['it\'s', 'a', 'fine', 'day']);
  assert.deepEqual(normalize('too    many   spaces'), ['too', 'many', 'spaces']);
  assert.deepEqual(normalize('Ｈｅｌｌｏ'), ['hello']);
  assert.equal(wer('Hello,  WORLD!', 'hello world').wer, 0);
});

test('AMI letter tokens join, including plurals, without joining other underscore words', () => {
  assert.deepEqual(normalize('T_V_ L_C_D_ R_S_I_ P_C_B_ T_V_s'), ['tv', 'lcd', 'rsi', 'pcb', 'tvs']);
  assert.equal(wer('The T_V_s work', 'the TVs work').wer, 0);
  assert.equal(wer('TV', 'T_V_').wer, 0);
  assert.deepEqual(normalize('uh_huh uh-huh huh ice_cream T_V_set T_V_S'), ['huh', 'ice', 'cream', 't', 'v', 'set', 't', 'v', 's']);
  assert.deepEqual(normalize('T_V_', 'hearalong-1'), ['t', 'v']);
});

test('Whisper spelling dictionary is symmetric and does not stem unrelated words', () => {
  assert.equal(wer('The programme recogniser likes colour', 'the program recognizer likes color').wer, 0);
  assert.equal(wer('color', 'colour').wer, 0);
  assert.deepEqual(normalize('catalogue aluminium theatre zebra'), ['catalog', 'aluminum', 'theater', 'zebra']);
  assert.deepEqual(normalize('programme', 'hearalong-1'), ['programme']);
});

test('word attribution preserves global paired-filler removal and number expansion', () => {
  const words = ['uh', 'huh', 'A', '12', 'T_V_'].map((text, index) => ({ text, index }));
  assert.deepEqual(normalizeReference(words), [{ text: 'a', index: 2 }, { text: 'twelve', index: 3 }, { text: 'tv', index: 4 }]);
  assert.deepEqual(normalizeReference(words).map(word => word.text), normalize(words.map(word => word.text).join(' ')));
});

test('backtrace ties, insertion ownership, and empty reference are deterministic', () => {
  assert.deepEqual(backtrace(['a', 'b'], ['extra', 'a', 'b', 'tail']), [
    { kind: 'insertions', referenceIndex: 0, hypothesisIndex: 0 }, { kind: 'hits', referenceIndex: 0, hypothesisIndex: 1 },
    { kind: 'hits', referenceIndex: 1, hypothesisIndex: 2 }, { kind: 'insertions', referenceIndex: 1, hypothesisIndex: 3 },
  ]);
  assert.deepEqual(backtrace([], ['word']), [{ kind: 'insertions', referenceIndex: null, hypothesisIndex: 0 }]);
  assert.equal(backtrace(['a'], ['b'])[0].kind, 'substitutions');
});

test('word classes handle speaker overlap, strict gap/turn bounds, and inclusive chunk edges', () => {
  const w = (text: string, start: number, end: number, speaker = 'A') => ({ text, start, end, speaker });
  const words = [w('one', 18, 18.2), w('two', 19, 19.2), w('three', 20, 20.2), w('four', 21, 21.2),
    w('five', 22.7, 23), w('six', 23.5, 24), w('other', 19.1, 19.3, 'B'), w('touch', 24, 25, 'C')];
  const flags = classifyWords(words);
  assert.deepEqual(flags.map(f => f.overlap), [false, true, false, false, false, false, true, false]);
  assert.deepEqual(flags.map(f => f.shortTurn), [false, false, false, false, true, true, true, true]);
  assert.deepEqual(flags.slice(0, 5).map(f => f.chunkEdge), [false, true, true, true, false]);
  const scored = scoreBreakdown(words.slice(0, 4), 'one extra two wrong');
  assert.deepEqual(scored.overall, wer('one two three four', 'one extra two wrong'));
  assert.deepEqual(scored.breakdown.singleSpeaker, scored.overall);
  const cross = scoreBreakdown([w('red', 0, 1), w('blue', 0, 1, 'B')], '');
  assert.equal(cross.breakdown.overlap.deletions, 2);
  assert.equal(cross.breakdown.overlapDeletionShare, 1);
  assert.equal(scoreBreakdown([], 'extra').overall.wer, Infinity);
});

test('digits from 0 to 9999 become English words and larger digit strings stay', () => {
  assert.deepEqual(normalize('Room 12'), ['room', 'twelve']);
  assert.deepEqual(normalize('2'), ['two']);
  assert.deepEqual(normalize('0'), ['zero']);
  assert.deepEqual(normalize('007'), ['seven']);
  assert.deepEqual(normalize('101'), ['one', 'hundred', 'one']);
  assert.deepEqual(normalize('2024'), ['two', 'thousand', 'twenty', 'four']);
  assert.deepEqual(normalize('10000'), ['10000']);
  assert.deepEqual(normalize('00010000'), ['00010000']);
  assert.deepEqual(normalize('２ boats'), ['two', 'boats']);
  assert.deepEqual(normalize('3.14'), ['three', 'fourteen']);
  assert.deepEqual(normalize('2,000'), ['two', 'zero']);
  assert.equal(wer('2 boats', 'two boats').wer, 0);
  assert.equal(wer('21 boats', 'twenty-one boats').wer, 0);
});

test('fillers drop after the hyphen split, including uh-huh and mm-hmm', () => {
  assert.deepEqual(normalize('uh the um boats'), ['the', 'boats']);
  assert.deepEqual(normalize('UH hello'), ['hello']);
  assert.deepEqual(normalize('uh-huh yes'), ['yes']);
  assert.deepEqual(normalize('uh_huh yes'), ['yes']);
  assert.deepEqual(normalize('mm-hmm yes'), ['yes']);
  assert.deepEqual(normalize('hmm mm mhm ah eh oh'), []);
  assert.deepEqual(normalize('huh'), ['huh']);
  assert.equal(wer('oh no', 'no').wer, 0);
  assert.equal(wer('uh-huh the boats', 'the boats').wer, 0);
});

test('WER counts substitutions, deletions, insertions, and an empty reference', () => {
  const swapped = wer('The red boat left', 'The blue boat left');
  assert.equal(swapped.substitutions, 1);
  assert.equal(swapped.hits, 3);
  assert.equal(swapped.wer, 1 / 4);
  assert.equal(wer('The red boat left', 'The boat left').deletions, 1);
  assert.equal(wer('The boat left', 'The red boat left').insertions, 1);
  assert.equal(wer('', '').wer, 0);
  const infinite = wer('', 'hello there');
  assert.equal(infinite.wer, Infinity);
  assert.equal(infinite.insertions, 2);
  assert.deepEqual(align(['the', 'cat', 'sat'], ['cat', 'sat']), { substitutions: 0, deletions: 1, insertions: 0, hits: 2 });
});

test('corpus WER sums errors and is not the mean of the rates', () => {
  const pairs = [
    { reference: '2 boats left the dock', hypothesis: 'two boats left the dock' },
    { reference: 'Alpha', hypothesis: 'Beta' },
  ];
  const rates = pairs.map(pair => wer(pair.reference, pair.hypothesis).wer);
  const corpus = corpusWer(pairs);
  assert.deepEqual(rates, [0, 1]);
  assert.equal(corpus.referenceWords, 6);
  assert.equal(corpus.substitutions, 1);
  assert.equal(corpus.wer, 1 / 6);
  assert.notEqual(corpus.wer, (rates[0] + rates[1]) / 2);
});

test('WER CLI scores a file and rejects malformed JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wer-bench-'));
  try {
    const good = join(directory, 'pairs.json');
    writeFileSync(good, JSON.stringify([
      { id: 'boats', reference: '2 boats', hypothesis: 'two boats' },
      { id: 'alpha', reference: 'Alpha', hypothesis: 'Beta' },
    ]));
    const ok = spawnSync(process.execPath, ['--experimental-strip-types', werScript, good], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout) as { normalizer: string; items: { id: string; wer: number }[]; corpus: { wer: number; referenceWords: number } };
    assert.equal(parsed.normalizer, 'hearalong-2');
    assert.equal(parsed.items[0].wer, 0);
    assert.equal(parsed.items[1].wer, 1);
    assert.equal(parsed.corpus.referenceWords, 3);
    assert.equal(parsed.corpus.wer, 1 / 3);
    const bad = join(directory, 'broken.json');
    writeFileSync(bad, '{not json');
    const failed = spawnSync(process.execPath, ['--experimental-strip-types', werScript, bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Invalid JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('word XML is ordered across speakers, windowed, and drops punc, trunc, and non-words', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ami-words-'));
  try {
    const words = benchPaths(directory).words;
    mkdirSync(words, { recursive: true });
    const head = '<?xml version="1.0" encoding="ISO-8859-1"?>\n<nite:root xmlns:nite="http://nite.sourceforge.net/">\n';
    const tail = '</nite:root>\n';
    writeFileSync(join(words, 'Fiction1a.A.words.xml'), Buffer.concat([
      Buffer.from(`${head}<!-- <w starttime="9" endtime="9">hidden</w> -->\n`, 'ascii'),
      Buffer.from('<vocalsound nite:id="v" starttime="0.1" endtime="0.2" type="laugh"/>\n', 'ascii'),
      Buffer.from('<w nite:id="p" starttime="0.4" endtime="0.4" punc="true">.</w>\n', 'ascii'),
      Buffer.from('<w nite:id="t" starttime="0.5" endtime="0.6" trunc="true">xx</w>\n', 'ascii'),
      Buffer.from('<disfmarker nite:id="d"/><gap nite:id="g" starttime="0.7" endtime="0.7"/>\n', 'ascii'),
      Buffer.from('<w nite:id="a" starttime="1" endtime="1.2">alpha</w>\n', 'ascii'),
      Buffer.from('<w nite:id="c" starttime="2" endtime="2.2">caf', 'ascii'),
      Buffer.from([0xe9]),
      Buffer.from('</w>\n<w nite:id="q" starttime="2.5" endtime="2.6">rock&#39;n</w>\n', 'ascii'),
      Buffer.from(tail, 'ascii'),
    ]));
    writeFileSync(join(words, 'Fiction1a.B.words.xml'), Buffer.from(
      `${head}<w starttime="1" endtime="1.1">beta</w><w starttime="3" endtime="3.2">gamma</w><w starttime="0.4" endtime="0.5">early</w>${tail}`,
      'ascii',
    ));
    const all = reference('Fiction1a', { root: directory });
    assert.deepEqual(all.map(word => word.text), ['early', 'alpha', 'beta', 'café', "rock'n", 'gamma']);
    assert.deepEqual(all.map(word => word.speaker), ['B', 'A', 'B', 'A', 'A', 'B']);
    const window = reference('Fiction1a', { root: directory, fromSec: 1, toSec: 3 });
    assert.deepEqual(window.map(word => `${word.speaker}:${word.text}`), ['A:alpha', 'B:beta', 'A:café', "A:rock'n"]);
    assert.equal(referenceText(window), "alpha beta café rock'n");
    assert.throws(() => reference('Fiction0', { root: directory }), /No word files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fetch plan lists the zip and both mics for every SC meeting', () => {
  const root = join(tmpdir(), 'ami-plan');
  const plan = planFetches(root);
  assert.equal(plan.length, 33);
  assert.equal(new Set(plan.map(item => item.dest)).size, 33);
  assert.ok(plan.every(item => item.dest.startsWith(root + sep)));
  const zip = plan.find(item => item.kind === 'annotations');
  assert.ok(zip);
  assert.equal(zip.url, ANNOTATIONS_URL);
  assert.equal(zip.dest, join(root, 'ami', 'download', 'ami_public_manual_1.6.2.zip'));
  const audio = plan.find(item => item.meetingId === 'ES2004a' && item.mic === 'Array1-01');
  assert.equal(audio?.url, 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2004a/audio/ES2004a.Array1-01.wav');
  assert.equal(audio?.dest, join(root, 'ami', 'audio', 'ES2004a', 'ES2004a.Array1-01.wav'));
  for (const meetingId of SC_MEETINGS) for (const mic of ['Mix-Headset', 'Array1-01'] as const) {
    assert.ok(plan.some(item => item.meetingId === meetingId && item.mic === mic));
  }
  assert.equal(wordsOutputName('corpus/words/Fiction.A.words.xml'), 'Fiction.A.words.xml');
  assert.equal(wordsOutputName('segments/Fiction.A.words.xml'), null);
  assert.equal(wordsOutputName('words/notes.txt'), null);
  assert.equal(wordsOutputName('/words/Fiction.A.words.xml'), null);
  assert.equal(wordsOutputName('words/../../Fiction.A.words.xml'), null);
  assert.equal(wordsOutputName('words/'), null);
  assert.equal(downloadAction({ exists: false, bytes: 0, sha256: null }, undefined), 'download');
  assert.equal(downloadAction({ exists: true, bytes: 4, sha256: 'abc' }, undefined), 'adopt');
  assert.equal(downloadAction({ exists: true, bytes: 4, sha256: 'abc' }, { bytes: 4, sha256: 'abc' }), 'skip');
  assert.equal(downloadAction({ exists: true, bytes: 4, sha256: 'abc' }, { bytes: 4, sha256: 'def' }), 'download');
});

test('runner flags select sessions, mics, and the live window', () => {
  const all = parseWerArgs([]);
  assert.equal(all.sessions.length, 16);
  assert.deepEqual(all.mics, ['Mix-Headset', 'Array1-01']);
  const one = parseWerArgs(['--sessions', 'ES2004a,IS1009b', '--mic', 'Array1-01', '--run-label', 'pilot']);
  assert.deepEqual(one.sessions, ['ES2004a', 'IS1009b']);
  assert.deepEqual(one.mics, ['Array1-01']);
  assert.equal(one.label, 'pilot');
  assert.throws(() => parseWerArgs(['--sessions', 'not-a-meeting']), /Unknown session/);
  assert.equal(clockToSeconds('90:00'), 5400);
  const live = parseLiveArgs(['--session', 'TS3003c']);
  assert.equal(live.mic, 'Mix-Headset');
  assert.equal(live.from, '0:00');
  assert.equal(live.fromSec, 0);
  assert.equal(live.minutes, 10);
  assert.throws(() => parseLiveArgs([]), /Usage/);
  assert.throws(() => parseLiveArgs(['--session', 'ES2004a', '--from', '1:60']), /M:SS/);
});

test('percentiles interpolate and three runs use the middle value', () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.equal(percentile([10, 20, 30], 100), 30);
  assert.equal(percentile([10], 95), 10);
  assert.throws(() => percentile([], 50), /No values/);
  const summary = summarize([10, 20, 30, 40]);
  assert.equal(summary.n, 4);
  assert.equal(summary.mean, 25);
  assert.equal(summary.p50, 25);
  assert.equal(summary.max, 40);
  assert.deepEqual(medianSpread([0.25, 0.75, 0.5]), { median: 0.5, min: 0.25, max: 0.75, n: 3 });
  assert.equal(medianSpread([1, 2, 3, 4]).median, 2.5);
});

test('ps output splits the server from speech workers and skips Chrome', () => {
  const text = [
    '  10   1  1.5  2000 /usr/bin/node server',
    '  11  10  4.0  8000 /tmp/chrome',
    '  12  10  10.0  3000 node stt-worker.ts /models/x',
    '  13  12  2.5  500 ffmpeg',
    '  14  10  8.0  4000 node stt-stream-worker.ts /models/x',
    '  15   1  0.0  10 unrelated',
    '',
    'not a process line',
  ].join('\n');
  const rows = parsePs(text);
  assert.equal(rows.length, 6);
  assert.deepEqual(serverUsage(rows, 10), { cpu: 1.5, rssBytes: 2000 * 1024 });
  assert.equal(serverUsage(rows, 99), null);
  const workers = speechWorkerUsage(rows, 10);
  assert.deepEqual(workers.pids, [12, 13, 14]);
  assert.equal(workers.cpu, 20.5);
  assert.equal(workers.rssBytes, 7500 * 1024);
});

test('spoken time is the capture clock plus the sample offset', () => {
  const headers = { 'x-audio-source': 'mic:a', 'x-start-ms': '0', 'x-sample-rate': '16000', 'x-capture-wall-ms': '5000000' };
  const half = spokenFrame(headers, 8000 * 4);
  assert.deepEqual(half, { source: 'mic:a', startMs: 0, endMs: 500, captureWallMs: 5_000_000 });
  assert.equal(spokenAt([half!], 0), 5_000_000);
  assert.equal(spokenAt([half!], 250), 5_000_250);
  assert.equal(spokenAt([half!], 500), 5_000_500);
  assert.equal(spokenAt([half!], 501), 5_000_500);
  assert.equal(spokenAt([half!], 502), null);
  const next = spokenFrame({ ...headers, 'x-start-ms': '500', 'x-capture-wall-ms': '5000500' }, 16000 * 4);
  assert.equal(spokenAt([half!, next!], 500), 5_000_500);
  assert.equal(spokenAt([half!, next!], 1000), 5_001_000);
  const gap = spokenFrame({ ...headers, 'x-start-ms': '3000', 'x-capture-wall-ms': '5003000' }, 16000 * 4);
  assert.equal(spokenAt([half!, gap!], 2000), null);
  assert.equal(spokenFrame({ 'x-audio-source': 'mic:a', 'x-start-ms': '0', 'x-sample-rate': '16000' }, 64000), null);
  assert.equal(spokenFrame({ ...headers, 'x-capture-wall-ms': '0' }, 64000), null);
  assert.equal(spokenFrame({ ...headers, 'x-capture-wall-ms': 'nope' }, 64000), null);
  assert.equal(spokenFrame(headers, 0), null);
  assert.equal(domSight({ kind: 'preview', key: '', endMs: 1, at: 2 }), null);
  assert.equal(domSight({ kind: 'preview', key: 'draft', at: 2 }), null);
  assert.deepEqual(domSight({ kind: 'final', key: 'line', endMs: 1, at: 2 }), { kind: 'final', key: 'line', endMs: 1, at: 2 });
  assert.deepEqual(domSight({ kind: 'final', key: 'seg', at: 2 }), { kind: 'final', key: 'seg', endMs: null, at: 2 });
  assert.equal(domSight({ kind: 'final', key: 'seg', endMs: 'later', at: 2 }), null);
});

test('DOM sights become spoken-to-visible lag, and silence is not added', () => {
  const base = 100_000;
  const span = spokenFrame({
    'x-audio-source': 'mic:a', 'x-start-ms': '0', 'x-sample-rate': '16000', 'x-capture-wall-ms': String(base),
  }, 16000 * 5 * 4)!;
  const sights = [
    { kind: 'preview' as const, key: 'draft', endMs: 1000, at: base + 1800 },
    { kind: 'preview' as const, key: 'draft', endMs: 1000, at: base + 2000 },
    { kind: 'preview' as const, key: 'draft', endMs: 800, at: base + 2100 },
    { kind: 'preview' as const, key: 'draft', endMs: 4000, at: base + 4500 },
    { kind: 'final' as const, key: 'line-1', endMs: 4000, at: base + 9000 },
    { kind: 'final' as const, key: 'line-1', endMs: 4500, at: base + 9500 },
    { kind: 'final' as const, key: 'line-2', endMs: 9000, at: base + 12000 },
  ];
  assert.deepEqual(visibleLags([span], sights), { preview: [800, 500], final: [5000] });
  assert.deepEqual(visibleLags([span], [...sights].reverse()), { preview: [800, 500], final: [5000] });
  const tail = { kind: 'final' as const, key: 'line-3', endMs: 1000, at: base + 3000 };
  assert.deepEqual(mergeSights(sights.slice(0, 1), [sights[0], tail]), [sights[0], tail]);
});

test('a paragraph whose second segment appears later is its own final sample', () => {
  const base = 100_000;
  const span = spokenFrame({
    'x-audio-source': 'mic:a', 'x-start-ms': '0', 'x-sample-rate': '16000', 'x-capture-wall-ms': String(base),
  }, 16000 * 5 * 4)!;
  const ends = new Map<string, number>();
  rememberSegmentEnds({ segments: [{ id: 'seg-a', endMs: 1000 }, { id: 'nope' }, { id: 'seg-a', endMs: 1000 }] }, ends);
  rememberSegmentEnds({ segments: [{ id: 'seg-b', endMs: 2500 }] }, ends);
  assert.equal(ends.get('seg-a'), 1000);
  assert.equal(ends.get('seg-b'), 2500);
  assert.equal(ends.size, 2);
  // Two spans of one paragraph. Neither span has data-end; the snapshot map supplies each segment's end.
  const sights = [
    { kind: 'final' as const, key: 'seg-a', endMs: null, at: base + 2200 },
    { kind: 'final' as const, key: 'seg-b', endMs: null, at: base + 5000 },
    { kind: 'final' as const, key: 'seg-a', endMs: null, at: base + 8000 },
  ];
  assert.deepEqual(visibleLags([span], sights, ends), { preview: [], final: [1200, 2500] });
  assert.deepEqual(visibleLags([span], [...sights].reverse(), ends), { preview: [], final: [1200, 2500] });
  // The first sight's clock is the one that counts. A span with no end uses the map, and a later sight of that id adds nothing.
  assert.deepEqual(visibleLags([span], [
    { kind: 'final' as const, key: 'seg-a', endMs: null, at: base + 2200 },
    { kind: 'final' as const, key: 'seg-a', endMs: 4000, at: base + 9000 },
  ], new Map([['seg-a', 1000]])), { preview: [], final: [1200] });
  // An end attribute on the span wins over a different value in the map.
  assert.deepEqual(visibleLags([span], [
    { kind: 'final' as const, key: 'seg-a', endMs: 1000, at: base + 2200 },
  ], new Map([['seg-a', 4000]])), { preview: [], final: [1200] });
  assert.deepEqual(visibleLags([span], [{ kind: 'final' as const, key: 'seg-c', endMs: null, at: base + 3000 }]), { preview: [], final: [] });
});

test('a headline median more than 250 ms below the diagnostic is a warning', () => {
  assert.equal(headlineLagWarning('final', { p50: 1000, n: 10 }, { p50: 1250, n: 10 }), null);
  assert.equal(headlineLagWarning('final', { p50: 1000, n: 10 }, { p50: 1200, n: 10 }), null);
  assert.equal(headlineLagWarning('final', { p50: 2000, n: 9 }, { p50: 1500, n: 29 }), null);
  assert.equal(headlineLagWarning('final', { p50: 0, n: 0 }, { p50: 11807, n: 29 }), null);
  assert.equal(headlineLagWarning('preview', { p50: 1000, n: 4 }, { p50: 5000, n: 0 }), null);
  const low = headlineLagWarning('final', { p50: 7689, n: 9 }, { p50: 11807, n: 29 });
  assert.match(low ?? '', /Headline final p50 7689 ms is 4118 ms below the diagnostic p50 11807 ms/);
  const preview = headlineLagWarning('preview', { p50: 2485, n: 92 }, { p50: 1300, n: 183 });
  assert.equal(preview, null);
  assert.match(headlineLagWarning('preview', { p50: 1000, n: 4 }, { p50: 1251, n: 4 }) ?? '', /Headline preview p50 1000 ms is 251 ms below/);
});

test('a frame end and a snapshot become LagMeter samples', () => {
  const frame = frameEndMs({ 'x-audio-source': 'mic:a', 'x-start-ms': '0', 'x-sample-rate': '16000' }, 16000 * 4);
  assert.deepEqual(frame, { source: 'mic:a', endMs: 1000 });
  assert.equal(frameEndMs({ 'x-audio-source': 'mic:a', 'x-start-ms': '0', 'x-sample-rate': '16000' }, 0), null);
  const meter = new LagMeter();
  meter.audio(frame!.source, frame!.endMs, 5_000);
  const sample = applySnapshot(meter, {
    segments: [{ id: 's1', endMs: 1000 }, { id: 4 }],
    drafts: [
      { source: 'mic:a', window: 'w', windowStartMs: 0, coveredUntilMs: 1000 },
      { source: 'mic:a' },
    ],
  }, 6_500, 'mic:a');
  assert.deepEqual(sample.final, [1500]);
  assert.deepEqual(sample.preview, [1500]);
  assert.deepEqual(applySnapshot(meter, { segments: [{ id: 's1', endMs: 1000 }], drafts: [] }, 7_000, 'mic:a').final, []);
});

test('report generation replaces the marker section, keeps the outside, and is idempotent', () => {
  const doc = readFileSync(benchmarks, 'utf8');
  assert.equal(renderBench(renderBench(doc, []), []), renderBench(doc, []));
  assert.match(renderBench(doc, []), /not yet measured/);
  const directory = mkdtempSync(join(tmpdir(), 'bench-report-'));
  try {
    const source = 'Keep this.\n\n<!-- bench:begin -->\nold numbers\n<!-- bench:end -->\n\nAnd this.\n';
    const markdown = join(directory, 'benchmarks.md');
    writeFileSync(markdown, source);
    const files = [0, 1, 2].flatMap(index => [writeWer(directory, index), writeLive(directory, index)]);
    const once = renderBench(readFileSync(markdown, 'utf8'), loadResults(files));
    writeFileSync(markdown, once);
    const twice = renderBench(readFileSync(markdown, 'utf8'), loadResults(files));
    assert.equal(twice, once);
    assert.ok(twice.startsWith('Keep this.\n\n'));
    assert.ok(twice.endsWith('<!-- bench:end -->\n\nAnd this.\n'));
    assert.equal(twice.includes('old numbers'), false);
    assert.equal(twice.includes('not yet measured'), false);
    assert.match(twice, /AMI Meeting Corpus, CC BY 4\.0\. Carletta et al\., "The AMI Meeting Corpus", 2005\. https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
    assert.match(twice, /fiction\.gguf/);
    assert.match(twice, /abcdef1234567890/);
    assert.match(twice, /99\.0/);
    assert.match(twice, /Fictional Chip/);
    assert.match(twice, /2026-01-0[123]T03:04:05\.000Z/);
    assert.match(twice, /Median custom-normalized WER across 3 eligible runs: 50\.00% \(min 25\.00%, max 75\.00%\)\./);
    assert.match(twice, /Spoken to visible\./);
    assert.match(twice, /Median preview p50 across 3 eligible runs: 2\.00 s \(min 1\.00 s, max 3\.00 s\)\./);
    assert.match(twice, /Median final p50 across 3 eligible runs: 4\.00 s \(min 3\.00 s, max 5\.00 s\)\./);
    const headline = twice.indexOf('Spoken to visible.');
    const diagnostic = twice.indexOf('reached server to available on server');
    assert.ok(headline >= 0 && diagnostic > headline);
    assert.match(twice, /Clock offset \(page minus Node\), recorded and not used in the lag: 3\.0 ms, 2\.0 ms, 1\.0 ms\./);
    assert.match(twice, /Median diagnostic preview p50 across 3 eligible runs: 0\.50 s \(min 0\.40 s, max 0\.60 s\)\./);
    assert.match(twice, /Median diagnostic final p50 across 3 eligible runs: 0\.80 s \(min 0\.70 s, max 0\.90 s\)\./);
    assert.equal(twice.includes('lag warning'), false);
    assert.match(twice, /each saved segment/);
    const warned: LiveFile = {
      ...machine, kind: 'live', createdAt: '2026-01-04T03:04:05.000Z', runLabel: 'live', model: 'fiction.gguf', error: null,
      warning: 'Headline final p50 7689 ms is 4118 ms below the diagnostic p50 11807 ms (more than 250 ms).',
      meetingId: 'XX0000a', mic: 'Array1-01', fromSec: 90, minutes: 10, audioSeconds: 600, clockOffsetMs: null,
      preview: point(1000), final: point(7689),
      diagnostic: { preview: point(400), final: point(11807) },
      wer: { substitutions: 1, deletions: 0, insertions: 0, hits: 3, referenceWords: 4, wer: 0.25 },
      resources: { server: { cpu: point(5), rssBytes: point(100) }, speechWorker: { cpu: point(1), rssBytes: point(10) } },
    };
    const withWarning = renderBench('<!-- bench:begin -->\nold\n<!-- bench:end -->\n', [warned]);
    assert.match(withWarning, /Run 1 lag warning: Headline final p50 7689 ms is 4118 ms below the diagnostic p50 11807 ms \(more than 250 ms\)\./);
    const dropped = JSON.parse(JSON.stringify(warned)) as Record<string, unknown>;
    delete dropped.warning;
    const parsed = parseResult(dropped);
    assert.equal(parsed.kind === 'live' && parsed.warning, null);
    assert.match(twice, /Median server CPU mean across 3 eligible runs: 10\.0% \(min 5\.0%, max 15\.0%\)\./);
    assert.match(twice, /XX0000a/);
    assert.throws(() => parseResult({ kind: 'wer' }), /Invalid benchmark result/);
    writeFileSync(join(directory, 'broken.json'), '{');
    assert.throws(() => loadResults([join(directory, 'broken.json')]), /invalid JSON|Expected|JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rescore preserves transcription provenance, refuses missing sessions, and uses live saved text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-rescore-'));
  try {
    const file = writeWer(directory, 0), raw = JSON.parse(readFileSync(file, 'utf8'));
    const paths = benchPaths(directory);
    mkdirSync(paths.words, { recursive: true });
    writeFileSync(paths.wordsFile('XX0000a', 'A'), '<root><w starttime="0" endtime="1">T_V_</w><w starttime="1" endtime="2">programme</w><w starttime="2" endtime="3">works</w></root>');
    const work = join(paths.work, 'wer', '2026-01-01T03-04-05-000Z', 'XX0000a', 'Mix-Headset');
    assert.throws(() => rescore(raw, 'original.json', paths, { commit: 'scoring', dirty: true }), /Missing saved transcript/);
    mkdirSync(work, { recursive: true });
    const db = new DatabaseSync(join(work, 'meetings.sqlite'));
    db.exec("CREATE TABLE segments (text TEXT, startMs REAL, ord INTEGER); INSERT INTO segments VALUES ('TV program works', 0, 0)"); db.close();
    const next = rescore(raw, 'original.json', paths, { commit: 'scoring', dirty: true });
    assert.equal(next.commit, raw.commit); assert.equal(next.createdAt, raw.createdAt);
    assert.deepEqual(next.modelIdentity, raw.modelIdentity); assert.equal(next.dirty, raw.dirty);
    assert.equal(next.scoringCommit, 'scoring'); assert.equal(next.scoringDirty, true);
    assert.equal(next.rescoredFrom, 'original.json'); assert.equal(next.normalizer, 'hearalong-2');
    const parsed = parseResult(next); assert.ok(parsed.kind === 'wer');
    assert.equal(parsed.totals.wer, 0); assert.equal(parsed.totals.wallSeconds, raw.totals.wallSeconds);
    assert.equal(parsed.sessions[0].breakdown?.singleSpeaker.referenceWords, 3);
    raw.sessions.push({ ...raw.sessions[0], mic: 'Array1-01' });
    assert.throws(() => rescore(raw, 'original.json', paths, { commit: 'scoring', dirty: true }), /Missing saved transcript/);
    const live = JSON.parse(readFileSync(writeLive(directory, 0), 'utf8'));
    live.fromSec = 0; live.transcript = 'TV program works';
    const rescored = parseResult(rescore(live, 'live.json', paths, { commit: 'scoring', dirty: true }));
    assert.ok(rescored.kind === 'live'); assert.equal(rescored.wer.wer, 0); assert.deepEqual(rescored.preview, live.preview);
    delete live.transcript;
    assert.throws(() => rescore(live, 'live.json', paths, { commit: 'scoring', dirty: true }), /Missing saved live transcript/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('report never pools normalizer versions, including legacy files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-versions-'));
  try {
    const raw = JSON.parse(readFileSync(writeWer(directory, 0), 'utf8'));
    const old = parseResult(raw), current = parseResult({ ...raw, normalizer: 'hearalong-2' });
    const source = '<!-- bench:begin -->\n<!-- bench:end -->';
    const doc = renderBench(source, [old, current]);
    assert.equal((doc.match(/Median custom-normalized WER across 1 eligible run:/g) ?? []).length, 2);
    assert.doesNotMatch(doc, /across 2 eligible/);
    delete raw.modelIdentity;
    const legacy = renderBench(source, [parseResult(raw), parseResult({ ...raw, normalizer: 'hearalong-2' })]);
    assert.equal((legacy.match(/### Legacy/g) ?? []).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('IHM plan reads explicit channel mapping and half-open speaker segments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-ihm-'));
  try {
    const paths = benchPaths(directory);
    for (const subdir of ['corpusResources', 'segments', 'words']) mkdirSync(join(paths.annotations, subdir), { recursive: true });
    const xml = '<root><meeting observation="Fiction1"><speaker nxt_agent="A" channel="2"/><speaker nxt_agent="B" channel="0"/></meeting></root>';
    assert.deepEqual([...speakerChannels(xml, 'Fiction1')], [['A', 2], ['B', 0]]);
    assert.throws(() => speakerChannels(xml, 'Missing'), /No channel mapping/);
    assert.throws(() => readSegments('<segment nite:id="bad" transcriber_start=" " transcriber_end="2">'), /Invalid AMI segment/);
    writeFileSync(join(paths.annotations, 'corpusResources', 'meetings.xml'), xml);
    for (const speaker of ['A', 'B']) {
      writeFileSync(join(paths.annotations, 'segments', `Fiction1.${speaker}.segments.xml`), `<root><segment nite:id="${speaker}1" transcriber_start="1" transcriber_end="2"/></root>`);
      writeFileSync(paths.wordsFile('Fiction1', speaker), `<root><w starttime="1" endtime="1.2">${speaker}boat</w><w starttime="2" endtime="2.3">outside</w><w starttime="1.5" endtime="1.6" trunc="true">truncated</w></root>`);
    }
    const clips = planIhm(['Fiction1'], directory);
    assert.deepEqual(clips.map(c => [c.speaker, c.mic, c.reference]), [['A', 'Headset-2', 'Aboat'], ['B', 'Headset-0', 'Bboat']]);
    assert.equal(clips[0].path, paths.wav('Fiction1', 'Headset-2'));
    const fetches = planFetches(directory, 'Headset');
    assert.equal(fetches.length, 65);
    assert.equal(fetches[1].url, 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2004a/audio/ES2004a.Headset-0.wav');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const machine = { commit: 'abcdef1234567890', macos: '99.0', chip: 'Fictional Chip', ramBytes: 16 * 2 ** 30,
  logicalCores: 8, dirty: false, nodeVersion: 'v22.0.0', modelIdentity: { basename: 'fiction.gguf', sha256: 'a'.repeat(64), bytes: 123 } };
const point = (value: number) => ({ mean: value, p50: value, p95: value, max: value, n: 4 });

function writeWer(directory: string, index: number): string {
  const werRate = [0.25, 0.5, 0.75][index];
  const session: WerSession = {
    meetingId: 'XX0000a', mic: 'Mix-Headset', audioSeconds: 60, wallSeconds: 20,
    substitutions: index + 1, deletions: 0, insertions: 0, hits: 4, referenceWords: 4, wer: werRate, failedChunks: 0,
  };
  const result: WerFile = {
    ...machine, kind: 'wer', createdAt: `2026-01-0${index + 1}T03:04:05.000Z`, runLabel: 'pilot', model: 'fiction.gguf', error: null,
    condition: { sessions: ['XX0000a'], mics: ['Mix-Headset'] }, sessions: [session],
    totals: { substitutions: session.substitutions, deletions: 0, insertions: 0, hits: 4, referenceWords: 4, wer: werRate, audioSeconds: 60, wallSeconds: 20 },
  };
  const path = join(directory, `wer-${index}.json`);
  writeFileSync(path, JSON.stringify(result));
  return path;
}

function writeLive(directory: string, index: number): string {
  const result: LiveFile = {
    ...machine, kind: 'live', createdAt: `2026-01-0${index + 1}T03:04:05.000Z`, runLabel: 'live', model: 'fiction.gguf', error: null,
    meetingId: 'XX0000a', mic: 'Array1-01', fromSec: 90, minutes: 10, audioSeconds: 600, clockOffsetMs: [1, 2, 3][index], warning: null,
    preview: point([1000, 2000, 3000][index]), final: point([3000, 4000, 5000][index]),
    diagnostic: { preview: point([400, 500, 600][index]), final: point([700, 800, 900][index]) },
    wer: { substitutions: 1, deletions: 0, insertions: 0, hits: 3, referenceWords: 4, wer: 0.25 },
    resources: {
      server: { cpu: point([5, 10, 15][index]), rssBytes: point([100, 200, 300][index] * 2 ** 20) },
      speechWorker: { cpu: point([1, 2, 3][index]), rssBytes: point([10, 20, 30][index] * 2 ** 20) },
    },
  };
  const path = join(directory, `live-${index}.json`);
  writeFileSync(path, JSON.stringify(result));
  return path;
}
