import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';
import { request } from 'node:http';
import { CodeFingerprint } from '../src/update-guard.ts';

import { until } from './helpers/until.ts';

async function fixture(t: { after(fn: () => unknown): void }, helper = false, extra: Parameters<typeof startServer>[0] = {}, prepare = async (_root: string) => {}) {
  const root = await mkdtemp(join(tmpdir(), 'hearalong-update-'));
  let close = async () => {};
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  await cp(new URL('../public', import.meta.url), join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public', 'app.js'), '// fictional startup bytes');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'example.ts'), 'original');
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'package-lock.json'), '{}');
  const directory = join(root, 'data'); await mkdir(directory);
  const setup = await dashboardSetup(directory, true);
  await prepare(root);
  let now = 0, exited: number | undefined;
  const app = await startServer({ directory, port: 0, setup, recognizer: null, drafts: null, quick: null, heavy: null,
    codeRoot: root, publicRoot: join(root, 'public'), clock: () => now,
    idleMs: helper ? 600_000 : undefined, exit: code => { exited = code; }, ...extra });
  const shutdowns: Promise<void>[] = [], shutdown = app.shutdown.bind(app);
  app.shutdown = (...args) => { const done = shutdown(...args); shutdowns.push(done); return done; };
  // An accepted restart owns a graceful shutdown; closing directly would bypass its grace period.
  close = async () => { await Promise.all(shutdowns); await app.close(); };
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = (path: string, method = 'GET', body?: string) => fetch(app.url + path, { method, body, headers: { Cookie: cookie, Origin: app.url } });
  return { root, app, call, cookie, advance: () => { now += 30_000; }, exited: () => exited };
}

test('static files are the startup snapshot, including errors deferred until a request', async t => {
  const f = await fixture(t);
  const before = await (await f.call('/app.js')).text();
  await writeFile(join(f.root, 'public', 'app.js'), '// changed on disk');
  assert.equal(await (await f.call('/app.js')).text(), before);
  assert.equal(before, '// fictional startup bytes');
});

test('a missing startup file stays missing without preventing startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hearalong-missing-'));
  let close = async () => {};
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const app = await startServer({ directory: join(root, 'data'), publicRoot: root, codeRoot: root, port: 0,
    setup: { scan: { home: root, envModelPath: null, hfHome: null } }, recognizer: null, drafts: null, quick: null, heavy: null });
  close = () => app.close();
  await writeFile(join(root, 'app.js'), 'created after startup');
  const response = await fetch(app.url + '/app.js');
  assert.equal(await response.text(), '', 'same request-time empty response as a failed asset read');
});

test('status includes update and the common working predicate', async t => {
  const f = await fixture(t);
  const status = await (await f.call('/api/status')).json();
  assert.deepEqual(status.update, { ready: false, canRestart: false });
  assert.equal(status.working, false);
  await writeFile(join(f.root, 'src', 'example.ts'), 'changed'); f.advance();
  await until(async () => (await (await f.call('/api/status')).json()).update.ready);
  assert.deepEqual((await (await f.call('/api/status')).json()).update, { ready: true, canRestart: false });
});

for (const kind of ['unchanged', 'touch', 'content', 'added', 'removed', 'package', 'lock', 'public', 'throttle'] as const) {
  test(`fingerprint: ${kind}`, async t => {
    const f = await fixture(t);
    let now = 0;
    const fingerprint = await CodeFingerprint.start(f.root, join(f.root, 'public'), () => now);
    const path = join(f.root, 'src', 'example.ts');
    if (kind === 'touch') await utimes(path, new Date(), new Date(Date.now() + 1000));
    if (kind === 'content' || kind === 'throttle') await writeFile(path, 'new content');
    if (kind === 'added') await writeFile(join(f.root, 'src', 'new.ts'), 'new');
    if (kind === 'removed') await rm(path);
    if (kind === 'package') await writeFile(join(f.root, 'package.json'), '{"new":true}');
    if (kind === 'lock') await writeFile(join(f.root, 'package-lock.json'), '{"new":true}');
    if (kind === 'public') await writeFile(join(f.root, 'public', 'app.js'), '// new');
    assert.equal(await fingerprint.ready(), false, 'no pass within 30 seconds of startup');
    now = 30_000;
    const expected = !['unchanged', 'touch'].includes(kind);
    assert.equal(fingerprint.ready(), false, 'due pass returns last known value synchronously');
    if (expected) await until(() => fingerprint.ready());
    else { await new Promise(r => setTimeout(r, 30)); assert.equal(fingerprint.ready(), false); }
    if (kind === 'throttle') {
      await writeFile(path, 'original');
      now = 59_999;
      assert.equal(await fingerprint.ready(), true);
      now = 60_000;
      assert.equal(fingerprint.ready(), true, 'restoration pass also returns the previous value');
      await until(() => !fingerprint.ready());
    }
  });
}

