import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeetingStore, cleanSuggestedTitle, isAppMadeTitle } from '../src/store.ts';
import { startServer } from '../src/server.ts';
import type { NotesRunner } from '../src/notes.ts';
import { until } from './helpers/setup-pi.ts';

const fixture = fileURLToPath(new URL('./fixtures/upgrade-v0.1.0/', import.meta.url));
// The page's own stamp (public/app.js, "New meeting").
const stamp = (at: number, locale?: string) => new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const source = (store: MeetingStore, id: string) => { const m = store.meeting(id); return [m.title, m.titleSource]; };

test('a suggested title is cleaned to one short line, or nothing', () => {
  assert.equal(cleanSuggestedTitle('  Lantern\n  parade   route. '), 'Lantern parade route');
  assert.equal(cleanSuggestedTitle('"Lantern parade route."'), 'Lantern parade route');
  assert.equal(cleanSuggestedTitle('“Kite festival budget”'), 'Kite festival budget');
  assert.equal(cleanSuggestedTitle("'Kite festival'"), 'Kite festival');
  assert.equal(cleanSuggestedTitle('Q3 lantern stock...'), 'Q3 lantern stock');
  assert.equal(cleanSuggestedTitle('"Mismatched quote'), '"Mismatched quote', 'only a wrapping pair is stripped');
  const long = cleanSuggestedTitle(`${'Lantern '.repeat(9)}workshop-planning-session finale`);
  assert.ok(long.length <= 80, long);
  assert.equal(long, 'Lantern '.repeat(9).trim(), 'cut at a word boundary');
  assert.equal(cleanSuggestedTitle('x'.repeat(100)), 'x'.repeat(80), 'one long word is cut at 80');
  for (const garbage of ['', '   ', '""', '. . .', '“”', null, 42, ['Title'], '—']) assert.equal(cleanSuggestedTitle(garbage), '', String(garbage));
});

test('only the exact names the app makes up count as app-made', () => {
  const at = Date.UTC(2026, 3, 9, 14, 5, 30);
  assert.equal(isAppMadeTitle('Untitled meeting', at), true);
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at)}`, at), true);
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at, 'en-US')}`, at), true);
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at - 60_000)}`, at), true, 'the page stamps a moment before the server saves');
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at, 'en-US').replace(/[\u202f\u00a0]/g, ' ')}`, at), true, 'an older browser put a plain space before PM');
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at - 3_600_000)}`, at), false, 'another time is a name the user chose');
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at)} (draft)`, at), false);
  assert.equal(isAppMadeTitle(`meeting ${stamp(at)}`, at), false);
  assert.equal(isAppMadeTitle('Meeting with the lantern club', at), false);
  assert.equal(isAppMadeTitle('Untitled meeting 2', at), false);
});

test('the title source: a fresh database, a v0.1.0 database without the column, and a second open', async t => {
  const fresh = await mkdtemp(join(tmpdir(), 'meeting-title-fresh-'));
  const old = await mkdtemp(join(tmpdir(), 'meeting-title-old-'));
  t.after(async () => { await rm(fresh, { recursive: true, force: true }); await rm(old, { recursive: true, force: true }); });

  let store = new MeetingStore(fresh);
  const untitled = store.createMeeting(), named = store.createMeeting('Fictional kite rehearsal');
  const dated = store.createMeeting(`Meeting ${stamp(Date.now())}`, 'default');
  assert.equal(untitled.titleSource, 'default');
  assert.deepEqual(source(store, untitled.id), ['Untitled meeting', 'default']);
  assert.deepEqual(source(store, named.id), ['Fictional kite rehearsal', 'user'], 'a given name is the user\'s unless the caller says otherwise');
  assert.equal(store.meeting(dated.id).titleSource, 'default');
  store.close();

  // The real v0.1.0 schema and rows, plus app-made and look-alike names from that era.
  const db = new DatabaseSync(join(old, 'meetings.sqlite'));
  db.exec(await readFile(join(fixture, 'meetings.sql'), 'utf8'));
  assert.ok(!(db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).some(c => c.name === 'titleSource'));
  const at = Date.UTC(2026, 3, 9, 14, 5, 30);
  const rows: [string, string, number][] = [
    ['a0000000-0000-4000-8000-000000000001', `Meeting ${stamp(at)}`, at],
    ['a0000000-0000-4000-8000-000000000002', 'Untitled meeting', at],
    ['a0000000-0000-4000-8000-000000000003', `Meeting ${stamp(at - 86_400_000)}`, at],
    ['a0000000-0000-4000-8000-000000000004', 'Meeting about lantern stock', at],
  ];
  for (const [id, title, createdAt] of rows) db.prepare('INSERT INTO meetings (id,title,createdAt) VALUES (?,?,?)').run(id, title, createdAt);
  const custom = (db.prepare("SELECT id FROM meetings WHERE id NOT LIKE 'a0000000-%'").all() as { id: string }[]).map(r => r.id);
  assert.ok(custom.length >= 2);
  db.close();

  store = new MeetingStore(old);
  const classified = () => Object.fromEntries(store.meetings().map(m => [m.id, m.titleSource]));
  const expected = { ...Object.fromEntries(custom.map(id => [id, 'user'])),
    [rows[0][0]]: 'default', [rows[1][0]]: 'default', [rows[2][0]]: 'user', [rows[3][0]]: 'user' };
  assert.deepEqual(classified(), expected);
  // The user renames one app-made name and AI names another; a second open reclassifies nothing.
  store.rename(rows[0][0], `Meeting ${stamp(at)}`);
  assert.equal(store.titleFromNotes(rows[1][0], 'Lantern stock check'), true);
  store.close();
  store = new MeetingStore(old);
  try {
    assert.deepEqual(classified(), { ...expected, [rows[0][0]]: 'user', [rows[1][0]]: 'ai' });
    assert.deepEqual(source(store, rows[1][0]), ['Lantern stock check', 'ai']);
  } finally { store.close(); }
});

