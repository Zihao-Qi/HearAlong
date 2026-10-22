import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelDownload, type DownloadOptions } from '../src/setup/model-download.ts';

const content = Buffer.alloc(256 * 1024); for (let i = 0; i < content.length; i++) content[i] = i % 251;
const sha256 = createHash('sha256').update(content).digest('hex');
async function waitFor(test: () => boolean) {
  const until = Date.now() + 5000;
  while (!test()) { if (Date.now() > until) throw new Error('State did not arrive.'); await new Promise(r => setTimeout(r, 5)); }
}
async function fixture(t: any, mode: 'range' | 'ignore' | 'drop' | 'wrong' | '404' | '500' = 'range', extra: Partial<DownloadOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'setup-download-'));
  const ranges: (string | undefined)[] = [];
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; ranges.push(req.headers.range);
    if (mode === '404' || mode === '500') { res.writeHead(Number(mode)).end('Unavailable'); return; }
    let offset = mode === 'ignore' ? 0 : Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
    const start = offset;
    res.writeHead(req.headers.range && mode !== 'ignore' ? 206 : 200, {
      'Content-Length': content.length - offset,
      ...(req.headers.range && mode !== 'ignore' ? { 'Content-Range': `bytes ${offset}-${content.length - 1}/${content.length}` } : {}),
    });
    const timer = setInterval(() => {
      if (mode === 'drop' && requests === 1 && offset >= 32 * 1024) { res.destroy(); clearInterval(timer); return; }
      const end = Math.min(content.length, offset + 4096);
      res.write(mode === 'wrong' ? Buffer.alloc(end - offset, 42) : content.subarray(offset, end)); offset = end;
      if (offset === content.length) { clearInterval(timer); res.end(); }
    }, 2);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { directory, url: `http://127.0.0.1:${address.port}/model`, bytes: content.length, sha256, freeSpace: async () => 1e12, ...extra };
  const job = new ModelDownload(options); await job.ready;
  t.after(async () => { await job.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return { directory, options, job, ranges, requests: () => requests };
}

test('download completes, hashes while writing, and renames only a verified file', async t => {
  let done: string | undefined;
  const f = await fixture(t, 'range', { onDone: async path => { done = path; } });
  await f.job.start(); assert.equal(f.job.state.state, 'done'); assert.equal(done, f.job.path);
  assert.deepEqual(await readFile(f.job.path), content); assert.equal(await stat(f.job.part).catch(() => null), null);
});

test('download pause preserves part and resume uses Range', async t => {
  const f = await fixture(t); const first = f.job.start();
  await waitFor(() => f.job.state.state === 'downloading' && f.job.state.bytes >= 16_384);
  await f.job.pause(); await first; assert.equal(f.job.state.state, 'paused');
  const bytes = (await stat(f.job.part)).size; assert.ok(bytes > 0 && bytes < content.length);
  await f.job.start(); assert.equal(f.ranges[1], `bytes=${bytes}-`);
  assert.equal(f.job.state.state, 'done'); assert.deepEqual(await readFile(f.job.path), content);
});

test('download server ignoring Range restarts from zero, including the hash', async t => {
  const f = await fixture(t, 'ignore');
  await mkdir(join(f.directory, 'models')); await writeFile(f.job.part, Buffer.alloc(10_000, 9));
  await f.job.start(); assert.equal(f.ranges[0], 'bytes=10000-'); assert.equal(f.job.state.state, 'done');
  assert.deepEqual(await readFile(f.job.path), content);
});

test('download mid-stream drop is interrupted and resumes without automatic retries', async t => {
  const f = await fixture(t, 'drop'); await f.job.start();
  assert.equal(f.job.state.state, 'interrupted'); assert.equal(f.requests(), 1);
  const bytes = (await stat(f.job.part)).size; assert.ok(bytes > 0);
  await f.job.start(); assert.equal(f.ranges[1], `bytes=${bytes}-`); assert.equal(f.job.state.state, 'done');
});

test('download wrong hash becomes damaged and deletes part', async t => {
  const f = await fixture(t, 'wrong'); await f.job.start(); assert.equal(f.job.state.state, 'damaged');
  assert.equal(await stat(f.job.part).catch(() => null), null); assert.equal(await stat(f.job.path).catch(() => null), null);
});

for (const status of ['404', '500'] as const) test(`download HTTP ${status} is interrupted with a short reason`, async t => {
  const f = await fixture(t, status); await f.job.start();
  assert.equal(f.job.state.state, 'interrupted');
  if (f.job.state.state === 'interrupted') assert.match(f.job.state.reason, new RegExp(status));
  assert.equal(f.requests(), 1);
});

test('download checks free space before start and resume with a 100 MiB reserve', async t => {
  let free = 0;
  const f = await fixture(t, 'range', { freeSpace: async () => free }); await f.job.start();
  assert.deepEqual(f.job.state, { state: 'noSpace', neededBytes: content.length + 100 * 1024 * 1024 });
  assert.equal(f.requests(), 0);
  await writeFile(f.job.part, content.subarray(0, 1000)); free = content.length - 1000 + 100 * 1024 * 1024 - 1;
  await f.job.start(); assert.deepEqual(f.job.state, { state: 'noSpace', neededBytes: content.length - 1000 + 100 * 1024 * 1024 });
});

test('download restart detects existing part as paused and hashes it before resume', async t => {
  const f = await fixture(t); await mkdir(join(f.directory, 'models')); await writeFile(f.job.part, content.subarray(0, 10_000));
  const restarted = new ModelDownload(f.options); await restarted.ready;
  assert.deepEqual(restarted.state, { state: 'paused', bytes: 10_000 });
  await restarted.start(); assert.equal(restarted.state.state, 'done'); assert.equal(f.ranges[0], 'bytes=10000-');
});

test('download restart deletes a part larger than the pinned total', async t => {
  const f = await fixture(t); await mkdir(join(f.directory, 'models')); await writeFile(f.job.part, Buffer.alloc(content.length + 1));
  const restarted = new ModelDownload(f.options); await restarted.ready;
  assert.equal(restarted.state.state, 'idle'); assert.equal(await stat(f.job.part).catch(() => null), null);
});

test('download cancel aborts the writer and deletes the part', async t => {
  const f = await fixture(t); const work = f.job.start();
  await waitFor(() => f.job.state.state === 'downloading' && f.job.state.bytes > 0);
  await f.job.cancel(); await work;
  assert.deepEqual(f.job.state, { state: 'idle' }); assert.equal(await stat(f.job.part).catch(() => null), null);
});

test('download two concurrent starts share one job and one request', async t => {
  const f = await fixture(t); const first = f.job.start(), second = f.job.start(); assert.equal(first, second);
  await Promise.all([first, second]); assert.equal(f.requests(), 1);
});

test('download shutdown aborts and keeps a resumable part', async t => {
  const f = await fixture(t); const work = f.job.start();
  await waitFor(() => f.job.state.state === 'downloading' && f.job.state.bytes > 0);
  await f.job.close(); await work; assert.equal(f.job.state.state, 'paused'); assert.ok((await stat(f.job.part)).size > 0);
});

test('download concurrent cancel and resume are serialized', async t => {
  const f = await fixture(t); const first = f.job.start();
  await waitFor(() => f.job.state.state === 'downloading' && f.job.state.bytes > 0);
  const cancelled = f.job.cancel(), resumed = f.job.start();
  await Promise.all([first, cancelled, resumed]); assert.equal(f.job.state.state, 'done'); assert.equal(f.ranges[1], undefined);
});
