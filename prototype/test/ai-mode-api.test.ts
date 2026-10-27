import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { AiSetup, type AiSettings } from '../src/setup/ai.ts';
import { runPiTask } from '../src/pi-task.ts';
import { PiRpc } from '../src/pi-rpc.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';

async function fixture(t: any, saved: object, rows: string[], realAI = false) {
  let remove!: () => unknown;
  const f = await fakePi({ after: fn => { remove = fn; } }, { table: rows.length ? table(rows) : 'No models available.' });
  const directory = join(f.directory, 'data'); await mkdir(directory);
  await writeFile(join(directory, 'settings.json'), JSON.stringify(saved));
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: realAI ? undefined : null, heavy: realAI ? undefined : null, board: realAI ? undefined : null,
    ai: { env: f.env }, setup: { scan: { home: f.directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  t.after(async () => { await app.close(); await remove(); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', value?: object) => fetch(app.url + path, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
  await request('/api/setup/ai/models');
  const settings = async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  return { ...f, app, request, settings };
}
const cloud = ['example main 32K 4K no no', 'example quick 32K 4K no no'];
const local = ['ollama example:8b 32K 4K no no'];
for (const [seen, rows, expected] of [[false, cloud, 'off'], [false, [...cloud, ...local], 'local'], [true, cloud, 'cloud'], [true, local, 'local'], [true, [], 'off']] as const) {
  test(`server migrates setupSeen=${seen}, models=${rows.length} to ${expected}`, async t => {
    const f = await fixture(t, { setupSeen: seen }, [...rows]);
    const saved = await f.settings(); assert.equal(saved.aiMode, expected);
    assert.equal(saved.cloudNotice, seen && expected === 'cloud');
    if (expected === 'cloud') { assert.equal(saved.cloudConsent.legacy, true); assert.deepEqual(saved.cloudConsent.providers, ['example']); }
  });
}

test('Off hides real AI feature availability and refuses jobs without an inference spawn', async t => {
  const f = await fixture(t, { aiMode: 'off' }, cloud, true);
  const meeting = f.app.store.createMeeting('Example transcription only');
  for (const feature of ['notes', 'actions', 'board', 'plans']) {
    const status = await (await f.request(`/api/meetings/${meeting.id}/${feature}`)).json();
    assert.equal(status.enabled, false, feature);
  }
  for (const feature of ['notes', 'actions', 'board/scan', 'plans/runs', 'glossary/build']) assert.equal((await f.request(`/api/meetings/${meeting.id}/${feature}`, 'POST', {})).status, 409, feature);
  assert.equal((await f.calls()).some(call => call.args.includes('json') || call.args.includes('rpc')), false);
});

for (const mode of ['local', 'off'] as const) test(`changing Cloud to ${mode} ends active tasks and warm RPC processes`, async t => {
  const f = await fixture(t, { aiMode: 'cloud', mainModel: 'example/main', quickModel: 'example/quick', cloudConsent: { providers: ['example'], time: 1 } }, [...cloud, ...local], true);
  await f.configure({ table: table([...cloud, ...local]), taskDelay: 5000 });
  const task = assert.rejects(runPiTask('Example long job', { model: 'example/main', cwd: f.cwd, env: f.env, tools: null }), /cancelled/);
  const rpc = new PiRpc({ model: 'example/main', cwd: f.cwd, env: f.env });
  const request = assert.rejects(rpc.ask('Example long request'), /restarted|exited/i);
  await until(async () => (await f.calls()).filter(call => call.args.includes('json') || call.args.includes('rpc')).length === 2);
  const response = await f.request('/api/setup/ai', 'PUT', { mode, ...(mode === 'local' ? { main: 'ollama/example:8b', quick: 'ollama/example:8b' } : {}) });
  assert.equal(response.status, 200);
  await Promise.all([task, request]); await rpc.close();
  if (mode === 'local') {
    const meeting = f.app.store.createMeeting('Example offline lookup');
    const response = await f.request(`/api/meetings/${meeting.id}/actions`, 'POST', { action: 'lookUp' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Web lookups are unavailable in On this Mac mode.');
  }
});

test('cloud consent is enforced when saving; a new provider asks again', async t => {
  const f = await fixture(t, { aiMode: 'off' }, [...cloud, 'other main 32K 4K no no']);
  const pair = { mode: 'cloud', main: 'example/main', quick: 'example/quick' };
  let response = await f.request('/api/setup/ai', 'PUT', pair);
  assert.equal(response.status, 400); assert.match((await response.json()).error, /Send this/);
  assert.equal((await f.settings()).aiMode, 'off');
  assert.equal((await f.request('/api/setup/ai', 'PUT', { ...pair, consent: true })).status, 200);
  assert.deepEqual((await f.settings()).cloudConsent.providers, ['example']);
  response = await f.request('/api/setup/ai', 'PUT', { ...pair, main: 'other/main' });
  assert.equal(response.status, 400);
});

test('a server-side model requirement refuses a cloud run without stored consent', async t => {
  const f = await fakePi(t, { table: table(cloud) });
  const settings: AiSettings = { aiMode: 'cloud', mainModel: 'example/main', quickModel: 'example/quick' };
  const ai = new AiSetup(() => settings, async () => {}, { cloud: true, cwd: f.cwd, env: f.env });
  t.after(() => ai.close());
  await assert.rejects(ai.require('main'), /consent/i);
  assert.equal((await f.calls()).some(call => call.args.includes('json') || call.args.includes('rpc')), false);
});

test('a temporary catalog failure defers legacy migration instead of turning cloud off', async t => {
  const f = await fakePi(t, { table: 'unreadable catalog' });
  let settings: AiSettings = { setupSeen: true, mainModel: 'example/main', quickModel: 'example/quick' };
  const ai = new AiSetup(() => settings, async next => { settings = next; }, { cloud: true, cwd: f.cwd, env: f.env });
  t.after(() => ai.close()); ai.start();
  await ai.models(); assert.equal(settings.aiMode, undefined);
  await assert.rejects(ai.require('main'), /waiting for model discovery/);
  await f.configure({ table: table(cloud) }); await ai.recheck();
  assert.equal(settings.aiMode, 'cloud'); assert.equal(settings.cloudConsent?.legacy, true);
});

for (const seen of [false, true]) test(`forced Off on an unmigrated install (setupSeen=${seen}) makes no Pi calls`, async t => {
  const f = await fakePi(t, { table: table(cloud) });
  let settings: AiSettings = { setupSeen: seen, mainModel: null, quickModel: null };
  const ai = new AiSetup(() => settings, async next => { settings = next; }, { cloud: false, cwd: f.cwd, env: f.env });
  t.after(() => ai.close()); ai.start(); await ai.models();
  assert.equal(ai.mode(), 'off'); assert.equal((await f.calls()).length, 0);
  assert.equal(settings.aiMode, seen ? undefined : 'off');
});

test('legacy cloud notice dismisses once without dropping consent', async t => {
  const f = await fixture(t, { setupSeen: true }, cloud);
  assert.equal((await f.settings()).cloudNotice, true);
  assert.equal((await f.request('/api/setup/ai/notice', 'POST', {})).status, 200);
  assert.equal((await f.settings()).cloudNotice, false);
  assert.equal((await f.settings()).cloudConsent.legacy, true);
  const snapshot = await (await f.request('/api/setup')).json();
  assert.equal(snapshot.rows.find((row: any) => row.id === 'ai').cloudNotice, false);
  await until(async () => (await f.calls()).every(call => !call.args.includes('json')));
});
