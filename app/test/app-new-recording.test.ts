import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const code = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const controls = code.slice(code.indexOf('function replayPlaying()'), code.indexOf('// ---------- Notes'));

test('recording controls distinguish recorded, empty, absent and replay meetings, without a cross-page lock', () => {
  for (const kind of ['recorded', 'empty', 'none', 'replay']) for (const unavailable of [false, true]) {
    const nodes: Record<string, any> = {};
    const $ = (id: string) => nodes[id] ??= { classList: { toggle() {} }, querySelectorAll: () => [], setAttribute() {} };
    const meeting = kind === 'none' ? undefined : { id: 'owner', recorded: kind === 'recorded', replay: kind === 'replay' ? 'file' : null };
    const context = { $, document: { body: { classList: { toggle() {} } } }, capture: null, busy: false, requestingMic: false,
      quitView: { seen: false }, meetingId: meeting?.id ?? null, status: { config: { available: !unavailable }, meetings: meeting ? [meeting] : [], recordingAnywhere: true },
      lastSnapshot: { meetingId: meeting?.id, replay: false }, callMenuAnchor: null, closeStartMenu() {} };
    runInNewContext(`${controls}\ncontrols();`, context);
    assert.equal($('start').hidden, kind === 'none' || kind === 'replay', kind);
    assert.equal($('start-new').hidden, kind === 'empty', kind);
    assert.equal($('start-new').disabled, unavailable, 'another page recording adds no lock, as for Start');
    assert.equal($('start').disabled, unavailable || kind === 'none');
    assert.equal($('start').innerHTML, `${kind === 'recorded' ? 'Continue' : 'Start'}<span class="wide-only">&nbsp;recording</span>`);
    assert.equal($('start').className, kind === 'recorded' ? 'button' : 'button primary');
    for (const lock of ['busy', 'requestingMic', 'quitting', 'replay']) {
      const locked = { ...context, busy: lock === 'busy', requestingMic: lock === 'requestingMic', quitView: { seen: lock === 'quitting' }, lastSnapshot: { meetingId: meeting?.id, replay: lock === 'replay' ? { positionMs: 0, durationMs: 1000 } : null } };
      runInNewContext(`${controls}\ncontrols();`, locked);
      assert.equal($('start-new').disabled, true, lock);
    }
    runInNewContext(`${controls}\ncontrols();`, { ...context, capture: { sources: new Map() }, nativeMini: () => false, miniSupported: () => false });
    assert.equal($('start').hidden, true); assert.equal($('start-new').hidden, true);
  }
});

test('finished replay enables New recording, and unchanged controls preserve the Start child node', () => {
  const nodes: Record<string, any> = {};
  const $ = (id: string) => nodes[id] ??= { classList: { toggle() {} }, querySelectorAll: () => [], setAttribute() {} };
  let html = '', child = {}, writes = 0;
  Object.defineProperty($('start'), 'innerHTML', { get: () => html, set(value) { html = value; child = {}; writes++; } });
  const context = { $, document: { body: { classList: { toggle() {} } } }, capture: null, busy: false, requestingMic: false,
    quitView: { seen: false }, meetingId: 'owner', status: { config: { available: true }, meetings: [{ id: 'owner', recorded: true, replay: 'file' }] },
    lastSnapshot: { meetingId: 'owner', replay: { positionMs: 1000, durationMs: 1000 } }, callMenuAnchor: null };
  runInNewContext(`${controls}\ncontrols();`, context);
  const first = child;
  runInNewContext(`${controls}\ncontrols();`, context);
  assert.equal(child, first); assert.equal(writes, 1);
  assert.equal($('start-new').disabled, false);
  assert.equal($('start').disabled, true, 'Start retains its existing replay rule');
  context.lastSnapshot.replay.positionMs = 999;
  runInNewContext(`${controls}\ncontrols();`, context);
  assert.equal($('start-new').disabled, true);
});

