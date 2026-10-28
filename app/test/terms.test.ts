import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Corrector, cleanGlossary, correctionPrompt, knownMishearings, learnable, learnedMemory, onlyRephrases, validateEdits, type Glossary } from '../src/correction.ts';
import { heardBetween, speakable } from '../src/probe.ts';
import { MeetingStore, type Segment } from '../src/store.ts';
import type { Recognition } from '../src/recognizer.ts';

const terms = cleanGlossary({ terms: [
  { term: 'protein skimmer', spokenVariants: [] },
  { term: 'salinity', spokenVariants: [] },
  { term: 'inaudible alarm', spokenVariants: [] },
  { term: 'UV_C', spokenVariants: ['you vee sea'], heard: ['you vee see', 7, ''] },
] });
const seg = (id: string, text: string): Segment => ({ id, meetingId: 'm', chunkId: 'c', source: 's', ord: 0, startMs: 0, endMs: 1, text, originalText: text, revision: 0, state: 'final', timing: 'word', edits: '[]', correctionChecked: 0 });

test('probe and learned variants reach the prompt; confirmed repeats are found as whole words only', () => {
  assert.deepEqual(terms[3].heard, ['you vee see'], 'heard variants are cleaned');
  const prompt = correctionPrompt([seg('a', 'x')], [], terms, { 'protein skimmer': ['pro teen simmer'] });
  assert.match(prompt, /protein skimmer \(may be heard as: pro teen simmer\)/);
  assert.match(prompt, /UV_C \(may be heard as: you vee see; you vee sea\)/);
  assert.doesNotMatch(prompt, /protein skimmer.*pro teen simmer.*->|reed valve|keaper's hatch/, 'no examples from this fixture');
  assert.deepEqual(knownMishearings([seg('a', 'Inspect Pro teen simmer, ignore pro teen simmering, then pro teen simmer.')], { 'protein skimmer': ['pro teen simmer'] }, terms),
    [{ id: 'a', from: 'Pro teen simmer', to: 'protein skimmer' }, { id: 'a', from: 'pro teen simmer', to: 'protein skimmer' }]);
  assert.deepEqual(knownMishearings([seg('a', 'Open the reed valve.')], { 'reef valve': ['reed valve'] }, terms), [], 'terms no longer in the glossary are ignored');
});

test('dropping a filler word or adding words around correctly heard ones is a rephrase, not a repair', () => {
  const { accepted, rejected } = validateEdits([seg('a', 'Record your salinity beside your alarm.')], { edits: [
    { id: 'a', from: 'your salinity', to: 'salinity' },
    { id: 'a', from: 'your alarm', to: 'inaudible alarm' },
  ] }, terms);
  assert.equal(accepted.size, 0);
  assert.deepEqual(rejected.map(r => r.reason), ['rephrases correctly heard words', 'rephrases correctly heard words']);
});

test('only distinctive spans are learned; filler-only spans are not rephrases; memory keys are plain', () => {
  assert.equal(learnable('pro teen simmer', 'protein skimmer'), true);
  const wordList = (() => { try { return readFileSync('/usr/share/dict/words', 'utf8').length > 0; } catch { return false; } })();
  assert.equal(learnable('Zelmik', 'Zelwick'), wordList, 'invented equipment labels need a readable word list');
  assert.equal(learnable('audible', 'inaudible'), false, 'a real word can be right elsewhere');
  assert.equal(learnable('skimming', 'skimmer'), false, 'inflected English words are not learned');
  assert.equal(learnable('audible alarm', 'inaudible alarm'), false, 'a negating prefix is never learned');
  assert.equal(learnable('balanced pump', 'unbalanced pump'), false);
  assert.equal(onlyRephrases('their', 'salinity'), false);
  assert.equal(onlyRephrases('your salinity', 'salinity'), true);
  const memory = learnedMemory(JSON.parse('{"constructor":["con struck tor"],"__proto__":["x y"],"bad":7,"inaudible":["audible"]}'));
  assert.deepEqual(Object.keys(memory).sort(), ['__proto__', 'constructor', 'inaudible']);
  assert.deepEqual(memory.inaudible, [], 'saved spans are re-checked under the current rules');
  assert.doesNotThrow(() => correctionPrompt([seg('a', 'x')], [], cleanGlossary({ terms: [{ term: 'constructor' }] }), {}));
  assert.equal(memory.toString, undefined);
});

test('the model wins over an overlapping known repeat; many known repeats do not crowd out model proposals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-overlap-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const chunk = await store.addPcm(meeting.id, 'mic:t', 0, 0, 16000, Buffer.alloc(16000 * 4, 1));
    const many = Array.from({ length: 60 }, () => 'pro team simmer').join(', ');
    store.completeChunk(chunk.id, { text: `Rinse pro teen simmer first; service ${many}; finish with you vee see.`, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    const [id] = store.segments(meeting.id).map(s => s.id);
    store.setCorrectionState(meeting.id, { lastCallAt: 0, glossaryVersion: 1, stats: { calls: 0, accepted: 0, rejected: 0, noop: 0, failed: 0, stale: 0 },
      learned: { 'protein skimmer': ['pro teen', 'pro team simmer'] } });
    const glossary: Glossary = { version: 1, origin: 'generated', builtAt: 0, terms };
    const corrector = new Corrector({ store, minIntervalMs: 0, glossaryFor: async () => glossary, ask: async () => ({ text: JSON.stringify({ edits: [
      { id, from: 'pro teen simmer', to: 'protein skimmer' }, { id, from: 'you vee see', to: 'UV_C' },
    ] }) }) });
    await corrector.tick(meeting.id);
    const text = store.segment(id)!.text;
    assert.match(text, /^Rinse protein skimmer first/, 'the longer contextual repair wins over the cached "pro teen"');
    assert.doesNotMatch(text, /pro teen|pro team simmer|you vee see/, 'all 60 known repeats and the model repair are applied');
    assert.equal(corrector.state(meeting.id).stats.rejected, 0, 'a cached "pro teen" made redundant by the model is not a rejection');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a model fix of one repeat leaves the other repeats to memory; a bad model proposal does not block memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-repeat-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const chunk = await store.addPcm(meeting.id, 'mic:t', 0, 0, 16000, Buffer.alloc(16000 * 4, 1));
    store.completeChunk(chunk.id, { text: 'Clean pro teen simmer; reconnect pro teen simmer afterward.', words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    const [id] = store.segments(meeting.id).map(s => s.id);
    store.setCorrectionState(meeting.id, { lastCallAt: 0, glossaryVersion: 1, stats: { calls: 0, accepted: 0, rejected: 0, noop: 0, failed: 0, stale: 0 },
      learned: { 'protein skimmer': ['pro teen simmer'] } });
    const glossary: Glossary = { version: 1, origin: 'generated', builtAt: 0, terms };
    const corrector = new Corrector({ store, minIntervalMs: 0, glossaryFor: async () => glossary, ask: async () => ({ text: JSON.stringify({ edits: [
      { id, from: 'pro teen simmer', to: 'protein skimmer' }, { id, from: '', to: 'salinity' },
    ] }) }) });
    await corrector.tick(meeting.id);
    assert.equal(store.segment(id)!.text, 'Clean protein skimmer; reconnect protein skimmer afterward.');
    assert.equal(corrector.state(meeting.id).stats.rejected, 1, 'only the malformed model proposal is rejected');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('confirmed mishearings are fixed in later batches without the model, even when the model call fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-learn-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    for (let i = 0; i < 3; i++) {
      const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * 5000, 16000, Buffer.alloc(16000 * 4, i + 1));
      store.completeChunk(chunk.id, recognition(`Tank ${'abc'[i]} needs pro teen simmer cleaned.`));
    }
    const glossary: Glossary = { version: 1, origin: 'generated', builtAt: 0, terms };
    const [first, second, third] = store.segments(meeting.id).map(s => s.id);
    const replies: (() => string)[] = [
      () => JSON.stringify({ edits: [{ id: first, from: 'pro teen simmer', to: 'protein skimmer' }] }),
      () => JSON.stringify({ edits: [{ id: second, from: 'pro teen simmer', to: 'protein skimmer' }] }), // Same span as the known repeat.
      () => { throw new Error('Pi timed out'); },
    ];
    const corrector = new Corrector({ store, maxBatch: 1, minIntervalMs: 0, glossaryFor: async () => glossary, ask: async () => ({ text: replies.shift()!() }) });
    await corrector.tick(meeting.id);
    assert.deepEqual(corrector.state(meeting.id).learned, { 'protein skimmer': ['pro teen simmer'] });
    await corrector.tick(meeting.id);
    assert.equal(store.segment(second)?.text, 'Tank b needs protein skimmer cleaned.');
    assert.equal(corrector.state(meeting.id).stats.rejected, 0, 'the duplicate model proposal is dropped, not rejected');
    await corrector.tick(meeting.id);
    assert.equal(store.segment(third)?.text, 'Tank c needs protein skimmer cleaned.', 'applied although the model failed');
    assert.deepEqual({ ...corrector.state(meeting.id).stats }, { calls: 3, accepted: 3, rejected: 0, noop: 0, failed: 1, stale: 0, linesSent: 3, callsWithoutUsage: 2 });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the voice probe reads the term out of its carrier sentence and says symbols by their spoken form', () => {
  assert.equal(heardBetween('Please rinse pro teen simmer before opening.', 'Please rinse', 'before opening.'), 'pro teen simmer');
  assert.equal(heardBetween('Please before opening.', 'Please rinse', 'before opening.'), null, 'garbled carrier');
  assert.equal(speakable(terms[0]), 'protein skimmer');
  assert.equal(speakable(terms[3]), 'you vee sea');
  assert.equal(speakable({ term: 'n', spokenVariants: [] }), null);
});
