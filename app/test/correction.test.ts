import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Corrector, GlossaryFile, cleanGlossary, validateEdits, type Glossary } from '../src/correction.ts';
import { MeetingStore, type Segment } from '../src/store.ts';
import type { Recognition } from '../src/recognizer.ts';

const terms = cleanGlossary({ terms: [
  { term: 'filter cartridge', spokenVariants: [] },
  { term: 'LED', spokenVariants: [] },
  { term: 'reef valve', spokenVariants: ['reed valve'] },
  { term: 'protein skimmer', spokenVariants: ['pro teen simmer', 'pro team simmer'] },
  { term: "keeper's hatch", spokenVariants: ["keaper's hatch"] },
  { term: 'pH probe', spokenVariants: ['pee aitch probe'] },
  { term: 'UV-C', spokenVariants: ['you vee sea', 'you vee see'] },
] });
const seg = (id: string, text: string): Segment => ({ id, meetingId: 'm', chunkId: 'c', source: 's', ord: 0, startMs: 0, endMs: 1, text, originalText: text, revision: 0, state: 'final', timing: 'word', edits: '[]', correctionChecked: 0 });

test('only glossary span edits on the editable batch pass; numbers and negations are protected', () => {
  const batch = [seg('a', 'Disconnect pro tin simmer; rinse pro tin simmer outside.'), seg('b', "Fit a 7.4 mm shim to the keaper's hatch."), seg('c', 'This lamp is not you vee sea.')];
  const { accepted, rejected } = validateEdits(batch, { edits: [
    { id: 'a', from: 'pro tin simmer', to: 'protein skimmer' },
    { id: 'a', from: 'pro tin simmer', to: 'Protein Skimmer' }, // repeated phrase → second occurrence, canonical casing
    { id: 'b', from: "keaper's hatch", to: "keeper's hatch" },
    { id: 'b', from: '7.4', to: 'pH probe' }, // would change a number
    { id: 'c', from: 'not you vee sea', to: 'UV-C' }, // would drop a negation
    { id: 'c', from: 'you vee sea', to: 'sterilizer lamp' }, // not a glossary term
    { id: 'context', from: 'x', to: 'UV-C' }, // not in the editable batch
    { id: 'b', from: 'the hatch beside the large orange bucket', to: 'UV-C' },
    { id: 'b', from: 'you vee sea', to: 'UV-C' }, // sound-alike, but absent from this segment
    'garbage',
  ] }, terms);
  assert.equal(accepted.get('a')?.text, 'Disconnect protein skimmer; rinse protein skimmer outside.');
  const a = accepted.get('a')!;
  assert.deepEqual(a.edits.map(e => a.text.slice(e.start, e.end)), ['protein skimmer', 'protein skimmer'], 'stored offsets locate each replacement');
  assert.deepEqual(a.edits.map(e => [e.start, e.end]), [[11, 26], [34, 49]], 'the second occurrence moves when the first replacement grows');
  assert.notEqual(a.edits[0].start, a.edits[1].start);
  assert.equal(accepted.get('b')?.text, "Fit a 7.4 mm shim to the keeper's hatch.");
  assert.equal(accepted.has('c'), false);
  assert.deepEqual(rejected.map(r => r.reason), [
    'would change numbers, signs, units, negation or a variable', 'would change numbers, signs, units, negation or a variable', 'replacement is not a glossary term',
    'segment not in the editable batch', 'span must be 1-5 words', 'span not found as whole words in the segment', 'malformed',
  ]);
  assert.deepEqual(validateEdits(batch, { edits: [] }, terms).rejected, []);
});

