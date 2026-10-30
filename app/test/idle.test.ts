import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

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
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 1000, onIdle: () => { idleAt = Date.now(); } });
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
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
