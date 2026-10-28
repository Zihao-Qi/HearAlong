import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LiveView } from '../src/live-view.ts';
import { NOTICES, paragraphsOf, signatureLines } from '../public/live-shared.js';
import { startServer } from '../src/server.ts';

const mic = () => `mic:${randomUUID()}`;
const tab = () => `tab:${randomUUID()}`;
/** Frames of one recording (one Start) from these sources. */
const record = (view: LiveView, recording: string, ...sources: string[]) => { for (const source of sources) view.frame(source, recording, null, null); };

test('a paragraph\'s lines are read back from its signature (the mini view holds back regrouped paragraphs by them)', () => {
  const [first, second] = paragraphsOf([
    { id: randomUUID(), startMs: 0, endMs: 1000, revision: 0, speaker: 'Me' }, { id: randomUUID(), startMs: 1000, endMs: 2000, revision: 2, speaker: 'Me' },
    { id: randomUUID(), startMs: 2000, endMs: 3000, revision: 1, speaker: 'Them' },
  ]);
  assert.deepEqual(signatureLines(first.signature), first.segments.map(s => s.id));
  assert.deepEqual(signatureLines(second.signature), second.segments.map(s => s.id));
});

test('the mini window opens by itself once per recording; closed by hand it stays closed; a new recording starts fresh', () => {
  const view = new LiveView(() => 0);
  const [m1, t1] = [mic(), tab()];
  record(view, 'r1', m1);
  const first = view.sessionId();
  assert.equal(view.miniState(), 'auto');
  view.mini('away');
  assert.equal(view.miniState(), 'open');
  view.mini('closed');
  view.mini('away');
  assert.equal(view.miniState(), 'closed', 'leaving the app again does not reopen a window closed by hand');
  view.mini('open');
  assert.equal(view.miniState(), 'open', 'the app\'s button opens it again');
  record(view, 'r1', t1);
  assert.equal(view.sessionId(), first, 'a tab added to the recording keeps it the same recording');
  view.mini('closed');
  record(view, 'r2', mic());
  assert.notEqual(view.sessionId(), first);
  assert.equal(view.miniState(), 'auto', 'a new recording starts as auto');
  const second = view.sessionId();
  record(view, 'r1', m1);
  assert.equal(view.sessionId(), second, 'a late frame of an earlier recording (a reloaded page) does not bring it back');
  assert.equal(view.has(m1), false);
});

test('a Stop reaches only the sources live when it was asked, and a late request about an earlier recording does nothing', () => {
  const view = new LiveView(() => 0);
  const m1 = mic();
  record(view, 'r1', m1);
  const old = view.sessionId();
  assert.equal(view.current({ session: old }), true);
  assert.equal(view.current({ sources: [m1] }), true);
  assert.equal(view.current({ sources: [mic()] }), false);
  assert.equal(view.current({}), false);
  view.stop([m1]);
  assert.equal(view.stopping(), true);
  assert.equal(view.stopFor(m1), true);
  assert.deepEqual(view.stopped(), [m1]);
  const m2 = mic();
  record(view, 'r2', m2);
  assert.equal(view.stopping(), false, 'a new recording is not stopping');
  assert.equal(view.current({ sources: [m1] }), false, 'a late Stop naming the earlier recording\'s sources is not for this one');
  assert.equal(view.stopFor(m2), false);
  assert.equal(view.current({ session: old }), false, 'a request naming the earlier recording is not for this one');
});