test('a generated glossary never overwrites a user edit, and versions only move forward', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-glossary-'));
  try {
    const file = new GlossaryFile(join(directory, 'g.json'));
    assert.equal((await file.save(terms, 'generated', 'sol')).version, 1);
    await assert.rejects(file.save(terms, 'generated', 'sol', 0), /changed while/);
    assert.equal((await file.save(terms.slice(0, 1), 'user')).version, 2);
    await assert.rejects(file.save(terms, 'generated'), /edited by the user/);
    assert.throws(() => cleanGlossary({}), /terms/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the corrector respects the interval, retries failed batches, and drops stale-glossary results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-corrector-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    for (let i = 0; i < 3; i++) {
      const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * 5000, 16000, Buffer.alloc(16000 * 4, i + 1));
      store.completeChunk(chunk.id, recognition(`Exhibit ${'abc'[i]} has pro teen simmer offline.`));
    }
    let now = 100_000;
    let glossary: Glossary = { version: 1, origin: 'generated', builtAt: 0, terms };
    const answers: (() => string)[] = [];
    const corrector = new Corrector({
      store, clock: () => now, maxBatch: 2, minIntervalMs: 30_000, glossaryFor: async () => glossary,
      ask: async () => ({ text: answers.shift()!() }),
    });
    const ids = store.segments(meeting.id).map(s => s.id);
    answers.push(() => JSON.stringify({ edits: [{ id: ids[0], from: 'pro teen simmer', to: 'protein skimmer' }] }));
    assert.equal(await corrector.tick(meeting.id), 'done');
    assert.equal(store.segment(ids[0])?.text, 'Exhibit a has protein skimmer offline.');
    assert.equal(await corrector.tick(meeting.id), 'skipped', 'within the 30 s interval');
    now += 30_000;
    answers.push(() => { throw new Error('Pi timed out'); });
    await corrector.tick(meeting.id);
    assert.equal(corrector.state(meeting.id).stats.failed, 1);
    assert.equal(corrector.pending(meeting.id).length, 1, 'the failed batch remains unchecked');
    assert.equal(store.segment(ids[2])?.text, 'Exhibit c has protein skimmer offline.', 'known mishearings still apply on failure');
    assert.equal(await corrector.tick(meeting.id, true), 'skipped', 'finished does not bypass failure backoff');
    now += 60_000;
    answers.push(() => '{"edits":[]}');
    await corrector.tick(meeting.id);
    assert.equal(corrector.pending(meeting.id).length, 0, 'a successful retry checks the failed batch');

    const late = await store.addPcm(meeting.id, 'mic:t', 9, 20_000, 16000, Buffer.alloc(16000 * 4, 9));
    store.completeChunk(late.id, recognition('Spare pro teen simmer arrived.'));
    answers.push(() => { glossary = { ...glossary, version: 2 }; return JSON.stringify({ edits: [{ id: `${late.id}:0`, from: 'pro teen simmer', to: 'protein skimmer' }] }); });
    assert.equal(await corrector.tick(meeting.id, true), 'done', 'drain ignores the interval');
    assert.equal(store.segment(`${late.id}:0`)?.text, 'Spare pro teen simmer arrived.', 'result from an older glossary version is discarded');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rephrasing correct words or swapping in an unrelated term is refused; sound-alike repairs pass', () => {
  const batch = [seg('a', 'The filtering leaves a wet sponge beside the reed valve and pro team simmer.')];
  const { accepted, rejected } = validateEdits(batch, { edits: [
    { id: 'a', from: 'The filtering', to: 'filter cartridge' },
    { id: 'a', from: 'wet sponge', to: 'LED' },
    { id: 'a', from: 'reed valve', to: 'reef valve' },
    { id: 'a', from: 'pro team simmer', to: 'protein skimmer' },
  ] }, terms);
  assert.equal(accepted.get('a')?.text, 'The filtering leaves a wet sponge beside the reef valve and protein skimmer.');
  assert.deepEqual(rejected.map(r => r.reason), ['rephrases correctly heard words', 'does not sound like the term']);
});

test('signs, units, curly-apostrophe negations, variables and partial words are protected', () => {
  const batch = [seg('a', 'The label reads -you vee sea, - you vee sea, you vee sea kg, isn\u2019t you vee sea, and m you vee sea; inspect the unreed valve.')];
  const { accepted, rejected } = validateEdits(batch, { edits: [
    { id: 'a', from: '-you vee sea', to: 'UV-C' },
    { id: 'a', from: '- you vee sea', to: 'UV-C' },
    { id: 'a', from: 'you vee sea kg', to: 'UV-C' },
    { id: 'a', from: 'isn\u2019t you vee sea', to: 'UV-C' },
    { id: 'a', from: 'm you vee sea', to: 'UV-C' },
    { id: 'a', from: 'reed valve', to: 'reef valve' },
  ] }, terms);
  assert.equal(accepted.size, 0);
  assert.deepEqual(rejected.map(r => r.reason), [
    ...Array(5).fill('would change numbers, signs, units, negation or a variable'), 'span not found as whole words in the segment',
  ]);
});

