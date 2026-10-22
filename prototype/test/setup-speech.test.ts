import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GgufError, readGguf } from '../src/setup/gguf.ts';
import { SpeechModels, chooseFile, type ModelFile } from '../src/setup/speech-models.ts';
import { gguf, model, str, u32, u64 } from './helpers/gguf.ts';

async function fixture(t: any) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'setup-speech-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const scanner = new SpeechModels();
  const scan = (options = {}) => scanner.scan({ directory, home, envModelPath: null, hfHome: null, ...options });
  return { directory, home, scanner, scan };
}

test('GGUF v3 skips string and numeric arrays and reads metadata after them', async t => {
  const f = await fixture(t), path = join(f.directory, 'arrays.gguf');
  await model(path, { extra: [
    ['tokenizer.tokens', 9, Buffer.concat([u32(8), u64(3), str('one'), str('two'), str('three')])],
    ['tokenizer.scores', 9, Buffer.concat([u32(6), u64(4), Buffer.alloc(16)])],
    ['stt.capability.streaming', 7, Buffer.from([0])],
  ] });
  assert.deepEqual(await readGguf(path), { architecture: 'parakeet', name: 'Example speech', fileType: 'Q8_0', streaming: false });
});

test('GGUF v2, basename fallback, file name fallback, and unknown file type label', async t => {
  const f = await fixture(t), path = join(f.directory, 'fictional.gguf');
  await model(path, { version: 2, name: '', fileType: 999, extra: [['general.basename', 8, str('Example base')]] });
  assert.equal((await readGguf(path)).name, 'Example base');
  assert.equal((await readGguf(path)).fileType, 'type 999');
  await model(path, { name: '' }); assert.equal((await readGguf(path)).name, 'fictional.gguf');
});

for (const [label, data, code] of [
  ['truncated', gguf().subarray(0, 35), 'truncated'],
  ['not GGUF', Buffer.from('not a model'), 'notGGUF'],
  ['unknown value type', gguf({ extra: [['example.bad', 42, Buffer.alloc(0)]] }), 'invalid'],
  ['unknown array type', gguf({ extra: [['example.bad', 9, Buffer.concat([u32(42), u64(1)])]] }), 'invalid'],
] as const) test(`GGUF reports a typed error: ${label}`, async t => {
  const f = await fixture(t), path = join(f.directory, 'broken.gguf'); await writeFile(path, data);
  await assert.rejects(readGguf(path), (e: unknown) => e instanceof GgufError && e.code === code);
});

test('GGUF refuses headers beyond 64 MiB without reading array contents', async t => {
  const f = await fixture(t), path = join(f.directory, 'huge.gguf');
  await model(path, { extra: [['tokenizer.scores', 9, Buffer.concat([u32(6), u64(20_000_000)])]] });
  const file = await open(path, 'r+'); await file.truncate(81_000_000); await file.close();
  await assert.rejects(readGguf(path), (e: unknown) => e instanceof GgufError && e.code === 'tooLarge');
});

for (const [family, streaming] of [['parakeet', true], ['moonshine', true], ['voxtral', true], ['whisper', false], ['parakeet_buffered', false]] as const) {
  test(`GGUF absent streaming metadata defaults correctly for ${family}`, async t => {
    const f = await fixture(t), path = await model(join(f.directory, 'family.gguf'), { family });
    assert.equal((await readGguf(path)).streaming, streaming);
  });
}

test('scan silently skips LLM architectures', async t => {
  const f = await fixture(t); await model(join(f.directory, 'models/llm.gguf'), { family: 'llama' });
  const result = await f.scan(); assert.deepEqual(result.models, []); assert.equal(result.config.available, false);
});

test('scan respects source order, dedupes real paths and follows symlinked HF snapshots', async t => {
  const f = await fixture(t);
  const env = await model(join(f.directory, 'env.gguf'), { name: 'Example env', family: 'whisper' });
  const saved = await model(join(f.directory, 'saved.gguf'), { name: 'Example saved' });
  const blob = await model(join(f.home, '.cache/huggingface/hub/models--example/blobs/abc'), { name: 'Example cached' });
  const snapshot = join(f.home, '.cache/huggingface/hub/models--example/snapshots/rev'); await mkdir(snapshot, { recursive: true });
  await symlink(blob, join(snapshot, 'example.gguf'));
  await mkdir(join(f.home, '.pi/agent'), { recursive: true });
  await writeFile(join(f.home, '.pi/agent/pi-voice.json'), JSON.stringify({ model: { path: blob } }));
  await model(join(f.directory, 'models/local.gguf'), { name: 'Example local' });
  const result = await f.scan({ envModelPath: env, savedPath: saved });
  assert.deepEqual(result.models.map(m => m.name), ['Example env', 'Example cached', 'Example local']);
  const savedScan = await f.scan({ savedPath: saved });
  assert.deepEqual(savedScan.models.map(m => m.name), ['Example saved', 'Example cached', 'Example local']);
  assert.equal(savedScan.config.path, saved);
  const cached = result.models.find(m => m.name === 'Example cached')!;
  assert.equal(cached.files.length, 1); assert.deepEqual(cached.sources, ['Pi Voice']);
  assert.equal(result.config.path, env);
  await rm(join(f.home, '.pi/agent/pi-voice.json'));
  const second = await f.scan();
  assert.equal(second.models.find(m => m.name === 'Example cached')!.files[0].source, 'Hugging Face cache');
});

