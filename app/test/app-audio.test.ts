import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { MeetingStore } from '../src/store.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppCaptureControl } from '../src/app-capture.ts';
import { rolesFor, compareSegments } from '../src/speakers.ts';
import { startServer } from '../src/server.ts';

const app = { id: 'test.fictional.meet', name: 'Fictional Meet' };
const source = () => `app:${randomUUID()}`;

test('microphone app processing requests all only when advertised and records the applied mode', async () => {
  const code = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const attach = code.slice(code.indexOf('async function attachApp('), code.indexOf('let appCapturePolling'));
  const settings = code.slice(code.indexOf('function captureSettings('), code.indexOf('async function listMicrophones('));
  for (const capabilities of [undefined, [true, false], ['remote-only', true], ['all', 'remote-only', true]]) {
    const applied: Record<string, unknown>[] = [];
    const track = { getCapabilities: () => ({ echoCancellation: capabilities }), getSettings: () => ({ echoCancellation: true }),
      applyConstraints: async (c: Record<string, unknown>) => { applied.push(c); } };
    const stream = { getAudioTracks: () => [track] };
    const session = { sources: new Map<string, unknown>([['mic', { stream, firstSaved: true }]]), startedAt: Date.now(), offsetMs: 0 };
    const context = { capture: session, crypto: { randomUUID }, pageId: 'page', micSettings: { room: true }, controls() {}, renderLive() {}, lastSnapshot: null, log() {}, post: async () => ({ accepted: true }) };
    const functions = runInNewContext(`${attach}\n${settings}\n({ attachApp, captureSettings })`, context);
    await functions.attachApp(session, app);
    const expected = capabilities?.includes('all' as never) ? 'all' : true;
    assert.deepEqual(JSON.parse(JSON.stringify(applied)), [{ echoCancellation: expected, noiseSuppression: true, autoGainControl: true }]);
    const recorded = functions.captureSettings('mic', stream, true);
    assert.equal(recorded.echoCancellation, expected); assert.equal(recorded.roomMode, false);
  }
});

