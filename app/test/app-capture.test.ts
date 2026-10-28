import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Exercise the page's capture functions without a browser or its unrelated UI initialization.
const functions = app.slice(app.indexOf('function micConstraints('), app.indexOf('function captureSettings('))
  + app.slice(app.indexOf('async function attachTab('), app.indexOf("$('start-mic').onclick"));

function fixture(applyConstraints: (constraints: MediaTrackConstraints) => Promise<void>, deviceId = 'unavailable') {
  const micTrack = { applyConstraints };
  const micStream = { getAudioTracks: () => [micTrack] };
  const session = { sources: new Map<string, { stream: unknown }>([['mic', { stream: micStream }]]) };
  let stopped = false;
  const stream = { getTracks: () => [{ stop: () => { stopped = true; } }] };
  const logs: string[] = [];
  const context = {
    capture: session, micSettings: { deviceId, room: true }, lastSnapshot: null,
    log: (message: string) => { logs.push(message); }, controls: () => {}, renderLive: () => {},
    addSource: async (owner: typeof session, kind: string, source: unknown) => { owner.sources.set(kind, { stream: source }); },
  };
  const attachTab = runInNewContext(`${functions}\nattachTab`, context);
  return { session, stream, micStream, logs, stopped: () => stopped, attach: () => attachTab(session, Promise.resolve({ stream })) };
}

test('attaching a tab after mic fallback or a preference change applies processing only', async () => {
  for (const deviceId of ['unavailable', 'newly-selected']) {
    const applied: MediaTrackConstraints[] = [];
    const f = fixture(async constraints => {
      applied.push(constraints);
      if (constraints.deviceId) throw new Error('The preferred microphone is unavailable');
    }, deviceId);
    await f.attach();
    assert.deepEqual(JSON.parse(JSON.stringify(applied)), [{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }]);
    assert.equal(f.session.sources.get('mic')!.stream, f.micStream, 'keep the current microphone');
    assert.equal(f.session.sources.get('tab')?.stream, f.stream);
    assert.equal(f.stopped(), false);
  }
});

test('a microphone processing constraint failure is logged but does not stop tab attachment', async () => {
  const f = fixture(async () => { throw new Error('Processing settings are not supported'); });
  await f.attach();
  assert.equal(f.session.sources.get('tab')?.stream, f.stream);
  assert.equal(f.stopped(), false);
  assert.ok(f.logs.some(message => message.includes('Processing settings are not supported')));
  assert.ok(f.logs.some(message => message.includes('Meeting tab recording started')));
});