test('fresh starts pick a tab before creating, release it on creation failure, and retain an empty meeting on mic failure', async () => {
  const start = code.slice(code.indexOf('async function startRecording('), code.indexOf('/** Adds the picked tab'));
  for (const online of [false, true]) for (const app of [null, { id: 'fictional', name: 'Fictional call' }]) for (const failure of ['create', 'mic']) {
    const events: string[] = [];
    const stream = { getTracks: () => [{ stop() { events.push('release tab'); } }] };
    const context = { closeStartMenu() {}, micTest: null, base: () => `/api/meetings/${context.meetingId}`, meetingId: 'old', captureGeneration: 0,
      pickMeetingTab: () => { events.push('picker'); return Promise.resolve(stream); }, requestingMic: false,
      listen: { recording() {} }, controls() {}, quitView: { seen: false }, capture: undefined,
      menuProjectId: () => 'project', closeMeetingMenu() { events.push('close menu'); },
      post: async (_path: string, body: any) => { events.push('create'); assert.equal(body.projectId, 'project'); assert.equal(body.autoTitle, true); assert.match(body.title, /^Meeting /); if (failure === 'create') throw new Error('create failed'); return { id: 'fresh' }; },
      selectMeeting(id: string) { events.push('select'); context.meetingId = id; }, refreshStatus: async () => { events.push('refresh'); },
      api: async (path: string) => { events.push(path); return { chunks: [] }; },
      navigator: { mediaDevices: { getUserMedia: async () => { events.push('mic'); throw new Error('mic failed'); } } },
      micConstraints: () => ({}), micSettings: {}, clearInterval() {}, renderLive() {}, lastSnapshot: null };
    await assert.rejects(runInNewContext(`${start}\nstartRecording(${online}, ${JSON.stringify(app)}, { fresh: true });`, context), new RegExp(`${failure} failed`));
    await Promise.resolve();
    assert.equal(context.meetingId, failure === 'create' ? 'old' : 'fresh');
    const tab = online && !app;
    assert.equal(events[0], tab ? 'picker' : 'close menu');
    assert.equal(events.includes('release tab'), tab);
    if (failure === 'mic') assert.deepEqual(events.filter(e => !['picker', 'release tab'].includes(e)), ['close menu', 'create', 'select', 'refresh', '/api/meetings/fresh', 'mic']);
  }
});

test('finishing a recording focuses the primary only when no field has focus', async () => {
  const finish = code.slice(code.indexOf('async function finishSession('), code.indexOf('/** Stop: every input'));
  for (const focused of ['body', 'input', 'none']) {
    let primaryFocused = false;
    const body = {}, input = { value: 'Notes in progress' };
    const document = { body, activeElement: focused === 'body' ? body : focused === 'input' ? input : null, removeEventListener() {} };
    const session = { finished: false, context: { close: async () => {} } };
    const context = { capture: session, clearInterval() {}, document, stopLevel() {}, closeMini() {}, refreshStatus: async () => {},
      controls() {}, focusRecordingButton() { primaryFocused = true; }, renderLive() {}, lastSnapshot: null, log() {} };
    await runInNewContext(`${finish}\nfinishSession(capture);`, context);
    assert.equal(primaryFocused, focused !== 'input', focused);
    if (focused === 'input') { assert.equal(document.activeElement, input); assert.equal(input.value, 'Notes in progress'); }
  }
});

test('guarded rejects a second click synchronously while fresh meeting creation is pending', async () => {
  const guarded = code.slice(code.indexOf('const guarded ='), code.indexOf('\n};', code.indexOf('const guarded =')) + 3);
  let creates = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  class Control { dataset: Record<string, string> = {}; setAttribute() {} removeAttribute() {} }
  const context = { HTMLElement: Control, inlineError() {}, log() {} };
  const wrap = runInNewContext(`${guarded}\nguarded;`, context);
  const click = wrap(async () => { creates++; await pending; });
  const event = { currentTarget: new Control() };
  const first = click(event), second = click(event);
  assert.equal(creates, 1);
  release(); await Promise.all([first, second]);
});
