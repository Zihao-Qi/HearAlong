import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

async function fixture(t: { after(fn: () => unknown): void }, ready = false, ai?: NonNullable<Parameters<typeof startServer>[0]>['ai']) {
  const directory = await mkdtemp(join(tmpdir(), 'setup-page-'));
  const setup = ready ? await dashboardSetup(directory, true) : {
    scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: false }),
  };
  const app = await startServer({ directory, port: 0, setup, ai, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await fetch(`${app.url}/setup`), Cookie = page.headers.get('set-cookie')!.split(';')[0];
  const setSeen = (setupSeen: boolean) => fetch(`${app.url}/api/settings`, { method: 'PUT', headers: { Cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ setupSeen }) });
  const root = () => fetch(app.url, { redirect: 'manual' });
  return { directory, app, page, Cookie, setSeen, root };
}

test('setup is directly reachable, establishes the same session and uses the page guards and headers', async t => {
  const f = await fixture(t);
  assert.equal(f.page.status, 200); assert.match(await f.page.text(), /Set up HearAlong/);
  assert.match(f.page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(f.page.headers.get('cache-control'), 'no-store');
  const api = await fetch(`${f.app.url}/api/setup`, { headers: { Cookie: f.Cookie } }); assert.equal(api.status, 200);
  for (const asset of ['setup.js', 'setup-ui.js', 'setup.css']) assert.equal((await fetch(`${f.app.url}/${asset}`)).status, 200);
  assert.equal((await fetch(`${f.app.url}/setup`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('unseen always redirects; seen missing requirements redirect only before any meeting exists', async t => {
  const f = await fixture(t);
  let response = await f.root(); assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/setup');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(await response.text(), '');
  assert.equal((await f.setSeen(true)).status, 200); assert.equal((await f.root()).status, 302);
  f.app.store.createMeeting('Example readable meeting'); assert.equal((await f.root()).status, 200);
  await f.setSeen(false); assert.equal((await f.root()).status, 302);
});

test('a ready returning user with no meetings opens the dashboard; first-open optional setup is still offered', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.root()).status, 200);
  await f.setSeen(false); assert.equal((await f.root()).status, 302);
  const response = await fetch(`${f.app.url}/api/setup`, { headers: { Cookie: f.Cookie } });
  const status = await response.json(); assert.equal(typeof status.rows.find((r: { id: string }) => r.id === 'ai').signInCommand, 'string');
});

test('without a Pi on PATH or an override, sign-in uses npx only inside the prototype folder', async t => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' }; delete env.MEETING_PI;
  const f = await fixture(t, false, { env, root: join(tmpdir(), 'example-no-bundled-pi') });
  const status = await (await fetch(`${f.app.url}/api/setup`, { headers: { Cookie: f.Cookie } })).json();
  assert.match(status.rows.find((r: { id: string }) => r.id === 'ai').signInCommand, /^cd '.+\/prototype' && npx pi$/);
});
