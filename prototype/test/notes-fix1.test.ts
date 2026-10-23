import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { NotesJobs, notesInstructions, type NotesRunner } from '../src/notes.ts';
import { Cooldowns } from '../src/quota.ts';

const gate = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function bounded<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('job teardown exceeded bound')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await pause(5); } throw new Error('timed out'); }
const result = { text: JSON.stringify({ summary: [{ text: 'The lanterns stay on the rack.', cites: ['S1'], quote: 'Keep the painted lanterns on the rack until the parade' }] }) };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'notes-fix1-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Lantern workshop');
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Keep the painted lanterns on the rack until the parade.', words: [], backend: 'stand-in', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  let runner: NotesRunner = async () => result;
  const cooldowns = new Cooldowns();
  const jobs = new NotesJobs({ store, directory, runner: input => runner(input), clock: Date.now, glossaryFor: async () => null, cooldowns, abortGraceMs: 20 });
  await jobs.start(meeting.id); await until(() => !jobs.busy(meeting.id));
  const old = (await jobs.status(meeting.id)).notes;
  return { jobs, meeting, cooldowns, old, setRunner: (next: NotesRunner) => { runner = next; },
    async close() { await jobs.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const stop of ['failure', 'cancel', 'close'] as const) test(`non-settling siblings: ${stop} is bounded and abandoned work cannot publish`, async () => {
  const f = await fixture(), tail = gate<typeof result>(), fail = gate();
  const calls: Parameters<NotesRunner>[0][] = [];
  f.setRunner(async input => { calls.push(input); if (stop === 'failure' && input.instructions.includes('notes: title,')) { await fail.promise; throw new Error('original part failure'); } return tail.promise; });
  try {
    await f.jobs.start(f.meeting.id); await until(() => calls.length === 3);
    const id = (await f.jobs.status(f.meeting.id)).job?.id ?? 'baseline-job';
    if (stop === 'failure') { fail.resolve(); await bounded(until(() => !f.jobs.busy(f.meeting.id))); }
    else await bounded<unknown>(stop === 'cancel' ? f.jobs.cancel(f.meeting.id, id) : f.jobs.close());
    assert.equal(f.jobs.busy(f.meeting.id), false);
    assert.ok(calls.every(c => c.signal.aborted));
    tail.resolve(result); await pause(40);
    assert.deepEqual((await f.jobs.status(f.meeting.id)).notes, f.old, 'late answers never replace old notes');
    if (stop === 'failure') assert.match((await f.jobs.status(f.meeting.id)).job?.error ?? '', /original part failure/);
  } finally { fail.resolve(); tail.resolve(result); await f.close(); }
});

test('an old notes job id cannot cancel or remove a newer job', async () => {
  const f = await fixture(), tail = gate<typeof result>();
  f.setRunner(async ({ signal }) => { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return tail.promise; });
  try {
    await f.jobs.start(f.meeting.id);
    const a = (await f.jobs.status(f.meeting.id)).job?.id;
    assert.ok(a, 'every displayed job has an identity');
    await f.jobs.cancel(f.meeting.id, a);
    await f.jobs.start(f.meeting.id);
    const b = (await f.jobs.status(f.meeting.id)).job?.id;
    assert.ok(b && b !== a);
    await assert.rejects(f.jobs.cancel(f.meeting.id, a), (error: any) => error.status === 409);
    assert.equal((await f.jobs.status(f.meeting.id)).job?.id, b);
    assert.equal(f.jobs.busy(f.meeting.id), true);
    await f.jobs.cancel(f.meeting.id, b);
    assert.equal((await f.jobs.status(f.meeting.id)).job, null);
  } finally { tail.resolve(result); await f.close(); }
});

for (const side of ['before', 'after'] as const) test(`Cancel ${side} the publication commit is truthful`, async () => {
  const f = await fixture(), before = gate(), saved = gate(), after = gate();
  const original = f.jobs.file.bind(f.jobs);
  let signal: AbortSignal | undefined;
  f.jobs.file = id => {
    const file = original(id), save = file.save.bind(file);
    file.save = async (...args) => { signal = args[1]; if (side === 'before') { saved.resolve(); await before.promise; }
      const record = await save(...args); if (side === 'after') { saved.resolve(); await after.promise; } return record; };
    return file;
  };
  let cancelling: Promise<unknown> | undefined;
  try {
    await f.jobs.start(f.meeting.id); await bounded(saved.promise);
    const id = (await f.jobs.status(f.meeting.id)).job?.id ?? 'baseline-job';
    cancelling = f.jobs.cancel(f.meeting.id, id);
    if (side === 'before') {
      assert.equal(signal?.aborted, true); before.resolve();
      assert.equal((await bounded(cancelling) as any).outcome, 'cancelled');
      assert.deepEqual((await f.jobs.status(f.meeting.id)).notes, f.old);
    } else {
      assert.equal(signal?.aborted, false, 'publication already won; Cancel must not abort');
      assert.equal((await bounded(cancelling) as any).outcome, 'already-saved');
      assert.equal((await f.jobs.status(f.meeting.id)).notes?.version, 2);
      after.resolve(); await until(() => !f.jobs.busy(f.meeting.id));
      assert.equal((await f.jobs.cancel(f.meeting.id, id)).outcome, 'already-saved', 'truthful after the active job has ended too');
    }
  } finally { before.resolve(); after.resolve(); await cancelling?.catch(() => {}); await f.close(); }
});

test('a concurrent rate limit is detected even when malformed JSON is the displayed failure', async () => {
  const f = await fixture();
  f.setRunner(async input => {
    if (input.instructions.includes('notes: title,')) return { text: 'malformed answer' };
    await new Promise<void>(r => input.signal.addEventListener('abort', () => r(), { once: true }));
    throw new Error(input.instructions.includes('notes: decisions,') ? '429: rate limit reached' : 'sibling aborted');
  });
  try {
    await f.jobs.start(f.meeting.id); await until(() => !f.jobs.busy(f.meeting.id));
    assert.ok(f.cooldowns.pausedUntil('model'), 'every part participates in quota detection');
    const status = await f.jobs.status(f.meeting.id);
    assert.equal(status.job?.state, 'failed'); assert.doesNotMatch(status.job?.error ?? '', /sibling aborted/);
    assert.deepEqual(status.notes, f.old);
  } finally { await f.close(); }
});

test('summary instruction ends in a full stop before the separate decisions rule', () => {
  assert.match(notesInstructions(), /each sentence is one item with its own cites and quote\.\n  decisions:/);
});
