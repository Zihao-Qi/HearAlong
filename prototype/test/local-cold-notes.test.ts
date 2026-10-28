import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NotesJobs, piNotesRunner } from '../src/notes.ts';
import { normalizeContext } from '@earendil-works/pi-ai';
import { localProvider } from '../pi-extensions/local-models.ts';
import { runPiTask } from '../src/pi-task.ts';
import { PiRpc } from '../src/pi-rpc.ts';
import { DurationHistory } from '../src/progress.ts';
import { MeetingStore } from '../src/store.ts';
import { until } from './helpers/setup-pi.ts';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cold-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MeetingStore(directory);
  t.after(() => store.close());
  const meeting = store.createMeeting('Fictional lantern workshop');
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Keep the painted lanterns on the rack.', words: [], backend: 'fake', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  return { directory, store, meeting, history: async () => JSON.parse(await readFile(join(directory, 'job-durations.json'), 'utf8')) };
}

async function coldOllama(t: any, directory: string, context = 16384) {
  let loaded = false, failNext = false, brokenNext = false;
  const bodies: any[] = [];
  const http = createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"fictional:4b"}]}');
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: loaded ? [{ name: 'fictional:4b', context_length: context }] : [] }));
    if (req.url === '/v1/models') return res.end('{"data":[]}');
    if (req.url === '/api/v1/models') return res.end('{"models":[]}');
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); bodies.push(value);
    if (value.stream === false) { loaded = true; return res.end('{}'); }
    if (failNext) { failNext = false; res.statusCode = 503; return res.end('{"error":{"message":"503 fictional overloaded","type":"server_error"}}'); }
    const text = brokenNext ? 'broken JSON' : JSON.stringify({ title: 'Lanterns', summary: [{ text: 'Keep the lanterns on the rack.', cites: ['S1'], quote: 'Keep the painted lanterns on the rack.' }], decisions: [], actions: [], openQuestions: [], otherMatters: [], otherTalk: [] });
    brokenNext = false;
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: value.max_tokens === 1 ? '{' : text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: value.max_tokens === 1 ? 'length' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 35, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  for (const port of [11434, 1234, 4318]) assert.notEqual(address.port, port);
  const base = `http://127.0.0.1:${address.port}/v1`;
  const command = join(directory, 'pi');
  const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  const guard = join(directory, 'network-guard.mjs');
  await writeFile(guard, `const fetch = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.origin !== '${new URL(base).origin}') throw new Error('Unexpected endpoint'); return fetch(input, options); };\n`);
  const env = { MEETING_PI: command, HOME: directory, MEETING_OLLAMA_BASE: base, MEETING_LMSTUDIO_BASE: base, NODE_OPTIONS: `--import=${guard}` };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { bodies, command, base, fail: () => { failNext = true; }, breakJson: () => { brokenNext = true; } };
}

test('cold Ollama: direct runPiTask uses measured output allowance, not the catalog sentinel', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  const result = await runPiTask('Write fictional lantern notes as JSON.', { model: 'ollama/fictional:4b', cwd: f.directory, command: server.command, tools: null, timeoutMs: 30_000 });
  assert.equal(result.stopReason, 'stop');
  assert.equal(server.bodies[0].max_tokens, 1, 'Only the fixed-word warm-up uses one token');
  assert.equal(server.bodies[1].max_tokens, 4096);
});

test('cold Ollama: notes finish and retain per-part usage, stop reason and lane waiting without transcript text', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null, runner: piNotesRunner('ollama/fictional:4b') });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id);
  await until(() => !jobs.busy(f.meeting.id), 45_000);
  const status = await jobs.status(f.meeting.id);
  assert.equal(status.job, null, status.job?.error);
  assert.ok(status.notes);
  assert.equal(server.bodies.filter(b => b.stream !== false).length, 3);
  for (const body of server.bodies.filter(b => b.stream !== false)) {
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 4096);
  }
  console.log('16k fictional notes allowances', server.bodies.filter(b => b.stream !== false).map(b => b.max_tokens));
  const rows = (await f.history()).notesParts;
  assert.equal(rows.length, 1);
  for (const part of Object.values(rows[0].parts) as any[]) {
    assert.ok(part.wallMs > 0);
    assert.ok(part.waitMs >= 0);
    assert.equal(part.requests.length, 1);
    assert.equal(part.requests[0].stopReason, 'stop');
    assert.deepEqual(part.requests[0].usage, { input: 116, output: 35, reasoning: 3, cacheRead: 4 });
  }
  assert.ok(Object.values(rows[0].parts).some((p: any) => p.waitMs > 100), 'A queued part records meaningful lane waiting');
  assert.doesNotMatch(JSON.stringify(rows), /painted|lantern|rack|content|instructions|messages/);
});

