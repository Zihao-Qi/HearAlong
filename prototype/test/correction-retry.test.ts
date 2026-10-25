import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { Corrector, type Glossary } from '../src/correction.ts';
import type { Recognition } from '../src/recognizer.ts';

const recognition = (text: string): Recognition => ({ text, words: [], backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 20, processRssBytes: 0, timestampKind: 'none' });
const glossary: Glossary = { version: 1, origin: 'user', builtAt: 0, terms: [{ term: 'kernel', spokenVariants: ['colonel'] }] };
const idsFrom = (prompt: string) => [...prompt.matchAll(/^\[([^\]]+)\] /gm)].map(m => m[1]);

for (const restart of [false, true]) test(`five-minute outage loses no corrections and drains at normal cadence (restart=${restart})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'correction-outage-'));
  let store = new MeetingStore(directory);
  const meeting = store.createMeeting('Fictional experiment');
  const origin = 1_000_000; let now = origin;
  const calls: { sec: number; ids: string[]; failed: boolean }[] = [];
  const successful = new Set<string>();
  const text = 'The adaptive colonel density estimator needs careful testing before deployment. Our adaptive colonel density estimator requires another calibration run this morning. Each adaptive colonel density estimator should use the revised measurement procedure. This adaptive colonel density estimator produced consistent results during the trial. Your adaptive colonel density estimator will remain available for further experiments.';
  const make = () => new Corrector({ store, clock: () => now, glossaryFor: async () => glossary, ask: async prompt => {
    const sec = (now - origin) / 1000, ids = idsFrom(prompt), failed = sec >= 180 && sec < 480;
    calls.push({ sec, ids, failed });
    if (failed) throw new Error('429 rate limit');
    for (const id of ids) successful.add(id);
    return { text: JSON.stringify({ edits: ids.map(id => ({ id, from: 'colonel', to: 'kernel' })) }) };
  } });
  let corrector = make(); let sequence = 0;
  try {
    for (let sec = 0; sec <= 1200; sec += 5) {
      now = origin + sec * 1000;
      if (sec > 0 && sec <= 600 && sec % 20 === 0) {
        const chunk = await store.addPcm(meeting.id, 'mic:example', sequence++, (sec - 20) * 1000, 16000, Buffer.alloc(20 * 64000));
        const tokens = text.split(/\s+/);
        store.completeChunk(chunk.id, { ...recognition(text), words: tokens.map((text, i) => ({ text, t0Ms: i * 20_000 / tokens.length, t1Ms: (i + 1) * 20_000 / tokens.length })) });
      }
      if (restart && sec === 300) {
        const before = corrector.state(meeting.id);
        const pending = corrector.pending(meeting.id).map(s => s.id);
        store.close(); store = new MeetingStore(directory); corrector = make();
        assert.deepEqual(corrector.state(meeting.id), before);
        assert.deepEqual(corrector.pending(meeting.id).map(s => s.id), pending);
        assert.equal(before.failures, 2); assert.equal(before.retryAfter, origin + 380_000);
      }
      await corrector.tick(meeting.id);
      const checkedWithoutSuccess = store.segments(meeting.id).filter(s => s.correctionChecked && !successful.has(s.id));
      assert.equal(checkedWithoutSuccess.length, 0, `no line silently checked at ${sec} s`);
    }
    assert.deepEqual(calls.filter(c => c.failed).map(c => c.sec), [200, 260, 380]);
    assert.equal(calls.find(c => c.sec >= 480)?.sec, 680, 'recovery waits for the persisted five-minute backoff');
    assert.ok(calls.slice(1).every((c, i) => c.sec - calls[i].sec >= 60), 'backlog drains at normal cadence');
    assert.deepEqual(calls[4].ids.slice(0, calls[3].ids.length), calls[3].ids, 'oldest failed batch is retried');
    assert.equal(store.segments(meeting.id).length, 150);
    assert.equal(corrector.pending(meeting.id).length, 0);
    assert.ok(store.segments(meeting.id).every(s => s.text.includes('kernel') && s.revision > 0));
    const state = corrector.state(meeting.id);
    assert.equal(state.failures, 0); assert.equal(state.retryAfter, 0); assert.equal(state.lastError, undefined);
    assert.equal(state.stats.failed, 3);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('backoff is 1, 2, 5, 10, 10 minutes; filler still checks and finished cannot bypass it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'correction-backoff-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting();
  let now = 1_000_000, calls = 0;
  const corrector = new Corrector({ store, clock: () => now, glossaryFor: async () => glossary,
    ask: async () => { calls++; throw new Error('429'); } });
  try {
    store.addMedia(meeting.id, join(directory, 'fictional.wav'), 20);
    store.completeChunk(store.chunks(meeting.id)[0].id, recognition('Test the colonel estimator.'));
    for (const [index, delay] of [60_000, 120_000, 300_000, 600_000, 600_000].entries()) {
      await corrector.tick(meeting.id, true);
      assert.equal(calls, index + 1);
      assert.equal(corrector.state(meeting.id).failures, index + 1);
      assert.equal(corrector.state(meeting.id).retryAfter, now + delay);
      const filler = await store.addPcm(meeting.id, 'mic:filler', index, index * 1000, 16000, Buffer.alloc(4));
      store.completeChunk(filler.id, recognition('Okay, yeah.'));
      now += delay - 1;
      await corrector.tick(meeting.id, true);
      assert.equal(store.segment(`${filler.id}:0`)?.correctionChecked, 1);
      assert.equal(calls, index + 1);
      assert.equal(corrector.pending(meeting.id).length, 1);
      now++;
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const reply of ['{"unexpected":true}', 'not JSON']) test(`a malformed reply checks the batch and resets backoff: ${reply}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'correction-reply-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting();
  let now = 1_000_000, calls = 0;
  const corrector = new Corrector({ store, clock: () => now, glossaryFor: async () => glossary,
    ask: async () => { if (++calls === 1) throw new Error('429'); return { text: reply }; } });
  try {
    store.addMedia(meeting.id, join(directory, 'fictional.wav'), 20);
    store.completeChunk(store.chunks(meeting.id)[0].id, recognition('Test the colonel estimator.'));
    await corrector.tick(meeting.id);
    assert.equal(corrector.pending(meeting.id).length, 1);
    now += 60_000; await corrector.tick(meeting.id);
    assert.equal(corrector.pending(meeting.id).length, 0);
    assert.equal(corrector.state(meeting.id).failures, 0);
    assert.equal(corrector.state(meeting.id).retryAfter, 0);
    assert.equal(corrector.state(meeting.id).lastError, undefined);
    assert.equal(store.segments(meeting.id)[0].revision, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('glossary changes during backoff retain existing checked lines and retry unchecked lines with new terms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'correction-glossary-backoff-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting();
  let now = 1_000_000, current = glossary, calls = 0;
  const prompts: string[] = [];
  const corrector = new Corrector({ store, clock: () => now, glossaryFor: async () => current, maxBatch: 1,
    ask: async prompt => { prompts.push(prompt); if (++calls === 2) throw new Error('429'); return { text: '{"edits":[]}' }; } });
  try {
    store.addMedia(meeting.id, join(directory, 'fictional.wav'), 40);
    for (const c of store.chunks(meeting.id)) store.completeChunk(c.id, recognition('Test the colonel estimator.'));
    await corrector.tick(meeting.id); now += 60_000; await corrector.tick(meeting.id);
    assert.deepEqual(store.segments(meeting.id).map(s => s.correctionChecked), [1, 0]);
    current = { ...glossary, version: 2, terms: [{ term: 'estimator', spokenVariants: [] }] };
    now += 59_999; await corrector.tick(meeting.id, true); assert.equal(calls, 2);
    now++; await corrector.tick(meeting.id);
    assert.equal(calls, 3); assert.match(prompts[2], /- estimator\n/); assert.doesNotMatch(prompts[2], /- kernel/);
    assert.deepEqual(store.segments(meeting.id).map(s => s.correctionChecked), [1, 2]);
    assert.equal(corrector.state(meeting.id).glossaryVersion, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