test('export and AI context wording distinguishes tab-only, app-only and mixed meetings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-call-words-'));
  const store = new MeetingStore(directory);
  try {
    for (const [kinds, expected] of [[['tab'], 'meeting tab'], [['app'], 'meeting app'], [['tab', 'app'], 'meeting tab or app']] as const) {
      const meeting = store.createMeeting('Fictional call');
      for (const kind of kinds) await store.addPcm(meeting.id, `${kind}:${randomUUID()}`, 0, 0, 16000, Buffer.alloc(64000));
      assert.ok(store.markdown(meeting.id).includes(`"Them" is the ${expected} (everyone on the call)`));
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('app control: discovery lease, recording/page fencing, one Them, stop and late completion', () => {
  let now = 100_000;
  const control = new AppCaptureControl(() => now);
  assert.equal(control.available(), false);
  control.report({ available: true, apps: [app] });
  assert.deepEqual(control.requestList(), { available: true, apps: [app] });
  assert.equal(control.wantsList(), true);
  const request = { app, source: source(), meetingId: randomUUID(), pageId: 'page', recordingId: randomUUID(), clockStart: now };
  const current = { ...request, sources: [`mic:${randomUUID()}`], stopping: false };
  assert.equal(control.start(request, null), false);
  assert.equal(control.start(request, { ...current, pageId: 'other' }), false);
  assert.equal(control.start(request, { ...current, recordingId: randomUUID() }), false);
  assert.throws(() => control.start({ ...request, source: 'bad' }, current), /Invalid/);
  assert.throws(() => control.start(request, { ...current, sources: [`tab:${randomUUID()}`] }), /one call/);
  assert.equal(control.start(request, current), true);
  assert.throws(() => control.start({ ...request, source: source() }, current), /one call/);
  control.stop(source()); assert.equal(control.command()!.stopping, false);
  control.stop(request.source); assert.equal(control.command()!.stopping, true);
  control.ended(source(), 'late'); assert.equal(control.state!.ended, false);
  control.notice(request.source, 'quiet'); control.notice(request.source, 'duplicate');
  assert.equal(control.state!.notice, 'quiet');
  now += 3501; assert.equal(control.lost(), true); assert.equal(control.available(), false);
  control.ended(request.source, 'closed'); assert.equal(control.command(), null);
  now += 1500; assert.equal(control.wantsList(), false);
});

test('app roles and mic-first ties match the call source; imported speech stays unlabelled', () => {
  const mic = `mic:${randomUUID()}`, remote = source();
  const roles = rolesFor([{ source: mic, startMs: 0, endMs: 9000 }, { source: remote, startMs: 3000, endMs: 6000 }]);
  assert.equal(roles.roleOf(remote, 3000, 4000), 'them');
  assert.equal(roles.roleOf(mic, 0, 1000), undefined);
  assert.equal(roles.roleOf(mic, 4000, 5000), 'me');
  assert.equal(roles.roleOf('import', 4000, 5000), undefined);
  assert.ok(compareSegments({ source: mic, startMs: 0, id: 'a' }, { source: remote, startMs: 0, id: 'b' }) < 0);
});

test('loopback app capture: endpoints, PCM, Them labels, notices, Stop and end protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-app-audio-'));
  const server = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: {
    async transcribe() { return { text: 'Fictional call words.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; }, close() {},
  } });
  try {
    const cookie = (await fetch(`${server.url}/mini.html`)).headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, options: RequestInit = {}) => fetch(`${server.url}${path}`, { ...options, headers: { Cookie: cookie, Origin: server.url, 'X-Page': 'page', 'Content-Type': 'application/json', ...options.headers } });
    const post = (path: string, value: unknown) => request(path, { method: 'POST', body: JSON.stringify(value) });
    const meeting = await (await post('/api/meetings', {})).json();
    const mic = `mic:${randomUUID()}`, recordingId = randomUUID(), remote = source();
    const clockStart = Date.now() - 5000;
    const pcm = (id: string, sequence: number) => request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: { 'X-Audio-Source': id, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000), 'X-Clock-Start': String(clockStart), 'X-Recording': recordingId } });
    assert.equal((await pcm(mic, 0)).status, 201);
    assert.equal((await post('/api/live/apps', { available: true, apps: [app] })).status, 200);
    assert.equal((await post('/api/live/apps', { available: true, apps: [{ id: '../bad', name: 'bad' }] })).status, 400);
    assert.deepEqual((await (await request('/api/live/apps')).json()).apps, [app]);
    const value = { app, meetingId: meeting.id, recordingId, source: remote, pageId: 'page', clockStart };
    assert.equal((await (await post('/api/live/app-capture', { ...value, recordingId: randomUUID() })).json()).accepted, false);
    assert.equal((await (await post('/api/live/app-capture', value)).json()).accepted, true);
    assert.equal((await post('/api/live/app-capture', { ...value, source: source() })).status, 400);
    const window = await (await request('/api/live/window')).json();
    assert.equal(window.appList, true); assert.equal(window.appCapture.source, remote);
    assert.equal((await pcm(`tab:${randomUUID()}`, 0)).status, 409);
    assert.equal((await pcm(remote, 0)).status, 201);
    const live = (await (await request('/api/live')).json()).recording;
    assert.deepEqual(live.drafts.map((s: { source: string; speaker: string }) => [s.source, s.speaker]), [[mic, 'Me'], [remote, 'Them']]);
    await post('/api/live/app-capture/notice', { source: remote, message: 'No sound from Fictional Meet yet.' });
    assert.equal((await (await request('/api/live/app-capture')).json()).state.notice, 'No sound from Fictional Meet yet.');
    const ended = await post(`/api/meetings/${meeting.id}/pcm/end`, { source: remote, lastSequence: 0, stopping: false, message: 'Fictional Meet closed; the microphone keeps recording.' });
    assert.equal(ended.status, 200);
    assert.equal((await (await request('/api/live/app-capture')).json()).state.ended, true);
    const remaining = (await (await request('/api/live')).json()).recording;
    assert.deepEqual(remaining.drafts.map((s: { source: string }) => s.source), [mic]);
    assert.equal(remaining.notices[0].text, 'Fictional Meet closed; the microphone keeps recording.');
    assert.equal((await pcm(remote, 1)).status, 409, 'an ended app must not be reopened by a late upload');
    assert.equal(server.store!.openRecordings().filter(s => s.source === remote).length, 0);
    assert.equal((await pcm(mic, 1)).status, 201);
    await post('/api/live/stop', { sources: [mic] });
    assert.equal((await post(`/api/meetings/${meeting.id}/pcm/end`, { source: mic, lastSequence: 1, stopping: true })).status, 200);
    assert.equal((await (await request('/api/live')).json()).recording, null);
    assert.equal((await (await post('/api/live/app-capture', { ...value, source: source() })).json()).accepted, false);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

