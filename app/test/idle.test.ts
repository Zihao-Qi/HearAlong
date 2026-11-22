import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { idleStopMessage, type IdleReason } from '../src/lifecycle-log.ts';

test('no page connected: preserve the 60 s grace and idle delay, and report why', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-no-page-idle-'));
  const reasons: IdleReason[] = [];
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 1000, onIdle: reason => { reasons.push(reason); } });
  try {
    t.mock.timers.tick(59_000);
    assert.deepEqual(reasons, [], 'no early idle');
    t.mock.timers.tick(1000);
    assert.deepEqual(reasons, [], 'grace ends, idle delay begins');
    t.mock.timers.tick(1000);
    assert.deepEqual(reasons, ['no-page']);
    assert.equal(idleStopMessage(reasons[0]), 'No page ever connected within 60 s and nothing is running: stopping.');
    t.mock.timers.tick(5000);
    assert.equal(reasons.length, 1, 'only one idle callback');
  } finally { t.mock.timers.reset(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('helper status polling does not keep a closed, idle server alive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-helper-idle-'));
  let idleAt = 0;
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 2200, onIdle: () => { idleAt ||= Date.now(); } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie, Origin: app.url };
    await fetch(`${app.url}/api/status`, { headers: { ...headers, 'X-Page': 'window' } });
    await fetch(`${app.url}/api/bye?page=window`, { method: 'POST', headers });
    const poll = async () => {
      const res = await fetch(`${app.url}/api/helper/status`, { headers });
      assert.equal(res.status, 200);
      const status = await res.json();
      assert.deepEqual([status.pageOpen, status.working], [false, false]);
    };
    const bye = Date.now();
    for (let i = 0; i < 4 && !idleAt; i++) { await poll(); await new Promise(r => setTimeout(r, 2000)); }
    assert.ok(idleAt && idleAt - bye >= 2200 && idleAt - bye < 5000, `idled despite repeated helper polls (${idleAt - bye} ms)`);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

// The installed app (M7): the server stops by itself once its window is gone and nothing runs; an open page keeps it.
test('the server reports idle once the last open page says goodbye, and not while a page is open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-idle-'));
  let idleAt = 0;
  let idleReason: IdleReason | undefined;
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 1000, onIdle: reason => { idleAt = Date.now(); idleReason = reason; } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, page: string, method = 'GET') => fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'X-Page': page } });
    assert.equal((await call('/api/status', 'window-1')).status, 200);
    assert.equal((await call('/api/status', 'window-2')).status, 200);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(idleAt, 0, 'two windows open: not idle');
    assert.equal((await call('/api/bye?page=window-1', 'window-1', 'POST')).status, 204);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(idleAt, 0, 'one window still open: not idle');
    const bye = Date.now();
    await call('/api/bye?page=window-2', 'other', 'POST');
    await fetch(`${app.url}/api/bye?page=other`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
    for (let i = 0; i < 40 && !idleAt; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(idleAt && idleAt - bye >= 900 && idleAt - bye < 3500, `idle about a second after the last goodbye (${idleAt - bye} ms)`);
    assert.equal(idleReason, 'last-page-closed');
    assert.equal(idleStopMessage(idleReason), 'The last page closed and nothing is running: stopping.');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

// #71: a request already on its way when the window closed can arrive after the goodbye beacon (another connection).
test('a request that arrives after its page\'s goodbye does not reopen the page; a restored page counts again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-late-page-'));
  const reasons: IdleReason[] = [];
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 1000, onIdle: reason => { reasons.push(reason); } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, page: string, seq?: number, method = 'GET') => {
      const res = await fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'X-Page': page, ...(seq === undefined ? {} : { 'X-Page-Seq': String(seq) }) } });
      assert.ok(res.ok, `${path}: ${res.status}`); await res.arrayBuffer();
    };
    // A restored page (back/forward cache) goes on numbering after its goodbye, so it is open again.
    await call('/api/status', 'restored', 1);
    await call('/api/bye?page=restored&seq=1', 'restored', 2, 'POST');
    await call('/api/status', 'restored', 3);
    // The closing page: its goodbye covers request 2; request 2 lands afterwards.
    await call('/api/status', 'closing', 1);
    await call('/api/status', 'closing', 2);
    await fetch(`${app.url}/api/bye?page=closing&seq=2`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
    await call('/api/status', 'closing', 2);
    t.mock.timers.tick(5000);
    assert.deepEqual(reasons, [], 'the restored page is open');
    await fetch(`${app.url}/api/bye?page=restored&seq=3`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
    t.mock.timers.tick(1000);
    assert.deepEqual(reasons, [], 'the idle delay begins');
    t.mock.timers.tick(1000);
    assert.deepEqual(reasons, ['last-page-closed'], 'the late request did not keep the closed page open');
  } finally { t.mock.timers.reset(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an older page without request numbers still counts as open on every request, as before', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-unnumbered-page-'));
  const reasons: IdleReason[] = [];
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 1000, onIdle: reason => { reasons.push(reason); } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie, Origin: app.url, 'X-Page': 'old' };
    await (await fetch(`${app.url}/api/status`, { headers })).arrayBuffer();
    await (await fetch(`${app.url}/api/bye?page=old`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } })).arrayBuffer();
    await (await fetch(`${app.url}/api/status`, { headers })).arrayBuffer();
    t.mock.timers.tick(5000);
    assert.deepEqual(reasons, [], 'its next request opened it again');
  } finally { t.mock.timers.reset(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