test('cold Ollama: Pi auto-retry requests are all counted in part diagnostics', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  const agent = join(f.directory, 'scratch', 'notes', f.meeting.id, '.pi-local');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
  server.fail();
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null, runner: piNotesRunner('ollama/fictional:4b') });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id);
  await until(() => !jobs.busy(f.meeting.id), 45_000);
  assert.equal((await jobs.status(f.meeting.id)).job, null);
  assert.equal(server.bodies.filter(b => b.stream !== false).length, 4);
  const parts = Object.values((await f.history()).notesParts[0].parts) as any[];
  assert.deepEqual(parts.map(p => p.requests.length).sort(), [1, 1, 2]);
  assert.deepEqual(parts.find(p => p.requests.length === 2).requests.map((r: any) => r.stopReason), ['error', 'stop']);
});

test('cold Ollama: measured context sets the allowance, but a real catalog may lower it', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  const p = localProvider('ollama', server.base);
  const refresh = () => p.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(5000), publish: async p => { p.update?.(); return true; } });
  await refresh();
  const context = normalizeContext({ messages: [{ role: 'user', content: 'Fictional lantern workshop.', timestamp: 1 }] });
  const ask = () => p.streamSimple(p.getModels()[0], context, { apiKey: 'local', maxTokens: 100, signal: AbortSignal.timeout(5000) }).result();
  assert.equal((await ask()).stopReason, 'stop');
  assert.equal(server.bodies.at(-1).max_tokens, 4096, 'A sentinel catalog must not supply a lower allowance');
  await refresh();
  assert.equal((await ask()).stopReason, 'stop');
  assert.equal(server.bodies.at(-1).max_tokens, 100, 'A measured catalog may honor a lower request');
});

test('notes diagnostics count every retry and retain failed parts outside duration estimates', async t => {
  const f = await fixture(t);
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null, runner: async input => {
    input.onEvent?.({ type: 'turn_start' });
    input.onEvent?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', usage: { input: 10, output: 2, reasoning: 1, cacheRead: 3 }, content: 'PRIVATE FICTIONAL TRANSCRIPT' } });
    input.onEvent?.({ type: 'auto_retry_start', attempt: 1 });
    input.onEvent?.({ type: 'turn_start' });
    input.onEvent?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'length', usage: { input: 20, output: 4, cacheRead: 0 } } });
    throw new Error('Fictional part failed');
  } });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id);
  await until(() => !jobs.busy(f.meeting.id));
  const history = await f.history();
  assert.equal(history.notes.length, 0, 'Failures are not completion-time samples');
  for (const part of Object.values(history.notesParts[0].parts) as any[]) {
    assert.equal(part.requests.length, 2);
    assert.deepEqual(part.requests.map((r: any) => r.stopReason), ['error', 'length']);
    assert.deepEqual(part.requests[0].usage, { input: 10, output: 2, reasoning: 1, cacheRead: 3 });
    assert.equal(part.requests[1].usage.reasoning, null, 'Unreported reasoning is unknown, not zero');
  }
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE|TRANSCRIPT|content/);
  await new DurationHistory(f.directory).record('plans', 2000);
  assert.deepEqual((await f.history()).notesParts, history.notesParts, 'Later history writes preserve diagnostics');
});

test('notes diagnostics survive timeout before headers and queued sibling cancellation', async t => {
  const f = await fixture(t), command = join(f.directory, 'hanging-pi');
  await writeFile(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "turn_start" }));\nsetTimeout(() => {}, 30000);\n', { mode: 0o700 });
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null,
    runner: input => runPiTask(input.instructions, { model: 'ollama/fictional:4b', command, cwd: input.cwd, tools: null,
      timeoutMs: 400, signal: input.signal, onEvent: input.onEvent, onLocalWait: input.onLocalWait }) });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id);
  await until(() => !jobs.busy(f.meeting.id));
  assert.match((await jobs.status(f.meeting.id)).job?.error ?? '', /exceeded/);
  const parts = (await f.history()).notesParts[0].parts;
  assert.equal(parts.project.requests.length, 1, 'Attempt counted even with no response headers');
  assert.equal(parts.project.requests[0].stopReason, null);
  assert.deepEqual(parts.project.requests[0].usage, { input: null, output: null, reasoning: null, cacheRead: null });
  for (const name of ['tasks', 'other']) {
    assert.equal(parts[name].requests.length, 0, 'Queued cancellation never makes a model request');
    assert.ok(parts[name].waitMs >= 300);
    assert.ok(parts[name].wallMs >= parts[name].waitMs);
  }
});

