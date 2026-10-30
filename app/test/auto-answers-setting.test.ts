import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

test('autoAnswers defaults on, validates booleans, survives restart and is available locally but not Off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-answers-setting-'));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const setup = await dashboardSetup(directory);
    const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...saved, aiMode: 'local' }));
    const start = () => startServer({ directory, port: 0, setup, recognizer: null, drafts: null, quick: null, heavy: null,
      board: async () => { throw new Error('No inference expected.'); } });
    app = await start();
    let cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const request = (value?: object) => fetch(`${app!.url}/api/settings`, { method: value ? 'PUT' : 'GET',
      headers: { Cookie: cookie, Origin: app!.url, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
    let settings = await (await request()).json();
    assert.equal(settings.autoAnswers, true);
    assert.equal(settings.autoAnswersEnabled, true, 'On this Mac can answer automatically after recording');
    for (const autoAnswers of ['false', 0, null]) assert.equal((await request({ autoAnswers })).status, 400);
    settings = await (await request({ autoAnswers: false })).json();
    assert.equal(settings.autoAnswers, false);
    await app.close(); app = undefined;
    app = await start(); cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await (await request()).json()).autoAnswers, false);
    const response = await fetch(`${app.url}/api/setup/ai`, { method: 'PUT', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'off' }) });
    assert.equal(response.status, 200);
    assert.equal((await (await request()).json()).autoAnswersEnabled, false);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
