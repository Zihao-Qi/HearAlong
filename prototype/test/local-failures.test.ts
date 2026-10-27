import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalContext, localFailure } from '../src/local-ai.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakePi, table } from './helpers/setup-pi.ts';
import { piNotesRunner } from '../src/notes.ts';
import { runPiTask } from '../src/pi-task.ts';

test('local notes refuse overlong transcript input rather than truncate it', () => {
  assert.throws(() => assertLocalContext('ollama/example', 4096, 1024, 'x'.repeat(50000)), /ollama\/example.*context.*not.*truncat/i);
  assert.doesNotThrow(() => assertLocalContext('ollama/example', 8192, 1024, 'A short fictional transcript.'));
});

test('a local tool capability failure names the model and recommends a tool-capable one', () => {
  assert.match(localFailure('lmstudio/example', 'This model does not support tools'), /lmstudio\/example.*tool-capable/i);
  assert.equal(localFailure('openai/example', 'unrelated error'), 'unrelated error');
});

test('overlong local notes never spawn an inference task', async t => {
  const f = await fakePi(t, { table: table(['ollama example 4K 1K no no']) });
  const saved = { MEETING_PI: process.env.MEETING_PI, FAKE_PI_STATE: process.env.FAKE_PI_STATE };
  Object.assign(process.env, { MEETING_PI: f.command, FAKE_PI_STATE: f.state });
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const inputPath = join(f.directory, 'transcript.md'); await writeFile(inputPath, 'x'.repeat(50000));
  await assert.rejects(piNotesRunner('ollama/example')({ instructions: 'Write notes.', inputPath, cwd: f.cwd, sessionDir: join(f.directory, 'sessions'), signal: new AbortController().signal }), /not sent or truncated/);
  assert.equal((await f.calls()).some(call => call.args.includes('json')), false);
});

for (const error of ['This model does not support tools', 'Connection refused: local model server stopped']) test(`local jobs fail cleanly: ${error}`, async t => {
  const f = await fakePi(t, { taskText: '', taskError: error, taskCode: 1 });
  const run = runPiTask('Example', { model: 'ollama/example', aiMode: 'local', cwd: f.cwd, env: f.env, tools: 'read', timeoutMs: 3000 });
  await assert.rejects(run, error.includes('tools') ? /ollama\/example.*tool-capable/i : /server stopped/);
});