test('local thinking: production notes at 32k send none and 4096 through Pi', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory, 32768);
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null, runner: piNotesRunner('ollama/fictional:4b') });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id);
  await until(() => !jobs.busy(f.meeting.id), 45_000);
  assert.equal((await jobs.status(f.meeting.id)).job, null);
  const bodies = server.bodies.filter(b => b.stream !== false);
  assert.equal(bodies.length, 3);
  for (const body of bodies) { assert.equal(body.reasoning_effort, 'none'); assert.equal(body.max_tokens, 4096); }
  assert.equal(server.bodies[0].reasoning_effort, 'none', 'Warm-up never thinks');
  for (const part of Object.values((await f.history()).notesParts[0].parts) as any[]) {
    assert.equal(part.requests.length, 1);
    assert.equal(part.requests[0].thinking, false); assert.equal(part.requests[0].allowance, 4096);
  }
});

test('local thinking: direct task opt-in still reaches the extension room rule', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory, 32768);
  const result = await runPiTask('Write fictional lantern notes.', { model: 'ollama/fictional:4b', cwd: f.directory,
    command: server.command, tools: null, thinking: 'medium', localNotesThinking: true, timeoutMs: 30_000 });
  assert.equal(result.stopReason, 'stop');
  const bodies = server.bodies.filter(b => b.stream !== false);
  assert.equal(bodies.length, 1); assert.equal(bodies[0].reasoning_effort, 'medium'); assert.equal(bodies[0].max_tokens, 16384);
});

test('cold Ollama: a broken JSON retry rejoins the lane and records both requests', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  server.breakJson();
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null, runner: piNotesRunner('ollama/fictional:4b') });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id); await until(() => !jobs.busy(f.meeting.id), 45_000);
  assert.equal((await jobs.status(f.meeting.id)).job, null);
  const bodies = server.bodies.filter(b => b.stream !== false);
  assert.equal(bodies.length, 4);
  const prompts = bodies.map(b => JSON.stringify(b.messages));
  assert.equal(prompts[3], prompts[0], 'The retry follows the already queued sibling parts, with the same prompt');
  const parts = Object.values((await f.history()).notesParts[0].parts) as any[];
  assert.deepEqual(parts.map(p => p.requests.length).sort(), [1, 1, 2]);
  assert.deepEqual(parts.find(p => p.requests.length === 2).requests.map((r: any) => r.stopReason), ['stop', 'stop']);
});

test('local thinking: RPC low and an ordinary medium task stay off, ignoring an inherited notes opt-in', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  const rpc = new PiRpc({ model: 'ollama/fictional:4b', cwd: f.directory, command: server.command,
    env: { ...process.env, MEETING_LOCAL_NOTES_THINKING: '1' } });
  t.after(() => rpc.close());
  assert.equal((await rpc.ask('Correct this fictional lantern sentence.')).stopReason, 'stop');
  assert.equal((await runPiTask('A fictional non-notes task.', { model: 'ollama/fictional:4b', cwd: f.directory,
    command: server.command, tools: null, thinking: 'medium', env: { MEETING_LOCAL_NOTES_THINKING: '1' }, timeoutMs: 30_000 })).stopReason, 'stop');
  assert.equal(server.bodies.filter(b => b.stream !== false).length, 2);
  for (const body of server.bodies.filter(b => b.stream !== false)) {
    assert.equal(body.reasoning_effort, 'none'); assert.equal(body.max_tokens, 4096);
  }
});

test('local thinking: notes diagnostics retain the effective flag and allowance for every retry and reload', async t => {
  const f = await fixture(t), server = await coldOllama(t, f.directory);
  const agent = join(f.directory, 'scratch', 'notes', f.meeting.id, '.pi-local');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
  server.fail();
  const jobs = new NotesJobs({ ...f, clock: Date.now, glossaryFor: async () => null, runner: piNotesRunner('ollama/fictional:4b') });
  t.after(() => jobs.close());
  await jobs.start(f.meeting.id);
  await until(() => !jobs.busy(f.meeting.id), 45_000);
  assert.equal((await jobs.status(f.meeting.id)).job, null);
  const rows = (await f.history()).notesParts;
  const requests = Object.values(rows[0].parts).flatMap((part: any) => part.requests) as any[];
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(r => r.allowance).sort(), server.bodies.filter(b => b.stream !== false).map(b => b.max_tokens).sort());
  assert.ok(requests.every(r => r.thinking === false && Number.isInteger(r.allowance) && r.allowance === 4096));
  await new DurationHistory(f.directory).record('plans', 2000);
  assert.deepEqual((await f.history()).notesParts, rows);
});