test('restart: npm start returns 409 Terminal and retains session/origin guards', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.app.url + '/api/restart', { method: 'POST' })).status, 403);
  const response = await f.call('/api/restart', 'POST');
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Restart from Terminal' });
  assert.equal(f.exited(), undefined);
});

test('restart: busy returns 409 and status suppresses the bar', async t => {
  const f = await fixture(t, true);
  const meeting = f.app.store.createMeeting('Fictional queue');
  await f.app.store.addPcm(meeting.id, 'file:example', 0, 0, 16_000, Buffer.alloc(64_000));
  assert.equal((await (await f.call('/api/status')).json()).working, true);
  const response = await f.call('/api/restart', 'POST');
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Busy' });
  assert.equal(f.exited(), undefined);
});

test('restart: 202 is flushed before normal shutdown and clean injectable exit', async t => {
  const f = await fixture(t, true);
  assert.equal((await (await f.call('/api/status')).json()).update.canRestart, true);
  const response = await f.call('/api/restart', 'POST');
  assert.equal(response.status, 202); await response.text();
  assert.equal(f.exited(), undefined);
  for (let i = 0; i < 100 && f.exited() === undefined; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(f.exited(), 0);
  await assert.rejects(fetch(f.app.url + '/'));
});

// FIX1: reserve admission before 202, even across slow request bodies and other pages.
test('accepted restart rejects all new mutations with 503 Restarting', async t => {
  const f = await fixture(t, true);
  const meeting = f.app.store.createMeeting('Example restart race');
  assert.equal((await f.call('/api/restart', 'POST')).status, 202);
  for (const path of ['notes', 'actions', 'plans/runs', 'plans/1/plans/p1/explore', 'board/scan', 'glossary/build', 'pcm', 'upload', 'retry', 'memory/update']) {
    const response = await f.call(`/api/meetings/${meeting.id}/${path}`, 'POST', '{}');
    assert.equal(response.status, 503, path); assert.deepEqual(await response.json(), { error: 'Restarting' }, path);
  }
  const download = await f.call('/api/setup/speech/download', 'POST', '{}');
  assert.equal(download.status, 503); assert.deepEqual(await download.json(), { error: 'Restarting' });
  assert.equal(f.app.store.queuedCount(), 0);
});

test('two accepted restarts call shutdown exactly once, without its hurry path', async t => {
  const f = await fixture(t, true);
  const original = f.app.shutdown.bind(f.app); let calls = 0;
  f.app.shutdown = async (...args) => { calls++; await original(...args); };
  assert.equal((await f.call('/api/restart', 'POST')).status, 202);
  assert.equal((await f.call('/api/restart', 'POST')).status, 202);
  assert.equal(calls, 1);
});

test('fixture cleanup waits for accepted restart shutdown before removing its files', async () => {
  const hooks: (() => unknown)[] = [];
  const f = await fixture({ after: fn => { hooks.push(fn); } }, true);
  const close = f.app.close.bind(f.app), shutdown = f.app.shutdown.bind(f.app);
  let pending: Promise<void> | undefined;
  f.app.shutdown = (...args) => { pending = shutdown(...args); return pending; };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const closing = new Promise<void>(resolve => { entered = resolve; });
  f.app.close = async () => { entered(); await gate; await close(); };
  let cleanup: Promise<void> | undefined;
  try {
    assert.equal((await f.call('/api/restart', 'POST')).status, 202);
    cleanup = (async () => { for (const hook of hooks) await hook(); })();
    await Promise.race([closing, cleanup]);
    // Hold shutdown at close: cleanup must not remove files while their owner is still running.
    assert.equal(JSON.parse(await readFile(join(f.app.directory, 'settings.json'), 'utf8')).setupSeen, true);
  } finally {
    release();
    try { await pending; await cleanup; }
    finally { await close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

async function pendingBody(f: Awaited<ReturnType<typeof fixture>>, path: string, payload: string) {
  const req = request(f.app.url + path, { method: 'POST', headers: { Cookie: f.cookie, Origin: f.app.url, 'Content-Length': '999999' } });
  req.on('error', () => {}); req.on('response', res => res.resume());
  req.write(payload);
  // A connected socket is not enough: wait until the server has admitted the body.
  await until(async () => (await (await f.call('/api/status')).json()).working);
  return req;
}

test('an admitted request awaiting its JSON body blocks restart before it can start a job', async t => {
  const f = await fixture(t, true);
  const pending = await pendingBody(f, '/api/meetings', '{');
  try {
    const response = await f.call('/api/restart', 'POST');
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Busy' });
    assert.equal((await (await f.call('/api/status')).json()).working, true);
  } finally { pending.destroy(); }
});

const uploadRecognizer = { available: () => true, async transcribe(): Promise<never> { throw new Error('No transcription expected'); }, close() {} };
test('audio upload/import before any chunks exist blocks restart', async t => {
  const f = await fixture(t, true, { recognizer: uploadRecognizer });
  const meeting = f.app.store.createMeeting('Example slow import');
  const pending = await pendingBody(f, `/api/meetings/${meeting.id}/upload`, 'example media prefix');
  try {
    assert.equal(f.app.store.queuedCount(), 0);
    assert.equal((await (await f.call('/api/status')).json()).working, true);
    const response = await f.call('/api/restart', 'POST');
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Busy' });
  } finally { pending.destroy(); }
});

test('idle exit also waits for an upload/import before chunks exist', async t => {
  let idle = 0;
  const f = await fixture(t, true, { recognizer: uploadRecognizer, idleMs: 1000, onIdle: () => { idle++; } });
  await fetch(f.app.url + '/api/status', { headers: { Cookie: f.cookie, 'X-Page': 'example-upload-page' } });
  const meeting = f.app.store.createMeeting('Example idle import');
  const pending = await pendingBody(f, `/api/meetings/${meeting.id}/upload`, 'example media prefix');
  try {
    await f.call('/api/bye?page=example-upload-page', 'POST');
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(f.app.store.queuedCount(), 0); assert.equal(idle, 0, 'no page, but an import is still being admitted');
  } finally { pending.destroy(); }
  await until(() => idle === 1);
});

for (const tree of ['src', 'public']) {
  test(`unreadable ${tree} file does not stop startup or status, and is logged once`, async t => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
    const f = await fixture(t, false, {}, async root => {
      const path = join(root, tree, 'unreadable-example.txt'); await writeFile(path, 'example'); await chmod(path, 0);
    });
    assert.equal((await f.call('/api/status')).status, 200);
    assert.equal((await (await f.call('/api/status')).json()).update.ready, false);
    f.advance(); await f.call('/api/status'); await new Promise(r => setTimeout(r, 50));
    assert.equal((await f.call('/api/status')).status, 200);
    assert.equal(warnings.filter(w => w.includes('unreadable-example.txt')).length, 1);
    await chmod(join(f.root, tree, 'unreadable-example.txt'), 0o600);
    f.advance(); await until(async () => (await (await f.call('/api/status')).json()).update.ready);
  });
}

test('a file becoming unreadable counts as absent without breaking status', async t => {
  const f = await fixture(t);
  await chmod(join(f.root, 'src', 'example.ts'), 0); f.advance();
  await until(async () => (await (await f.call('/api/status')).json()).update.ready);
  assert.equal((await f.call('/api/status')).status, 200);
});

test('fingerprint answers immediately while one background read is held, throttled and single-flight', async t => {
  const f = await fixture(t);
  let now = 0, hold = false, reads = 0;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const fingerprint = await CodeFingerprint.start(f.root, join(f.root, 'public'), () => now, {
    read: async path => { reads++; if (hold) await gate; return readFile(path); },
  });
  const baselineReads = reads;
  await writeFile(join(f.root, 'src', 'example.ts'), 'new bytes'); hold = true; now = 30_000;
  try {
    assert.equal(fingerprint.ready(), false);
    await until(() => reads > baselineReads);
    for (let i = 0; i < 30; i++) assert.equal(fingerprint.ready(), false);
    assert.equal(reads, baselineReads + 1, 'only the changed file is rehashed, once');
  } finally { release(); }
  await until(() => fingerprint.ready());
  now = 59_999; assert.equal(fingerprint.ready(), true); assert.equal(reads, baselineReads + 1);
});

test('status does not await a slow background fingerprint pass', async t => {
  let hold = false, reading = false;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const f = await fixture(t, false, { fingerprint: { read: async path => {
    if (hold) { reading = true; await gate; } return readFile(path);
  } } });
  await writeFile(join(f.root, 'src', 'example.ts'), 'new bytes'); hold = true; f.advance();
  try {
    const first = await f.call('/api/status'); assert.equal(first.status, 200);
    assert.equal((await first.json()).update.ready, false);
    await until(() => reading);
    for (let i = 0; i < 3; i++) {
      const response = await fetch(f.app.url + '/api/status', { headers: { Cookie: f.cookie }, signal: AbortSignal.timeout(500) });
      assert.equal(response.status, 200); assert.equal((await response.json()).update.ready, false);
    }
  } finally { release(); }
  await until(async () => (await (await f.call('/api/status')).json()).update.ready);
});
