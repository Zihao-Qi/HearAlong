import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFfmpeg } from '../src/setup/ffmpeg.ts';
import { runBinary, probeDuration, decodeChunk } from '../src/audio.ts';
import { SpeechSetup } from '../src/setup/service.ts';

test('FFmpeg found on PATH leaves bare command behavior unchanged', async () => {
  const calls: string[] = [];
  const result = await checkFfmpeg({ env: {}, run: async (command, args) => { calls.push(command); assert.deepEqual(args, ['-version']); } });
  assert.deepEqual(result, { found: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }); assert.equal(calls.length, 2);
});

test('FFmpeg fallback finds fake executables only in a Homebrew folder', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'setup-brew-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['ffmpeg', 'ffprobe']) { const path = join(directory, name); await writeFile(path, '#!/bin/sh\necho example version\n'); await chmod(path, 0o700); }
  const result = await checkFfmpeg({ env: {}, fallbackFolders: [directory], run: async (command, args) => {
    if (!command.includes('/')) throw Object.assign(new Error('Not on PATH'), { code: 'ENOENT' });
    return runBinary(command, args);
  } });
  assert.deepEqual(result, { found: true, ffmpeg: join(directory, 'ffmpeg'), ffprobe: join(directory, 'ffprobe') });
});

test('FFmpeg broken environment override is reported, not silently replaced', async () => {
  const result = await checkFfmpeg({ env: { MEETING_FFMPEG: '/missing/ffmpeg' }, run: async command => {
    if (command === '/missing/ffmpeg') throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
  } });
  assert.equal(result.found, false); assert.equal(result.ffprobe, 'ffprobe'); assert.match(result.error!, /ffmpeg/);
});

test('FFmpeg discovered absolute paths are used by audio subprocesses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'setup-audio-'));
  const oldFfmpeg = process.env.MEETING_FFMPEG, oldFfprobe = process.env.MEETING_FFPROBE;
  t.after(async () => {
    if (oldFfmpeg === undefined) delete process.env.MEETING_FFMPEG; else process.env.MEETING_FFMPEG = oldFfmpeg;
    if (oldFfprobe === undefined) delete process.env.MEETING_FFPROBE; else process.env.MEETING_FFPROBE = oldFfprobe;
    await rm(directory, { recursive: true, force: true });
  });
  const scripts = {
    ffmpeg: '#!/bin/sh\nif [ "$1" = "-version" ]; then echo example; else printf "\\000\\000\\000\\000"; fi\n',
    ffprobe: '#!/bin/sh\nif [ "$1" = "-version" ]; then echo example; else echo \'{"streams":[{"codec_type":"audio"}],"format":{"duration":1}}\'; fi\n',
  };
  for (const [name, script] of Object.entries(scripts)) { await writeFile(join(directory, name), script); await chmod(join(directory, name), 0o700); }
  const setup = new SpeechSetup(directory, () => ({ speechModelPath: null, setupSeen: false }), async () => {}, {
    scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null },
    ffmpeg: () => checkFfmpeg({ env: {}, fallbackFolders: [directory], run: async (command, args) => {
      if (!command.includes('/')) throw Object.assign(new Error('Not on PATH'), { code: 'ENOENT' });
      return runBinary(command, args);
    } }),
  });
  await setup.initialize();
  assert.equal(process.env.MEETING_FFMPEG, join(directory, 'ffmpeg'));
  assert.equal(process.env.MEETING_FFPROBE, join(directory, 'ffprobe'));
  assert.equal(await probeDuration('fictional.audio'), 1);
  assert.deepEqual(await decodeChunk('fictional.audio', 0, 1), new Float32Array([0]));
});

test('FFmpeg unhealthy executable on PATH is not hidden by fallback', async () => {
  let calls = 0;
  const result = await checkFfmpeg({ env: {}, run: async () => { calls++; throw new Error('Exit 1'); } });
  assert.equal(result.found, false); assert.equal(calls, 2);
});
