import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

const notice = 'HearAlong is now an app on your Mac. Open HearAlong from your Applications folder. You can remove this Chrome version: open chrome://apps, right-click HearAlong, Remove from Chrome.';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-packaged-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.HEARALONG_PACKAGED;
  process.env.HEARALONG_PACKAGED = '1';
  t.after(() => { if (previous === undefined) delete process.env.HEARALONG_PACKAGED; else process.env.HEARALONG_PACKAGED = previous; });
  const publicRoot = join(directory, 'public');
  await cp(new URL('../public/', import.meta.url), publicRoot, { recursive: true });
  return { directory, port: 0, publicRoot, setup: await dashboardSetup(directory, true), quick: null, heavy: null, recognizer: null, drafts: null };
}

test('packaged HTTP dashboard, setup and worker contain the migration notice and a complete offline page', async t => {
  const options = await fixture(t);
  const app = await startServer(options);
  try {
    for (const path of ['/', '/setup', '/setup.html']) {
      const response = await fetch(app.url + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok((await response.text()).includes(`data-chrome-upgrade="${notice}"`), path);
    }
    const response = await fetch(app.url + '/sw.js');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const worker = await response.text();
    const offline = JSON.parse(worker.match(/^const OFFLINE_PAGE = (.+);$/m)![1]) as string;
    assert.ok(offline.includes(notice));
    assert.match(offline, /<h1 id="title">HearAlong<\/h1>/);
    assert.match(offline, /<style>/);
    assert.doesNotMatch(offline, /<script|<button|meetingassistant:|HearAlong Helper/);
  } finally { await app.close(); }
});

test('each packaged rewrite fails startup on missing or ambiguous markup in tests', async t => {
  const options = await fixture(t);
  for (const [file, marker] of [
    ['index.html', '<html lang="en">'], ['setup.html', '<html lang="en">'],
    ['starting.html', '<link rel="stylesheet" href="/starting.css">'],
    ['starting.html', 'Starting HearAlong…'], ['starting.html', 'This takes a few seconds.'],
    ['starting.html', '  <button id="retry" type="button" hidden>Try again</button>\n'],
    ['starting.html', '<script src="/starting.js"></script>'], ['sw.js', "const OFFLINE_PAGE = '';"],
  ]) {
    const path = join(options.publicRoot, file), original = await readFile(path, 'utf8');
    for (const replacement of ['', marker + marker]) {
      await writeFile(path, original.replace(marker, replacement));
      await assert.rejects(startServer(options), /Packaged Chrome migration rewrite did not match exactly once/);
    }
    await writeFile(path, original);
  }
  // Failed rewrites release the directory lock and leave no partial startup behind.
  const app = await startServer(options);
  await app.close();
});

test('production logs rewrite drift once per startup instead of silently ignoring it', async t => {
  const options = await fixture(t);
  for (const file of ['index.html', 'setup.html']) {
    const path = join(options.publicRoot, file);
    await writeFile(path, (await readFile(path, 'utf8')).replace('<html lang="en">', '<html lang="en-US">'));
  }
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const app = await startServer(options);
    await app.close();
    assert.equal(warnings.filter(message => message.includes('Packaged Chrome migration rewrite')).length, 1);
  } finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
});