test('scan merges quantizations by family and name, chooses Q8_0 then F16', async t => {
  const f = await fixture(t);
  for (const [file, fileType] of [['q4', 15], ['f16', 1], ['q8', 7]] as const) await model(join(f.directory, `models/${file}.gguf`), { fileType });
  await model(join(f.directory, 'models/whisper.gguf'), { family: 'whisper' });
  let result = await f.scan(); assert.equal(result.models.length, 2);
  const entry = result.models.find(m => m.family === 'parakeet')!;
  assert.equal(entry.files.length, 3); assert.equal(entry.chosenFile.fileType, 'Q8_0');
  const id = entry.id;
  await rm(join(f.directory, 'models/q8.gguf'));
  result = await f.scan();
  assert.equal(result.models.find(m => m.id === id)!.chosenFile.fileType, 'F16');
});

test('variant fallback picks largest quantization, otherwise first', () => {
  const file = (fileType: string, bytes: number): ModelFile => ({ fileType, bytes, path: fileType, source: 'downloaded' });
  const files = [file('F32', 200), file('Q4_K_M', 40), file('Q6_K', 60)];
  assert.equal(chooseFile(files).fileType, 'Q6_K');
  assert.equal(chooseFile(files.slice(0, 1)).fileType, 'F32');
});

test('scan chooses streaming over non-streaming and prefers Parakeet, saved choice wins', async t => {
  const f = await fixture(t);
  const whisper = await model(join(f.directory, 'models/a.gguf'), { family: 'whisper', name: 'Example W' });
  await model(join(f.directory, 'models/b.gguf'), { family: 'moonshine', name: 'Example M' });
  const parakeet = await model(join(f.directory, 'models/c.gguf'), { name: 'Example P' });
  assert.equal((await f.scan()).config.path, parakeet);
  assert.equal((await f.scan({ savedPath: whisper })).config.path, whisper);
  await rm(parakeet); assert.equal((await f.scan()).config.name, 'Example M');
});

test('scan MEETING_MODEL_PATH missing is missing and never falls back', async t => {
  const f = await fixture(t); await model(join(f.directory, 'models/local.gguf'));
  const missing = join(f.directory, 'missing.gguf'); const result = await f.scan({ envModelPath: missing });
  assert.equal(result.config.available, false); assert.equal(result.config.path, missing); assert.equal(result.missingPath, missing);
});

test('scan saved choice missing is reported while falling through', async t => {
  const f = await fixture(t); const local = await model(join(f.directory, 'models/local.gguf'));
  const missing = join(f.directory, 'missing.gguf'); const result = await f.scan({ savedPath: missing });
  assert.equal(result.config.path, local); assert.equal(result.missingPath, missing);
});

for (const malformed of [false, true]) test(`scan skips ${malformed ? 'malformed' : 'missing'} Pi Voice config`, async t => {
  const f = await fixture(t);
  if (malformed) { await mkdir(join(f.home, '.pi/agent'), { recursive: true }); await writeFile(join(f.home, '.pi/agent/pi-voice.json'), '{bad'); }
  assert.deepEqual((await f.scan()).models, []);
});

test('scan 500-file cap reports truncated', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 501 }, (_, i) => model(join(f.directory, `models/${String(i).padStart(3, '0')}.gguf`), { name: `Example ${i}` })));
  const result = await f.scan({ maxScanMs: 10_000 }); assert.equal(result.models.length, 500); assert.equal(result.truncated, true);
});

test('scan deduplicated aliases count only once toward the file cap', async t => {
  const f = await fixture(t);
  const original = await model(join(f.directory, 'example.gguf'));
  await mkdir(join(f.directory, 'models'));
  await symlink(original, join(f.directory, 'models/alias.gguf'));
  const result = await f.scan({ envModelPath: original, savedPath: original, maxFiles: 1 });
  assert.equal(result.models.length, 1); assert.equal(result.models[0].files.length, 1); assert.equal(result.truncated, false);
});

test('scan wall time cap reports truncated', async t => {
  const f = await fixture(t); assert.equal((await f.scan({ maxScanMs: 0 })).truncated, true);
});

test('scan invalidates header cache when the file changes', async t => {
  const f = await fixture(t), path = join(f.directory, 'models/local.gguf');
  await model(path, { name: 'Example before' }); assert.equal((await f.scan()).models[0].name, 'Example before');
  await model(path, { name: 'Example changed name' }); assert.equal((await f.scan()).models[0].name, 'Example changed name');
});

test('scan honors HF_HOME/hub', async t => {
  const f = await fixture(t), hfHome = join(f.directory, 'hf');
  await model(join(hfHome, 'hub/models--example/snapshots/rev/example.gguf'));
  assert.equal((await f.scan({ hfHome })).models[0].files[0].source, 'Hugging Face cache');
});