test('notices: the tab share ending, saving behind (by count or late frames), quiet sources; most urgent first', () => {
  const view = new LiveView(() => 0);
  const [m, t] = [mic(), tab()];
  record(view, 'r1', m, t);
  assert.deepEqual(view.notices([{ source: m, quiet: false }, { source: t, quiet: false }]), [], 'nothing while all is well');
  view.ended(t, false);
  assert.deepEqual(view.notices([{ source: m, quiet: false }]), [NOTICES.tabEnded]);
  const t2 = tab();
  record(view, 'r1', t2);
  assert.deepEqual(view.notices([{ source: m, quiet: false }, { source: t2, quiet: false }]), [], 'a tab shared again clears it');
  view.frame(m, 'r1', 5, null);
  assert.deepEqual(view.notices([{ source: m, quiet: true }, { source: t2, quiet: true }]), [NOTICES.savingBehind, NOTICES.quietMic, NOTICES.quietTab]);
  view.frame(m, 'r1', 0, null);
  assert.deepEqual(view.notices([{ source: m, quiet: false, late: true }, { source: t2, quiet: false }]), [NOTICES.savingBehind], 'frames that stopped arriving are behind too');
  // A tab ended by Stop is not a share that ended.
  const fresh = new LiveView(() => 0);
  const [m3, t3] = [mic(), tab()];
  record(fresh, 'r1', m3, t3);
  fresh.ended(t3, true);
  assert.deepEqual(fresh.notices([{ source: m3, quiet: false }]), []);
});

test('the clock is the page\'s own; a card to open lasts 10 s; the helper counts as there for 3 s after it last asked', () => {
  let now = 100_000;
  const view = new LiveView(() => now);
  const m = mic();
  record(view, 'r1', m);
  assert.equal(view.clockMs(), null);
  view.frame(m, 'r1', 0, 40_000);
  assert.equal(view.clockMs(), 60_000);
  view.reveal('meeting', 'card-1');
  const first = view.revealFor('meeting')!;
  view.reveal('meeting', 'card-2');
  assert.equal(view.revealFor('meeting')!.cardId, 'card-2');
  assert.ok(view.revealFor('meeting')!.n > first.n, 'each request has its own number');
  now += 10_000;
  assert.equal(view.revealFor('meeting'), null);
  assert.equal(view.native(), false);
  view.helperSeen();
  now += 2900;
  assert.equal(view.native(), true);
  now += 200;
  assert.equal(view.native(), false);
});

