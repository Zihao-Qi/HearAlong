import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { NotesJobs, checkNotesRun, type NotesRunner } from '../src/notes.ts';
import { type PiTaskResult } from '../src/pi-task.ts';
import { until } from './helpers/setup-pi.ts';

const good = JSON.stringify({ summary: [{ text: 'Keep the lanterns on the rack.', cites: ['S1'], quote: 'Keep the painted lanterns on the rack.' }] });
const isProject = (input: Parameters<NotesRunner>[0]) => input.instructions.includes('notes: title,');
const response = (input: Parameters<NotesRunner>[0], text: string) => {
  input.onEvent?.({ type: 'turn_start' });
  input.onEvent?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 20, output: 10 } } });
  return { text, model: 'fictional', provider: 'fake' };
};
async function fixture(t: any, runner: NotesRunner) {
  const directory = await mkdtemp(join(tmpdir(), 'notes-json-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MeetingStore(directory); t.after(() => store.close());
  const meeting = store.createMeeting('Fictional lantern workshop');
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Keep the painted lanterns on the rack.', words: [], backend: 'fake', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const jobs = new NotesJobs({ store, directory, runner, clock: Date.now, glossaryFor: async () => null, abortGraceMs: 20 });
  t.after(() => jobs.close());
  return { jobs, meeting, history: async () => JSON.parse(await readFile(join(directory, 'job-durations.json'), 'utf8')) };
}

for (const broken of ['not JSON', '{"summary": broken}']) test(`notes parse retry succeeds after ${broken}`, async t => {
  const calls: Parameters<NotesRunner>[0][] = [];
  const f = await fixture(t, async input => {
    if (!isProject(input)) return response(input, '{}');
    calls.push(input);
    return response(input, calls.length === 1 ? broken : good);
  });
  await f.jobs.start(f.meeting.id); await until(() => !f.jobs.busy(f.meeting.id));
  const status = await f.jobs.status(f.meeting.id);
  assert.equal(status.job, null); assert.equal(status.notes?.notes.summary.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].instructions, calls[1].instructions); assert.equal(calls[0].inputPath, calls[1].inputPath);
  assert.equal(calls[0].cwd, calls[1].cwd); assert.notEqual(calls[0].sessionDir, calls[1].sessionDir);
  assert.equal(calls[0].signal, calls[1].signal);
  const parts = (await f.history()).notesParts[0].parts;
  assert.deepEqual(parts.project.requests.map((r: any) => r.stopReason), ['stop', 'stop']);
  assert.equal(parts.tasks.requests.length, 1); assert.equal(parts.other.requests.length, 1);
});

for (const broken of ['{"summary":[{"text":"Discard this draft."},{"text":"unfinished', '{"summary":[{"text":"Discard this draft."}],"title":}']) {
  for (const siblingLatest of [false, true]) test(`notes retry resets streamed progress: incomplete=${broken.endsWith('unfinished')}, sibling latest=${siblingLatest}`, async t => {
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      return { promise, resolve };
    };
    const firstReady = gate(), firstReturn = gate(), retryReady = gate(), retryStream = gate(), validReady = gate(), retryReturn = gate();
    const siblingStream = gate(), siblingReady = gate();
    const stream = (input: Parameters<NotesRunner>[0], text: string) => input.onEvent?.({ type: 'text_delta', delta: text });
    let calls = 0;
    const f = await fixture(t, async input => {
      if (!isProject(input)) {
        if (siblingLatest && input.instructions.includes('notes: decisions,')) {
          await siblingStream.promise;
          stream(input, '{"actions":[{"text":"Sibling draft."}]}'); siblingReady.resolve();
        }
        return response(input, '{}');
      }
      if (++calls === 1) {
        stream(input, broken); firstReady.resolve(); await firstReturn.promise;
        return response(input, broken);
      }
      retryReady.resolve(); await retryStream.promise;
      stream(input, good); validReady.resolve(); await retryReturn.promise;
      return response(input, good);
    });
    try {
      await f.jobs.start(f.meeting.id); await firstReady.promise;
      let progress = (await f.jobs.status(f.meeting.id)).job!.progress!;
      assert.equal(progress.parts.project.count, 1); assert.equal(progress.latest, 'Discard this draft.');
      if (siblingLatest) { siblingStream.resolve(); await siblingReady.promise; }
      firstReturn.resolve(); await retryReady.promise;
      progress = (await f.jobs.status(f.meeting.id)).job!.progress!;
      assert.equal(progress.parts.project.count, 0);
      assert.equal(progress.latest, siblingLatest ? 'Sibling draft.' : null);
      if (siblingLatest) assert.equal(progress.parts.tasks.count, 1, 'Reset only the retried part');
      retryStream.resolve(); await validReady.promise;
      progress = (await f.jobs.status(f.meeting.id)).job!.progress!;
      assert.equal(progress.parts.project.count, 1, 'Count only the valid attempt, with a fresh scanner');
      assert.equal(progress.latest, 'Keep the lanterns on the rack.');
      retryReturn.resolve(); await until(() => !f.jobs.busy(f.meeting.id));
      const status = await f.jobs.status(f.meeting.id);
      assert.equal(status.job, null); assert.equal(status.notes?.notes.summary.length, 1);
      assert.equal(calls, 2); assert.equal((await f.history()).notesParts[0].parts.project.requests.length, 2);
    } finally { firstReturn.resolve(); retryStream.resolve(); retryReturn.resolve(); siblingStream.resolve(); }
  });
}

