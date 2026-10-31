import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';

type Operation = 'feed' | 'finalize' | 'transcribe';
async function worker(t: TestContext, operation: Operation, hangs = false) {
  const folder = await mkdtemp(join(tmpdir(), 'speech-shutdown-'));
  const log = join(folder, 'events.jsonl'), mock = join(folder, 'speech.mjs'), loader = join(folder, 'loader.mjs');
  const pcm = join(folder, 'fictional.f32');
  await writeFile(pcm, Buffer.alloc(16000 * 4));
  await writeFile(mock, `import { appendFileSync } from 'node:fs';
const record = event => appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
export const setLogHandler = () => {};
async function work(kind) {
  record(kind + ' started'); process.send({ kind: 'started' });
  if (${hangs}) await new Promise(() => {});
  else await new Promise(r => setTimeout(r, 100));
  record(kind + ' done');
  return { inputReceivedMs: 1, audioCommittedMs: 1 };
}
const stream = {
  text: { committed: '', tentative: '' }, snapshot: { tokens: [] },
  feed() { return work('feed'); }, finalize() { return work('finalize'); },
  reset() { record('reset'); }
};
export const TranscribeModel = { async load() { return {
  backend: 'fake', capabilities: { nativeSampleRate: 16000 },
  createSession() { return { async stream() { return stream; }, dispose() { record('session disposed'); } }; },
  async transcribe() { await work('transcribe'); return { text: '', words: [], segments: [], timestampKind: 'none' }; },
  dispose() { record('model disposed'); }
}; } };
`);
  await writeFile(loader, `export async function resolve(specifier, context, next) { return specifier === 'transcribe-cpp' ? { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true } : next(specifier, context); }\n`);
  const entry = operation === 'transcribe' ? '../src/stt-worker.ts' : '../src/stt-stream-worker.ts';
  const child = fork(fileURLToPath(new URL(entry, import.meta.url)), ['unused-model'], {
    execArgv: ['--experimental-strip-types', '--loader', pathToFileURL(loader).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout!.resume();
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
    await rm(folder, { recursive: true, force: true });
  });
  let stderr = ''; child.stderr!.on('data', part => { stderr += String(part); });
  const message = async (kind: string) => {
    for (;;) { const [value] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) }); if (value.kind === kind) return; }
  };
  await message('ready');
  const started = message('started');
  if (operation === 'transcribe') child.send({ kind: 'transcribe', id: 'fictional', path: pcm, sampleRate: 16000, decodeStart: 0, seconds: 1 });
  else {
    child.send({ kind: 'begin', window: 'fictional' });
    child.send(operation === 'feed' ? { kind: 'feed', window: 'fictional', pcm: [] } : { kind: 'end', window: 'fictional' });
  }
  await started;
  child.disconnect();
  return { exited, stderr: () => stderr, events: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('stream worker drains an active native feed before resetting and disposing on disconnect', async t => {
  const f = await worker(t, 'feed');
  const [code, signal] = await f.exited;
  assert.equal(code, 0, f.stderr()); assert.equal(signal, null, f.stderr());
  assert.deepEqual(await f.events(), ['feed started', 'feed done', 'reset', 'session disposed', 'model disposed']);
});

test('batch worker finishes an active transcribe and clears the disconnect fallback after disposal', async t => {
  const f = await worker(t, 'transcribe');
  const [code, signal] = await f.exited;
  assert.equal(code, 0, f.stderr()); assert.equal(signal, null, f.stderr());
  assert.deepEqual(await f.events(), ['transcribe started', 'transcribe done', 'model disposed']);
});

for (const operation of ['feed', 'finalize', 'transcribe'] as const) test(`disconnect fallback exits when native ${operation} never resolves`, async t => {
  const f = await worker(t, operation, true);
  const disconnectedAt = performance.now();
  const [code, signal] = await f.exited;
  const elapsed = performance.now() - disconnectedAt;
  assert.equal(code, 1, f.stderr()); assert.equal(signal, null, f.stderr());
  assert.match(f.stderr(), /disconnect drain exceeded 10 s\./);
  assert.ok(elapsed >= 9500 && elapsed < 15000, `fallback exit after ${elapsed} ms`);
  assert.deepEqual(await f.events(), [`${operation} started`], 'never dispose a native operation still in use');
});