async function appFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-app-lifetime-'));
  let now = 1_800_000_000_000;
  const server = await startServer({ directory, port: 0, clock: () => now, quick: null, heavy: null, recognizer: {
    async transcribe() { return { text: 'Fictional words.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; }, close() {},
  } });
  const cookie = (await fetch(`${server.url}/mini.html`)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, options: RequestInit = {}) => fetch(`${server.url}${path}`, { ...options, headers: { Cookie: cookie, Origin: server.url, 'X-Page': 'page', 'Content-Type': 'application/json', ...options.headers } });
  const post = (path: string, value: unknown) => request(path, { method: 'POST', body: JSON.stringify(value) });
  const meeting = await (await post('/api/meetings', {})).json();
  const mic = `mic:${randomUUID()}`, source = `app:${randomUUID()}`, recordingId = randomUUID();
  const pcm = (id: string, n: number) => request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64000), headers: { 'X-Audio-Source': id, 'X-Sequence': String(n), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(n * 1000), 'X-Clock-Start': String(now), 'X-Recording': recordingId } });
  assert.equal((await pcm(mic, 0)).status, 201);
  await post('/api/live/apps', { available: true, apps: [app] });
  assert.equal((await (await post('/api/live/app-capture', { app, meetingId: meeting.id, source, recordingId, pageId: 'page', clockStart: now })).json()).accepted, true);
  assert.equal((await pcm(source, 0)).status, 201);
  return { server, meeting, source, mic, pcm, post, request,
    advance(ms: number) { now += ms; },
    endedAt: () => (server.store.db.prepare('SELECT recordingEndedAt FROM meetings WHERE id=?').get(meeting.id) as { recordingEndedAt: number | null }).recordingEndedAt,
    state: async () => (await (await request('/api/live/app-capture')).json()).state,
    end: (id: string) => post(`/api/meetings/${meeting.id}/pcm/end`, { source: id, lastSequence: 0, stopping: true }),
    async close() { await server.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('goodbye permanently ends app admission; a late frame cannot reopen an abandoned meeting', async () => {
  const f = await appFixture();
  try {
    assert.equal((await f.post('/api/bye?page=page', {})).status, 204);
    const endedAt = f.endedAt();
    assert.notEqual(endedAt, null);
    assert.equal((await f.pcm(f.source, 1)).status, 409);
    assert.equal(f.endedAt(), endedAt);
    assert.equal(f.server.store.openRecordings().length, 0);
    assert.equal(f.server.capture.sourceEnded(f.source), true);
    assert.equal((await f.state()).ended, true);
    assert.throws(() => f.server.store.claimRecording(f.meeting.id, f.source, 'page'), /ended|abandoned/i);
    assert.equal(f.endedAt(), endedAt);
  } finally { await f.close(); }
});

test('durable admission survives the ten-minute in-memory source sweep', async () => {
  const f = await appFixture();
  try {
    await f.end(f.source); await f.end(f.mic);
    const endedAt = f.endedAt();
    f.advance(10 * 60_000 + 1); await f.server.capture.sweep();
    assert.equal(f.server.capture.sourceEnded(f.source), false, 'the regression must exercise a forgotten source');
    assert.equal((await f.pcm(f.source, 1)).status, 409);
    assert.equal(f.server.store.openRecordings().length, 0);
    assert.equal(f.endedAt(), endedAt);
  } finally { await f.close(); }
});

test('accepted PCM is liveness even while helper window polling is stale', async () => {
  const f = await appFixture();
  try {
    f.advance(3501); assert.equal((await f.pcm(f.source, 1)).status, 201);
    assert.equal((await f.state()).ended, false);
    assert.equal((await f.pcm(f.source, 2)).status, 201);
  } finally { await f.close(); }
});

test('a heartbeat during a slow loss seal cancels disconnect and keeps subsequent PCM admissible', async () => {
  const f = await appFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const sealing = new Promise<void>(resolve => { entered = resolve; });
  const seal = f.server.store.sealWindow.bind(f.server.store);
  f.server.store.sealWindow = async (...args) => { entered(); await gate; return seal(...args); };
  try {
    f.advance(3501);
    const pending = f.state(); await sealing;
    await f.request('/api/live/window'); release();
    assert.equal((await pending).ended, false);
    assert.equal((await f.pcm(f.source, 1)).status, 201);
    assert.equal(f.server.store.openRecordings().filter(r => r.source === f.source).length, 1);
    assert.equal((await (await f.request('/api/live')).json()).recording.notices.some((n: { text: string }) => /disconnected/.test(n.text)), false);
  } finally { release(); await f.close(); }
});