test('concurrent glossary saves are serialized: user edits win and versions never repeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-glossary-race-'));
  try {
    const path = join(directory, 'g.json');
    await new GlossaryFile(path).save(terms, 'generated');
    const [generated, user] = await Promise.allSettled([
      new GlossaryFile(path).save(terms.slice(0, 2), 'generated', 'sol', 1),
      new GlossaryFile(path).save(terms.slice(0, 1), 'user'),
    ]);
    const final = (await new GlossaryFile(path).load())!;
    assert.equal(final.origin, 'user', 'the user edit is the final state');
    assert.equal(final.terms.length, 1);
    assert.equal(generated.status, 'fulfilled');
    assert.equal(user.status === 'fulfilled' && user.value.version, 3, 'each save got its own version');
    const [a, b] = await Promise.all([new GlossaryFile(path).save(terms, 'user'), new GlossaryFile(path).save(terms, 'user')]);
    assert.notEqual(a.version, b.version);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a later retry of an earlier chunk is still corrected; overlapping ticks make one call; a big backlog keeps the cadence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-corrector-retry-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    const early = await store.addPcm(meeting.id, 'mic:t', 0, 0, 16000, Buffer.alloc(16000 * 4, 1));
    const later = await store.addPcm(meeting.id, 'mic:t', 1, 20_000, 16000, Buffer.alloc(16000 * 4, 2));
    store.completeChunk(later.id, recognition('Close pro teen simmer after feeding.'));
    let now = 100_000;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const corrector = new Corrector({
      store, clock: () => now, maxBatch: 1, minIntervalMs: 30_000,
      glossaryFor: async () => { await gate; return { version: 1, origin: 'generated', builtAt: 0, terms }; },
      ask: async prompt => { calls++; const id = prompt.match(/^\[([^\]]+)\] /m)![1]; return { text: JSON.stringify({ edits: [{ id, from: 'pro teen simmer', to: 'protein skimmer' }] }) }; },
    });
    const both = Promise.all([corrector.tick(meeting.id), corrector.tick(meeting.id)]);
    release();
    assert.deepEqual((await both).sort(), ['done', 'skipped']);
    assert.equal(calls, 1, 'overlapping ticks made a single call');

    store.completeChunk(early.id, recognition('Unplug pro teen simmer before cleaning.')); // retried chunk, earlier in audio time
    now += 30_000;
    await corrector.tick(meeting.id);
    assert.equal(store.segment(`${early.id}:0`)?.text, 'Unplug protein skimmer before cleaning.');

    for (let i = 2; i < 5; i++) {
      const c = await store.addPcm(meeting.id, 'mic:t', i, i * 20_000, 16000, Buffer.alloc(16000 * 4, i + 1));
      store.completeChunk(c.id, recognition(`Service bay ${i}: pro teen simmer.`));
    }
    assert.equal(await corrector.tick(meeting.id, true), 'skipped', 'backlog larger than one batch keeps the 30 s cadence');
    now += 30_000;
    await corrector.tick(meeting.id, true);
    now += 30_000;
    await corrector.tick(meeting.id, true);
    assert.equal(corrector.pending(meeting.id).length, 1);
    assert.equal(await corrector.tick(meeting.id, true), 'done', 'a final tail that fits one batch runs immediately');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a second correction of a segment keeps the first edit\u2019s provenance', () => {
  const first = validateEdits([seg('a', 'Wash pro teen simmer beside the reed valve.')], { edits: [{ id: 'a', from: 'pro teen simmer', to: 'protein skimmer' }] }, terms).accepted.get('a')!;
  const corrected = { ...seg('a', first.text), edits: JSON.stringify(first.edits), revision: 1 };
  const second = validateEdits([corrected], { edits: [{ id: 'a', from: 'reed valve', to: 'reef valve' }] }, terms).accepted.get('a')!;
  assert.equal(second.text, 'Wash protein skimmer beside the reef valve.');
  assert.equal(second.added, 1, 'only the new edit counts toward stats');
  assert.deepEqual(second.edits.map(e => second.text.slice(e.start, e.end)).sort(), ['protein skimmer', 'reef valve']);
});

test('filler-only lines are checked without a model call; a line holding a glossary variant is still sent; tokens are logged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-corrector-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    const lines = ['Well, okay.', 'Um, yes, I know.', 'No, it is not the reed valve.', 'Rinse pro teen simmer outside.'];
    for (const [i, text] of lines.entries()) {
      const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * 5000, 16000, Buffer.alloc(16000 * 4, i + 1));
      store.completeChunk(chunk.id, recognition(text));
    }
    const prompts: string[] = [];
    const corrector = new Corrector({
      store, clock: () => 100_000, glossaryFor: async () => ({ version: 1, origin: 'generated', builtAt: 0, terms }),
      ask: async prompt => { prompts.push(prompt); return { text: '{"edits":[]}', usages: [{ input: 900, output: 10, cacheRead: 700 }] }; },
    });
    assert.equal(await corrector.tick(meeting.id), 'done');
    assert.equal(prompts.length, 1);
    const sent = [...prompts[0].matchAll(/^\[[^\]]+\] (.*)$/gm)].map(m => m[1]);
    assert.deepEqual(sent, ['No, it is not the reed valve.', 'Rinse pro teen simmer outside.']);
    const stats = corrector.state(meeting.id).stats;
    assert.deepEqual([stats.linesSkipped, stats.linesSent, stats.tokensIn, stats.tokensOut, stats.tokensCached], [2, 2, 900, 10, 700]);
    assert.equal(store.segments(meeting.id).every(s => s.correctionChecked), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
