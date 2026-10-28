import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeContext } from '@earendil-works/pi-ai';
import { localProvider } from '../pi-extensions/local-models.ts';
import { localLengthMessage } from '../src/local-ai.ts';
import { checkNotesRun } from '../src/notes.ts';
import { emptyPartDiagnostics, notesDiagnosticsRows, partDiagnosticEvent } from '../src/notes-diagnostics.ts';
import type { PiTaskResult } from '../src/pi-task.ts';

async function fixture(t: any, kind: 'ollama' | 'lmstudio' = 'ollama', notes = false) {
  let size = 32768, finish = 'stop';
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"fictional:4b"}]}');
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'fictional:4b', context_length: size }] }));
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"fictional:4b"}]}');
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ key: 'fictional:4b', loaded_instances: [{ config: { context_length: size } }] }] }));
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"${finish}"}]}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  for (const port of [11434, 1234, 4318]) assert.notEqual(address.port, port);
  const provider = localProvider(kind, `http://127.0.0.1:${address.port}/v1`, notes);
  await provider.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(5000), publish: async p => { p.update?.(); return true; } });
  const ask = (text = 'Fictional lantern meeting.', simple = true, maxTokens = 100) => {
    const context = normalizeContext({ messages: [{ role: 'user', content: text, timestamp: 1 }] });
    const options = { apiKey: 'local', maxTokens, maxRetries: 0, signal: AbortSignal.timeout(5000) };
    return (simple ? provider.streamSimple(provider.getModels()[0], context, options) : provider.stream!(provider.getModels()[0], context, options)).result();
  };
  return { bodies, provider, ask, setSize: (value: number) => { size = value; }, length: () => { finish = 'length'; } };
}
const room = (size: number, body: any) => size - Math.ceil(Array.from(JSON.stringify({ messages: body.messages, tools: body.tools })).length / 3 * 1.25) - 512;
const record = (message: any) => {
  const part = emptyPartDiagnostics();
  partDiagnosticEvent(part, { type: 'turn_start' });
  partDiagnosticEvent(part, { type: 'message_end', message });
  return part.requests[0];
};

test('local thinking: default requests send none and the off allowance', async t => {
  const f = await fixture(t);
  for (const simple of [true, false]) {
    const result = await f.ask(undefined, simple, 4096);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(f.bodies.at(-1).reasoning_effort, 'none');
    assert.equal(f.bodies.at(-1).max_tokens, 4096);
    assert.equal(record(result).thinking, false); assert.equal(record(result).allowance, 4096);
  }
});

test('local thinking: explicit opt-in uses medium and 16384, independently of catalog reasoning and requested tokens', async t => {
  const f = await fixture(t, 'ollama', true);
  assert.equal(f.provider.getModels()[0].reasoning, false);
  for (const simple of [true, false]) {
    const result = await f.ask(undefined, simple);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(f.bodies.at(-1).reasoning_effort, 'medium');
    assert.equal(f.bodies.at(-1).max_tokens, 16384);
    const request = record(result);
    assert.equal(request.thinking, true); assert.equal(request.allowance, 16384);
  }
});

test('local thinking: measured context reserves input and margin; below 6144 falls back without clipping input', async t => {
  const f = await fixture(t, 'ollama', true);
  f.setSize(16384);
  const input = 'A fictional lantern. '.repeat(1200);
  const result = await f.ask(input, true, 4096);
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  const body = f.bodies.at(-1);
  assert.ok(room(16384, body) < 6144 && room(16384, body) >= 4096);
  assert.equal(body.messages.at(-1).content, input);
  assert.equal(body.reasoning_effort, 'none'); assert.equal(body.max_tokens, 4096);
  assert.equal(record(result).thinking, false); assert.equal(record(result).allowance, 4096);
  assert.equal((await f.ask('Fictional lantern. '.repeat(10000))).stopReason, 'error');
  assert.equal(f.bodies.length, 1, 'An over-limit input is not sent');
});

test('local thinking: the 6144 threshold is inclusive and uses Unicode characters, not UTF-16 units', async t => {
  const f = await fixture(t, 'ollama', true);
  const input = '🏮'.repeat(1000);
  assert.equal((await f.ask(input)).stopReason, 'stop');
  const overhead = 32768 - room(32768, f.bodies[0]);
  f.setSize(overhead + 6144);
  const on = await f.ask(input);
  assert.equal(on.stopReason, 'stop', on.errorMessage);
  assert.equal(f.bodies.at(-1).reasoning_effort, 'medium'); assert.equal(f.bodies.at(-1).max_tokens, 6144);
  assert.equal(room(overhead + 6144, f.bodies.at(-1)), 6144);
  f.setSize(overhead + 6143);
  const off = await f.ask(input);
  assert.equal(off.stopReason, 'stop', off.errorMessage);
  assert.equal(f.bodies.at(-1).reasoning_effort, 'none'); assert.equal(f.bodies.at(-1).max_tokens, 100);
});

test('local thinking: LM Studio remains unchanged, even with a notes opt-in', async t => {
  const f = await fixture(t, 'lmstudio', true);
  for (const simple of [true, false]) {
    const result = await f.ask(undefined, simple);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(Object.hasOwn(f.bodies.at(-1), 'reasoning_effort'), false);
    assert.equal(f.bodies.at(-1).max_tokens, 100);
    assert.equal(record(result).thinking, false); assert.equal(record(result).allowance, 100);
  }
});

test('local thinking: a length stop still fails notes without suggesting shorter input defeats the cap', async t => {
  const f = await fixture(t, 'ollama', true); f.length();
  const reply = await f.ask();
  assert.equal(reply.stopReason, 'length'); assert.equal(f.bodies[0].max_tokens, 16384);
  const result = { ...reply, text: 'partial', exitCode: 0, exitSignal: null, settled: true, aborted: false, tools: [], toolEvents: 0 } as unknown as PiTaskResult;
  assert.throws(() => checkNotesRun(result), /ollama\/fictional:4b.*ran out of room to write its answer/);
  assert.match(localLengthMessage('ollama/fictional:4b'), /within the output limit/);
  assert.doesNotMatch(localLengthMessage('ollama/fictional:4b'), /shorter/);
});

test('local thinking: diagnostic whitelist preserves booleans and numbers, not arbitrary metadata', () => {
  const part = emptyPartDiagnostics();
  partDiagnosticEvent(part, { type: 'turn_start' });
  partDiagnosticEvent(part, { type: 'message_update', message: { role: 'assistant', localRequest: { thinking: false, allowance: 4096, text: 'PRIVATE' } } });
  partDiagnosticEvent(part, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  assert.equal(part.requests[0].thinking, false); assert.equal(part.requests[0].allowance, 4096);
  const rows = notesDiagnosticsRows([{ jobId: 'fictional', parts: { project: part, tasks: part, other: part } }]);
  assert.deepEqual(rows[0].parts.project, part);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|text/);
  const unknown = record({ role: 'assistant', localRequest: { thinking: 'true', allowance: '4096' } });
  assert.equal(unknown.thinking, null); assert.equal(unknown.allowance, null);
});
