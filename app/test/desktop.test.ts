// No Electron import/download: these policies run in Linux CI too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
const require = createRequire(import.meta.url);
const { locations } = require('../desktop/locations.cjs');
const { ServerSession, availablePort, serverEnvironment } = require('../desktop/server.cjs');
const { backgroundLabel, backgroundVisible, backgroundQuitText, miniVisible, serverExit, permissionAllowed, navigation, launcherLogLines } = require('../desktop/policy.cjs');

test('desktop paths use Node 22 outside Electron and keep Chromium separate from meetings', () => {
  const config = locations({ HEARALONG_NODE: process.execPath, MEETING_DATA_DIR: '/tmp/fictional-meetings', PORT: '54321' });
  assert.equal(config.node, process.execPath);
  assert.equal(config.entry, join(config.root, 'src/server.ts'));
  assert.equal(config.data, '/tmp/fictional-meetings');
  assert.equal(config.log, join(config.data, 'logs/launcher.log'));
  assert.equal(config.userData, join(dirname(config.data), 'Electron'));
  assert.equal(config.port, 54321);
  assert.equal(locations({ HEARALONG_NODE: process.execPath }).port, 4318);
  assert.equal(locations({ PATH: dirname(process.execPath) }).node, process.execPath);
  assert.throws(() => locations({ PATH: '' }), /Node 22/);
  for (const PORT of ['0', '-1', '65536', 'bad']) assert.throws(() => locations({ PORT }), /PORT/);
});
test('desktop test-only entry and fake switches cannot be enabled in packaged builds', () => {
  const env = { HEARALONG_NODE: process.execPath, HEARALONG_DESKTOP_TEST: '1' };
  assert.equal(locations(env).testing, true);
  assert.match(locations(env).entry, /fixture-server.ts$/);
  assert.equal(locations({ ...env, HEARALONG_DESKTOP_TEST: '0' }).testing, false);
  const config = locations({ ...env, PORT: '9999', MEETING_DATA_DIR: '/ignored' }, true, '/fictional/HearAlong.app/Contents/Resources', '/fictional/home');
  assert.equal(config.testing, false);
  assert.equal(config.packaged, true);
  assert.equal(config.node, '/fictional/HearAlong.app/Contents/Resources/bin/node');
  assert.equal(config.entry, '/fictional/HearAlong.app/Contents/Resources/server/src/server.ts');
  assert.equal(config.pdfText, '/fictional/HearAlong.app/Contents/Resources/bin/pdf-text');
  assert.equal(config.data, '/fictional/home/Library/Application Support/HearAlong/data');
  assert.equal(config.userData, '/fictional/home/Library/Application Support/HearAlong/Electron');
  assert.equal(config.log, join(config.data, 'logs/launcher.log'));
  assert.equal(config.port, 4318);
});
test('packaged server has a Dock-safe PATH, bundled Pi/Node and extractor, never development test switches', () => {
  const config = locations({}, true, '/fictional/Resources', '/fictional/home');
  const env = serverEnvironment(config, { PATH: '/untrusted', PORT: '9999', NODE_OPTIONS: '--inspect', NODE_PATH: '/bad',
    HEARALONG_DESKTOP_TEST: '1', MEETING_TEST_RECOGNIZER: 'scripted', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin:/fictional/Resources/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.equal(env.MEETING_PI, '/fictional/Resources/server/node_modules/.bin/pi');
  assert.equal(env.HEARALONG_PDF_TEXT, config.pdfText);
  assert.equal(env.HEARALONG_PACKAGED, '1');
  assert.equal(env.MEETING_OPEN_BROWSER, '0'); assert.equal(env.PORT, '4318');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'HEARALONG_DESKTOP_TEST', 'MEETING_TEST_RECOGNIZER']) assert.equal(env[key], undefined);
  const dev = serverEnvironment({ ...config, packaged: false }, { PATH: '/dev-path', HEARALONG_DESKTOP_TEST: '1' });
  assert.equal(dev.PATH, '/dev-path'); assert.equal(dev.HEARALONG_DESKTOP_TEST, '1');
});
test('background labels and visibility match the helper', () => {
  assert.equal(backgroundLabel({ label: '  Writing notes  ' }), 'Writing notes');
  assert.equal(backgroundLabel({ label: '  ' }), 'Finishing work in the background');
  for (const owned of [true, false]) for (const pageOpen of [true, false]) for (const working of [true, false]) {
    assert.equal(backgroundVisible({ pageOpen, working }, owned), owned && !pageOpen && working);
  }
  assert.equal(backgroundVisible(null, true), false);
});
test('all quit wording matches backgroundQuitText including title truncation', () => {
  const titles = { notes: 'notes are being written', plans: 'plans are being made', actions: 'answers are being written',
    transcription: 'audio is being transcribed', import: 'audio is being imported', download: 'the speech model is being downloaded',
    memory: 'memory is being updated', board: 'the Board is being scanned', corrections: 'the transcript is being corrected',
    glossary: 'the glossary is being built', recording: 'audio is being recorded', replay: 'audio is being replayed', other: 'work is running' };
  for (const [kind, text] of Object.entries(titles)) {
    const wording = backgroundQuitText({ kind });
    assert.equal(wording.title, `Quit while ${text}?`);
    if (!['notes', 'plans'].includes(kind)) assert.equal(wording.text, 'This work stops now.');
  }
  assert.equal(backgroundQuitText({ kind: 'notes' }).text, 'The notes for this meeting stop now. You can write them again from the Notes tab.');
  assert.equal(backgroundQuitText({ kind: 'plans', title: '  Lantern review  ' }).text, 'The plans for Lantern review stop now. You can make them again from the Plans tab.');
  assert.match(backgroundQuitText({ kind: 'notes', title: 'a'.repeat(41) }).text, new RegExp('a{39}… stop'));
});
test('mini requires a current server session, server show, and another app in front', () => {
  for (const session of [null, 1]) for (const show of [true, false]) for (const front of [true, false]) {
    assert.equal(miniVisible({ session, show }, front), session !== null && show && !front);
  }
  assert.equal(miniVisible(undefined, false), false);
});
test('server exit owns app lifetime', () => {
  assert.equal(serverExit(0, false), 'quit'); assert.equal(serverExit(1, false), 'error');
  assert.equal(serverExit(null, false), 'error'); assert.equal(serverExit(1, true), 'stopping');
});
test('only own-origin top-frame audio is allowed for checks and requests', () => {
  const origin = 'http://127.0.0.1:54321';
  for (const permission of ['media', 'camera', 'notifications', 'geolocation', 'display-capture', 'openExternal']) {
    for (const requestingOrigin of [origin, 'https://example.invalid', 'file://']) for (const isMainFrame of [true, false]) {
      assert.equal(permissionAllowed(origin, permission, requestingOrigin, { isMainFrame, mediaTypes: ['audio'] }), permission === 'media' && requestingOrigin === origin && isMainFrame);
    }
  }
  assert.equal(permissionAllowed(origin, 'media', origin, { isMainFrame: true, mediaType: 'audio' }), true);
  for (const mediaTypes of [[], ['video'], ['audio', 'video']]) assert.equal(permissionAllowed(origin, 'media', origin, { isMainFrame: true, mediaTypes }), false);
  assert.equal(permissionAllowed(origin, 'media', origin, {}), false);
});
test('navigation confines windows and opens only http(s) externally', () => {
  const origin = 'http://127.0.0.1:54321';
  assert.equal(navigation(origin, origin + '/mini.html'), 'allow');
  for (const url of ['https://example.invalid/', 'http://localhost:54321']) assert.equal(navigation(origin, url), 'external');
  for (const url of ['javascript:alert(1)', 'file:///tmp/fixture', 'x-apple.systempreferences:other', 'data:text/html,x', 'invalid']) assert.equal(navigation(origin, url), 'deny');
});
test('launcher logs have local ISO seconds and prefix every line, matching #55', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5, 999);
  const lines = launcherLogLines('one\r\ntwo\rthree\n', date).trimEnd().split('\n');
  assert.equal(lines.length, 4);
  const prefix = lines[0].split(' ')[0];
  assert.match(prefix, /^2026-01-02T03:04:05(?:Z|[+-]\d\d:\d\d)$/);
  assert.equal(lines[1], `${prefix} two`); assert.equal(lines[2], `${prefix} three`);
});

test('startup accepts the onboarding redirect, shares/renews its cookie, and never claims page presence', async () => {
  const requests: { url: string | undefined; cookie: string | undefined; page: string | string[] | undefined; origin: string | undefined }[] = [];
  let renew = false;
  const server = createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie, page: req.headers['x-page'], origin: req.headers.origin });
    if (req.url === '/') { res.writeHead(302, { 'Set-Cookie': 'meeting_session=fictional; HttpOnly', Location: '/setup' }).end(); return; }
    if (renew) { renew = false; res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ meetings: [], config: {} }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const client = new ServerSession(origin);
    assert.equal(await client.ready(), true);
    assert.equal(requests[1].cookie, 'meeting_session=fictional');
    renew = true;
    await assert.rejects(client.request('/api/live/window'), /Session renewed/);
    await client.request('/api/live/mini', { session: 1, action: 'closed' });
    assert.equal(requests.at(-1)?.origin, origin);
    assert.ok(requests.every(request => request.page === undefined));
    await assert.rejects(availablePort({ port: address.port }), /used by another program/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  await availablePort({ port: address.port });
});