test('/api/live: the recording, its clock, Stop through frame replies, the window state, notices, and the mini page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-live-view-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: {
    async transcribe() { return { text: 'Test transcript', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; },
    close() {},
  } });
  try {
    const mini = await fetch(`${app.url}/mini.html`);
    assert.match(mini.headers.get('set-cookie') ?? '', /meeting_session=/, 'the helper\'s web view gets a session from the mini page');
    assert.match(mini.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/, 'Chrome\'s window may hold it in a frame');
    assert.match((await fetch(app.url)).headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, 'the app itself still may not be framed');
    const cookie = mini.headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, options: RequestInit = {}) => fetch(`${app.url}${path}`, { ...options, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...options.headers } });
    const post = (path: string, data: unknown) => request(path, { method: 'POST', body: JSON.stringify(data) });
    assert.equal((await (await request('/api/live')).json()).recording, null, 'nothing records yet');
    const meeting = await (await post('/api/meetings', {})).json();
    const source = mic();
    const recordingId = randomUUID();
    const frame = (sequence: number, extra: Record<string, string> = {}) => request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000), 'X-Recording': recordingId, ...extra } });
    const clockStart = Date.now() - 125_000;
    const reply = await (await frame(0, { 'X-Pending': '0', 'X-Clock-Start': String(clockStart) })).json();
    assert.equal(reply.stop, false);
    assert.equal(reply.quit, false);
    const live = (await (await request('/api/live')).json()).recording;
    assert.equal(live.meetingId, meeting.id);
    assert.ok(Math.abs(live.clockMs - 125_000) < 2000, `the clock is the page's own: ${live.clockMs}`);
    assert.deepEqual(live.drafts.map((d: { source: string }) => d.source), [source], 'one preview slot per live source');
    assert.deepEqual(live.notices, []);
    // Saving behind, as the page counts it.
    await frame(1, { 'X-Pending': '6' });
    assert.deepEqual((await (await request('/api/live')).json()).recording.notices, [NOTICES.savingBehind]);
    assert.deepEqual((await (await request(`/api/meetings/${meeting.id}/segments`)).json()).notices, [NOTICES.savingBehind], 'the app\'s chip gets the same');
    await frame(2, { 'X-Pending': '0' });
    // The window: the helper asks; leaving the app does nothing unless the user turned that on in Settings, and then opens it;
    // closed by hand it stays closed.
    let window = await (await request('/api/live/window')).json();
    assert.equal(window.show, false);
    assert.equal(window.session, live.session);
    assert.equal((await (await request(`/api/meetings/${meeting.id}/segments`)).json()).mini.native, true, 'the helper is there');
    const settings = await (await request('/api/settings')).json();
    assert.equal(settings.miniOpensItself, false, 'off by default');
    assert.equal((await (await post('/api/live/mini', { session: live.session, action: 'away' })).json()).state, 'auto', 'leaving the app does not open it');
    assert.equal((await (await request('/api/live/window')).json()).show, false);
    const put = (data: unknown) => request('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
    assert.equal((await put({ miniOpensItself: 'yes' })).status, 400);
    assert.equal((await put({})).status, 400);
    const saved = await (await put({ miniOpensItself: true })).json();
    assert.equal(saved.miniOpensItself, true);
    assert.equal(saved.boardModel, settings.boardModel, 'the other setting stays as it was');
    assert.equal((await (await post('/api/live/mini', { session: live.session, action: 'away' })).json()).state, 'open', 'turned on, leaving the app opens it');
    assert.equal((await (await request(`/api/meetings/${meeting.id}/segments`)).json()).mini.opensItself, true, 'every app page hears of it with its transcript');
    assert.equal((await (await request('/api/live/window')).json()).show, true);
    await post('/api/live/mini', { session: live.session, action: 'closed' });
    await post('/api/live/mini', { session: live.session, action: 'away' });
    assert.equal((await (await request('/api/live/window')).json()).show, false);
    assert.equal((await post('/api/live/mini', { session: live.session, action: 'wave' })).status, 400);
    // Stop from the mini view: a late request about another recording does nothing; this one reaches the page with its next frame.
    assert.equal((await (await post('/api/live/stop', { session: live.session + 1 })).json()).stopping, false);
    assert.equal((await (await post('/api/live/stop', { session: live.session })).json()).stopping, true);
    assert.equal((await (await request('/api/live')).json()).recording.stopping, true);
    assert.equal((await (await frame(3)).json()).stop, true);
    assert.deepEqual((await (await request(`/api/meetings/${meeting.id}/segments`)).json()).stopSources, [source]);
    assert.equal((await post(`/api/meetings/${meeting.id}/pcm/end`, { source, lastSequence: 3, stopping: true })).status, 200);
    assert.equal((await (await request('/api/live')).json()).recording, null, 'ended: nothing records');
    assert.equal((await (await request('/api/live/window')).json()).show, false);
    // A card asked for from the mini view, for the app's page to open once.
    await post('/api/live/reveal', { meetingId: meeting.id, cardId: 'c1' });
    assert.equal((await (await request(`/api/meetings/${meeting.id}/segments`)).json()).reveal.cardId, 'c1');
    assert.equal((await post('/api/live/reveal', { meetingId: meeting.id })).status, 400);
    // The last lines, grouped as the transcript groups them.
    const second = mic();
    const secondRecording = randomUUID();
    for (let n = 0; n < 17; n++) {
      const r = await request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4),
        headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Source': second, 'X-Sequence': String(n), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(10_000 + n * 1000), 'X-Recording': secondRecording } });
      assert.equal(r.status, 201);
    }
    await app.jobs!.wait();
    const again = (await (await request('/api/live')).json()).recording;
    assert.notEqual(again.session, live.session, 'a new recording');
    assert.equal(again.stopping, false);
    assert.deepEqual(again.paragraphs.map((p: { text: string }) => p.text), ['Test transcript']);
    assert.equal(again.labelled, false);
    assert.equal((await (await post('/api/live/mini', { session: again.session, action: 'away' })).json()).state, 'open', 'the setting holds for the next recording');
  } finally {
    await app.close();
  }
  // The setting is kept on disk.
  const restarted = await startServer({ directory, port: 0, quick: null, heavy: null });
  try {
    const cookie = (await fetch(`${restarted.url}/mini.html`)).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await (await fetch(`${restarted.url}/api/settings`, { headers: { Cookie: cookie } })).json()).miniOpensItself, true);
  } finally {
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('/api/live: the whole meeting\'s paragraphs, then only those after the ones the page holds while they stay the same', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-live-paragraphs-'));
  // Each window of audio is heard as three lines with pauses of 3 s between them: three paragraphs.
  let windows = 0;
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: {
    async transcribe() {
      const n = ++windows;
      const segments = ['a', 'b', 'c'].map((part, i) => ({ text: `Window ${n} line ${part}.`, t0Ms: i * 4000, t1Ms: i * 4000 + 1000 }));
      return { text: segments.map(s => s.text).join(' '), segments, backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'segment' };
    },
    close() {},
  } });
  try {
    const cookie = (await fetch(`${app.url}/mini.html`)).headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, options: RequestInit = {}) => fetch(`${app.url}${path}`, { ...options, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...options.headers } });
    const meeting = await (await request('/api/meetings', { method: 'POST', body: '{}' })).json();
    let source = mic();
    let recordingId = randomUUID();
    let sequence = 0, offsetMs = 0;
    const speak = async (seconds: number) => {
      for (let i = 0; i < seconds; i++, sequence++) {
        const r = await request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4),
          headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(offsetMs + sequence * 1000), 'X-Recording': recordingId } });
        assert.equal(r.status, 201);
      }
      await app.jobs!.wait();
    };
    type Live = { paragraphs: { key: string; text: string }[]; paragraphsFrom: number; paragraphsTag: string };
    const live = async (have?: string): Promise<Live> => (await (await request(`/api/live${have ? `?have=${encodeURIComponent(have)}` : ''}`)).json()).recording;
    await speak(25);
    const first = await live();
    assert.equal(first.paragraphsFrom, 0);
    assert.deepEqual(first.paragraphs.map(p => p.text), ['Window 1 line a.', 'Window 1 line b.', 'Window 1 line c.']);
    assert.match(first.paragraphsTag, /^\d+\.2\./, 'the page holds all but the last, which may still grow');
    const same = await live(first.paragraphsTag);
    assert.equal(same.paragraphsFrom, 2);
    assert.deepEqual(same.paragraphs.map(p => p.text), ['Window 1 line c.'], 'nothing new: only the last is sent again');
    // More of the meeting: only what follows the paragraphs the page holds.
    await speak(25);
    const more = await live(first.paragraphsTag);
    assert.equal(more.paragraphsFrom, 2);
    assert.deepEqual(more.paragraphs.map(p => p.text).slice(0, 2), ['Window 1 line c.', 'Window 2 line a.']);
    const whole = await live();
    assert.equal(whole.paragraphsFrom, 0, 'without a tag, the whole meeting');
    assert.deepEqual([...first.paragraphs.slice(0, 2), ...more.paragraphs].map(p => p.key), whole.paragraphs.map(p => p.key), 'the parts make the whole meeting');
    assert.ok(whole.paragraphs.length >= 6, `${whole.paragraphs.length} paragraphs`);
    // A change among the paragraphs the page holds (a correction), or a tag that names none of them: the whole meeting again.
    const corrected = app.store!.segments(meeting.id).find(s => s.text === 'Window 1 line a.')!;
    assert.ok(app.store!.applyEdits(corrected.id, corrected.revision, 'Window 1 line A.', []));
    const changed = await live(more.paragraphsTag);
    assert.equal(changed.paragraphsFrom, 0);
    assert.equal(changed.paragraphs[0].text, 'Window 1 line A.');
    assert.equal((await live('3.forged')).paragraphsFrom, 0);
    assert.equal((await live(`${whole.paragraphs.length + 5}.x`)).paragraphsFrom, 0);
    // A new recording of the same meeting: a page that held the last one (it may have missed the gap between them) gets the
    // whole meeting, though its paragraphs are unchanged.
    const before = await live();
    const held = await live(before.paragraphsTag);
    assert.ok(held.paragraphsFrom > 0);
    [source, recordingId, sequence, offsetMs] = [mic(), randomUUID(), 0, 100_000];
    await speak(1);
    const resumed = await live(before.paragraphsTag);
    assert.equal(resumed.paragraphsFrom, 0);
    assert.deepEqual(resumed.paragraphs.map(p => p.key), before.paragraphs.map(p => p.key));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