test('the store names only app-made and AI-made titles from notes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-title-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MeetingStore(directory);
  try {
    const m = store.createMeeting();
    assert.equal(store.titleFromNotes(m.id, '   '), false);
    assert.deepEqual(source(store, m.id), ['Untitled meeting', 'default']);
    assert.equal(store.titleFromNotes(m.id, '"Kite festival budget."'), true);
    assert.deepEqual(source(store, m.id), ['Kite festival budget', 'ai']);
    assert.equal(store.titleFromNotes(m.id, 'Kite festival budget and venue'), true);
    assert.deepEqual(source(store, m.id), ['Kite festival budget and venue', 'ai']);
    store.rename(m.id, 'My kite notes');
    assert.equal(store.titleFromNotes(m.id, 'Kite festival recap'), false);
    assert.deepEqual(source(store, m.id), ['My kite notes', 'user']);
  } finally { store.close(); }
});

test('server: saved notes name the meeting until the user renames it; failed, cancelled and empty titles change nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-title-server-'));
  let title: unknown = 'Lantern parade route';
  let mode: 'ok' | 'fail' | 'hold' = 'ok';
  let held = 0;
  const notes: NotesRunner = async input => {
    if (mode === 'fail' && input.instructions.includes('notes: title,')) throw new Error('fictional model failure');
    if (mode === 'hold') {
      held++;
      await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return { text: JSON.stringify({ title, summary: [{ text: 'The lanterns stay on the rack.', cites: ['S1'], quote: 'Keep the painted lanterns on the rack' }],
      decisions: [], actions: [], openQuestions: [], otherMatters: [], otherTalk: [] }), model: 'stand-in' };
  };
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null, plans: null, notes });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(app.url + path, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(res.ok, `${path}: ${await res.clone().text()}`); return res.json() as Promise<any>;
  };
  const meetingOf = async (id: string) => (await call('/api/status')).meetings.find((m: any) => m.id === id);
  const create = async (body: unknown) => {
    const meeting = await call('/api/meetings', 'POST', body);
    const chunk = await app.store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
    app.store.completeChunk(chunk.id, { text: 'Keep the painted lanterns on the rack until the parade.', words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    return meeting;
  };
  const write = async (id: string) => {
    const before = (await call(`/api/meetings/${id}/notes`)).notes?.version ?? 0;
    await call(`/api/meetings/${id}/notes`, 'POST', {});
    await until(async () => { const s = await call(`/api/meetings/${id}/notes`); return !s.job && (s.notes?.version ?? 0) > before; });
  };

  // The page's dated name is the app's; notes rename it, and rewritten notes improve it.
  const dated = await create({ title: 'Meeting Apr 9, 02:05 PM', titleSource: 'default' });
  assert.equal(dated.titleSource, 'default');
  await write(dated.id);
  assert.deepEqual([(await meetingOf(dated.id)).title, (await meetingOf(dated.id)).titleSource], ['Lantern parade route', 'ai']);
  assert.equal((await call(`/api/meetings/${dated.id}/notes`)).notes.title, 'Meeting Apr 9, 02:05 PM', 'the notes keep their snapshot title');
  title = '"Lantern parade route and rack."';
  await write(dated.id);
  assert.equal((await meetingOf(dated.id)).title, 'Lantern parade route and rack');

  // Empty and garbage suggestions keep the name.
  for (const bad of ['', '  ', '...', 17]) {
    title = bad; await write(dated.id);
    assert.deepEqual([(await meetingOf(dated.id)).title, (await meetingOf(dated.id)).titleSource], ['Lantern parade route and rack', 'ai'], String(bad));
  }

  // Failed and cancelled notes change nothing.
  title = 'Kite festival';
  mode = 'fail';
  await call(`/api/meetings/${dated.id}/notes`, 'POST', {});
  await until(async () => (await call(`/api/meetings/${dated.id}/notes`)).job?.state === 'failed');
  assert.equal((await meetingOf(dated.id)).title, 'Lantern parade route and rack');
  mode = 'hold'; held = 0;
  await call(`/api/meetings/${dated.id}/notes`, 'POST', {});
  await until(() => held === 3);
  await call(`/api/meetings/${dated.id}/notes/cancel`, 'POST', { jobId: (await call(`/api/meetings/${dated.id}/notes`)).job.id });
  await until(async () => !(await call(`/api/meetings/${dated.id}/notes`)).job);
  assert.equal((await meetingOf(dated.id)).title, 'Lantern parade route and rack');
  mode = 'ok';

  // A user rename is final: later notes never change it.
  const renamed = await call(`/api/meetings/${dated.id}`, 'PATCH', { title: 'My lantern notes' });
  assert.equal(renamed.titleSource, 'user');
  await write(dated.id);
  assert.deepEqual([(await meetingOf(dated.id)).title, (await meetingOf(dated.id)).titleSource], ['My lantern notes', 'user']);

  // A typed name (or an older caller that does not say) is the user's; no name at all is the app's.
  const typed = await create({ title: 'Kite club planning' });
  assert.equal(typed.titleSource, 'user');
  await write(typed.id);
  assert.equal((await meetingOf(typed.id)).title, 'Kite club planning');
  const untitled = await create({});
  assert.deepEqual([untitled.title, untitled.titleSource], ['Untitled meeting', 'default']);
  await write(untitled.id);
  assert.deepEqual([(await meetingOf(untitled.id)).title, (await meetingOf(untitled.id)).titleSource], ['Kite festival', 'ai']);
});