test('notes parse retry fails on a second broken answer and retains its parse error', async t => {
  let calls = 0;
  const f = await fixture(t, async input => response(input, isProject(input) ? (++calls === 1 ? 'not JSON' : '{"summary": broken}') : '{}'));
  await f.jobs.start(f.meeting.id); await until(() => !f.jobs.busy(f.meeting.id));
  const status = await f.jobs.status(f.meeting.id);
  assert.equal(calls, 2); assert.equal(status.notes, null); assert.equal(status.job?.state, 'failed');
  let message = ''; try { JSON.parse('{"summary": broken}'); } catch (error) { message = (error as Error).message; }
  assert.equal(status.job?.error, message);
  const history = await f.history();
  assert.equal(history.notesParts[0].parts.project.requests.length, 2); assert.deepEqual(history.notes, []);
});

for (const failure of ['timeout', 'deferred', 'length', 'other'] as const) test(`notes ${failure} failure does not retry`, async t => {
  let calls = 0;
  const f = await fixture(t, async input => {
    if (!isProject(input)) return response(input, '{}');
    calls++; response(input, 'not JSON');
    if (failure === 'timeout') throw new Error('The notes task exceeded its timeout.');
    if (failure === 'deferred') throw Object.assign(new Error('AI deferred'), { code: 'AI_DEFERRED' });
    if (failure === 'other') throw new Error('Fictional runner failure');
    return checkNotesRun({ text: 'not JSON', exitCode: 0, exitSignal: null, settled: true, aborted: false,
      stopReason: 'length', tools: [], toolResults: [], toolEvents: 0, ms: 0, provider: 'ollama', model: 'fictional:4b' } satisfies PiTaskResult);
  });
  await f.jobs.start(f.meeting.id); await until(() => !f.jobs.busy(f.meeting.id));
  assert.equal(calls, 1); assert.equal((await f.jobs.status(f.meeting.id)).job?.state, 'failed');
  assert.equal((await f.history()).notesParts[0].parts.project.requests.length, 1);
});

for (const duringRetry of [false, true]) test(`notes cancellation ${duringRetry ? 'during retry' : 'before parsing'} does not launch another attempt`, async t => {
  let calls = 0, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async input => {
    if (!isProject(input)) return response(input, '{}');
    calls++; response(input, 'not JSON');
    if (duringRetry && calls === 1) return { text: 'not JSON' };
    entered();
    // Even an uncooperative runner returning malformed JSON after abort cannot trigger another call.
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { text: 'not JSON' };
  });
  await f.jobs.start(f.meeting.id); await ready;
  const id = (await f.jobs.status(f.meeting.id)).job!.id!;
  assert.equal((await f.jobs.cancel(f.meeting.id, id)).outcome, 'cancelled');
  assert.equal(calls, duringRetry ? 2 : 1);
  const status = await f.jobs.status(f.meeting.id);
  assert.equal(status.job, null); assert.equal(status.notes, null);
  assert.equal((await f.history()).notesParts[0].parts.project.requests.length, calls);
});
