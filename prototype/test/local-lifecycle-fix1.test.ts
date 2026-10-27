import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AiSetup, type AiSettings } from '../src/setup/ai.ts';
import { Boards } from '../src/board.ts';
import { Corrector } from '../src/correction.ts';
import { MeetingStore } from '../src/store.ts';
import { ModelRpc, PiRpc } from '../src/pi-rpc.ts';
import { startServer } from '../src/server.ts';
import { runPiTask } from '../src/pi-task.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';

for (const operation of ['recheck', 'models'] as const) test(`FIX1 a suspended implicit ${operation} cannot launch Cloud metadata after Off`, async t => {
  const f = await fakePi(t, { table: table(['ollama example 8K 2K no no', 'example main 8K 2K no no']) });
  let settings: AiSettings = { aiMode: 'local', setupSeen: true, mainModel: null, quickModel: null };
  let blocked = false, release!: () => void;
  const keys = new Promise<void>(resolve => { release = resolve; });
  const ai = new AiSetup(() => settings, async next => { settings = next; }, { cwd: f.cwd, cloud: true, env: f.env, keysReady: () => blocked ? keys : Promise.resolve() });
  t.after(() => ai.close()); ai.start(); await ai.models();
  const before = (await f.calls()).length; blocked = true;
  const pending = operation === 'recheck' ? ai.recheck() : ai.models(true);
  await Promise.resolve(); await ai.use({ mode: 'off' }); release(); await pending;
  assert.equal((await f.calls()).length, before, 'No stale metadata child may start after Off.');
  const preview = await ai.models(true, 'cloud');
  assert.equal(preview.models.length, 1, 'An explicit Cloud preview in the dialog remains allowed.');
});

test('FIX1 a changed Cloud provider consent set cancels active tasks and warm RPC, even without a mode change', async t => {
  let remove!: () => unknown;
  const f = await fakePi({ after: fn => { remove = fn; } }, { table: table(['old main 8K 2K no no', 'old quick 8K 2K no no', 'new main 8K 2K no no', 'new quick 8K 2K no no']), taskDelay: 1500 });
  const directory = join(f.directory, 'data'); await mkdir(directory);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ aiMode: 'cloud', setupSeen: true, mainModel: 'old/main', quickModel: 'old/quick', cloudConsent: { providers: ['old'], time: 1 } }));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, ai: { env: f.env, tiny: async () => ({ text: 'OK', tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, toolEvents: 0, toolResults: [], settled: true, ms: 1 }) }, setup: { scan: { home: f.directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  t.after(async () => { await app.close(); await remove(); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const req = (path: string, init: RequestInit = {}) => fetch(app.url + path, { ...init, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' } });
  await req('/api/setup/ai/models');
  const task = runPiTask('Fictional old provider job', { model: 'old/main', cwd: f.cwd, env: f.env, tools: null }).then(() => null, error => error as Error);
  const lane = new PiRpc({ model: 'old/main', cwd: f.cwd, env: f.env });
  const rpc = lane.ask('Fictional old provider question').then(() => null, error => error as Error);
  await until(async () => (await f.calls()).filter(call => call.args.includes('json') || call.args.includes('rpc')).length === 2);
  const response = await req('/api/setup/ai', { method: 'PUT', body: JSON.stringify({ mode: 'cloud', main: 'new/main', quick: 'new/quick', consent: true }) });
  assert.equal(response.status, 200);
  const errors = await Promise.all([task, rpc]); await lane.close();
  for (const error of errors) assert.ok(error instanceof Error, 'Old-provider work must not complete after its consent is replaced.');
});

for (const active of [false, true]) test(`FIX1 three recording ${active ? 'interruptions' : 'deferrals'} preserve Board backlog and retry budget`, async t => {
  const f = await fakePi(t, { taskDelay: 5000 });
  let recording = false, pause = true;
  await mkdir(join(f.directory, 'board-store'));
  const store = new MeetingStore(join(f.directory, 'board-store')); t.after(() => store.close());
  const meeting = store.createMeeting('Example recording pauses');
  const chunk = await store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Should our fictional research club move the wooden tokens into the blue cupboard tomorrow?', words: [], backend: 'fake', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const lane = new ModelRpc(async () => 'ollama/example', { cwd: f.cwd, env: f.env, unavailable: () => recording ? 'The local Board and corrections wait until recording stops.' : null });
  const boards = new Boards({ store, actions: null, directory: f.directory, clock: Date.now, glossaryFor: async () => { if (pause && !active) recording = true; return null; }, hasMaterials: () => false,
    ask: message => pause ? lane.ask(message) : Promise.resolve({ text: '{"items":[]}', ms: 1, attempts: 1, usages: [], aborted: false, stopReason: 'stop' }) });
  t.after(async () => { await boards.close(); await lane.close(); });
  for (let i = 0; i < 3; i++) {
    recording = false;
    const count = (await f.calls()).filter(call => call.args.includes('rpc')).length;
    const scan = boards.tick(meeting.id, true);
    if (active) { await until(async () => (await f.calls()).filter(call => call.args.includes('rpc')).length > count); recording = true; lane.interrupt(); }
    await scan;
  }
  recording = false;
  assert.equal(await boards.hasBacklog(meeting.id), true);
  assert.equal((await boards.status(meeting.id)).gaps.length, 0);
  pause = false; await boards.tick(meeting.id, true);
  assert.equal(await boards.hasBacklog(meeting.id), false);
});

test('FIX1 recording deferral leaves correction failure/backoff state and pending speech untouched', async t => {
  const f = await fakePi(t);
  await mkdir(join(f.directory, 'correction-store'));
  const store = new MeetingStore(join(f.directory, 'correction-store')); t.after(() => store.close());
  const meeting = store.createMeeting('Example correction pauses');
  const chunk = await store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Please move the fictional wooden tokens into the blue cupboard.', words: [], backend: 'fake', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  let pause = true;
  const lane = new ModelRpc(async () => 'ollama/example', { cwd: f.cwd, env: f.env, unavailable: () => pause ? 'The local Board and corrections wait until recording stops.' : null });
  t.after(() => lane.close());
  const corrector = new Corrector({ store, clock: () => 100_000, glossaryFor: async () => ({ version: 1, origin: 'user', builtAt: 0, terms: [{ term: 'wooden tokens', spokenVariants: [], note: 'Fictional counters.' }] }), ask: message => pause ? lane.ask(message) : Promise.resolve({ text: '{"edits":[]}' }) });
  for (let i = 0; i < 3; i++) await corrector.tick(meeting.id, true);
  assert.equal(corrector.state(meeting.id).failures, 0); assert.equal(corrector.state(meeting.id).retryAfter, 0);
  assert.equal(corrector.state(meeting.id).stats.failed, 0); assert.equal(corrector.pending(meeting.id).length, 1);
  pause = false; await corrector.tick(meeting.id, true); assert.equal(corrector.pending(meeting.id).length, 0);
});
