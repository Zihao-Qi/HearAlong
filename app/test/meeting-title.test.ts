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
const source = (store: MeetingStore, id: string) => { const m = store.meeting(id); return [m.title, m.autoTitle]; };

test('a suggested title is cleaned to one short line, or nothing', () => {
  assert.equal(cleanSuggestedTitle('  Lantern\n  parade   route. '), 'Lantern parade route');
  assert.equal(cleanSuggestedTitle('"Lantern parade route."'), 'Lantern parade route');
  assert.equal(cleanSuggestedTitle('“Kite festival budget”'), 'Kite festival budget');
  assert.equal(cleanSuggestedTitle("'Kite festival'"), 'Kite festival');
  assert.equal(cleanSuggestedTitle('"Mismatched quote'), '"Mismatched quote', 'only a wrapping pair is stripped');
  assert.equal(cleanSuggestedTitle('"Q3" vs "Q4"'), '"Q3" vs "Q4"', 'quotes that do not wrap the whole title stay');
  assert.equal(cleanSuggestedTitle('“Q3” vs “Q4”'), '“Q3” vs “Q4”');
  assert.equal(cleanSuggestedTitle('"Kite budget for the “big” day"'), '"Kite budget for the “big” day"');
  for (const kept of ['Q3 lantern stock...', 'Lantern export to the U.S.', 'Kites, ribbons, etc.', 'Lanterns vs.', 'Lantern plan A.B.']) {
    assert.equal(cleanSuggestedTitle(kept), kept, 'an ellipsis or abbreviation is not a sentence end');
  }
  assert.equal(cleanSuggestedTitle('Lantern parade route..'), 'Lantern parade route..', 'only one final full stop, never part of a run');
  const long = cleanSuggestedTitle(`${'Lantern '.repeat(9)}workshop-planning-session finale`);
  assert.ok(long.length <= 80, long);
  assert.equal(long, 'Lantern '.repeat(9).trim(), 'cut at a word boundary');
  assert.equal(cleanSuggestedTitle('x'.repeat(100)), 'x'.repeat(80), 'one long word is cut at 80');
  const emoji = cleanSuggestedTitle(`Lantern${'🏮'.repeat(100)}`);
  assert.equal(Array.from(emoji).length, 80, 'cut by characters, not UTF-16 units');
  assert.equal(emoji, `Lantern${'🏮'.repeat(73)}`, 'no emoji is split');
  assert.equal(cleanSuggestedTitle(`Lantern ${'🏮'.repeat(70)} parade`), `Lantern ${'🏮'.repeat(70)}`, 'emoji count once toward 80');
  for (const garbage of ['', '   ', '""', '. . .', '“”', null, 42, ['Title'], '—']) assert.equal(cleanSuggestedTitle(garbage), '', String(garbage));
});

test('only the exact names the app makes up count as app-made', () => {
  const at = Date.UTC(2026, 3, 9, 14, 5, 30);
  assert.equal(isAppMadeTitle('Untitled meeting', at), true);
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at)}`, at), true);
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at, 'en-US')}`, at), true);
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at - 60_000)}`, at), true, 'the page stamps a moment before the server saves');
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at, 'en-US').replace(/[  ]/g, ' ')}`, at), true, 'an older browser put a plain space before PM');
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at - 3_600_000)}`, at), false, 'another time is a name the user chose');
  assert.equal(isAppMadeTitle(`Meeting ${stamp(at)} (draft)`, at), false);
  assert.equal(isAppMadeTitle(`meeting ${stamp(at)}`, at), false);
  assert.equal(isAppMadeTitle('Meeting with the lantern club', at), false);
  assert.equal(isAppMadeTitle('Untitled meeting 2', at), false);
});

test('the app-made name: a fresh database, a v0.1.0 database without the column, and a second open', async t => {
  const fresh = await mkdtemp(join(tmpdir(), 'meeting-title-fresh-'));
  const old = await mkdtemp(join(tmpdir(), 'meeting-title-old-'));
  t.after(async () => { await rm(fresh, { recursive: true, force: true }); await rm(old, { recursive: true, force: true }); });

  let store = new MeetingStore(fresh);
  const untitled = store.createMeeting(), named = store.createMeeting('Fictional kite rehearsal');
  const datedTitle = `Meeting ${stamp(Date.now())}`, dated = store.createMeeting(datedTitle, true);
  assert.equal(untitled.autoTitle, 'Untitled meeting');
  assert.deepEqual(source(store, untitled.id), ['Untitled meeting', 'Untitled meeting']);
  assert.deepEqual(source(store, named.id), ['Fictional kite rehearsal', null], 'a given name is the user\'s unless the caller says otherwise');
  assert.deepEqual(source(store, dated.id), [datedTitle, datedTitle]);
  store.close();

  // The real v0.1.0 schema and rows, plus app-made and look-alike names from that era.
  const db = new DatabaseSync(join(old, 'meetings.sqlite'));
  db.exec(await readFile(join(fixture, 'meetings.sql'), 'utf8'));
  assert.ok(!(db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).some(c => c.name === 'autoTitle'));
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
  const classified = () => Object.fromEntries(store.meetings().map(m => [m.id, m.autoTitle]));
  const expected = { ...Object.fromEntries(custom.map(id => [id, null])),
    [rows[0][0]]: rows[0][1], [rows[1][0]]: 'Untitled meeting', [rows[2][0]]: null, [rows[3][0]]: null };
  assert.deepEqual(classified(), expected);
  // The user renames one app-made name (to the same text) and the notes name another; a second open reclassifies nothing.
  store.rename(rows[0][0], rows[0][1]);
  assert.equal(store.titleFromNotes(rows[1][0], 'Lantern stock check'), true);
  store.close();
  store = new MeetingStore(old);
  try {
    assert.deepEqual(classified(), { ...expected, [rows[0][0]]: null, [rows[1][0]]: 'Lantern stock check' });
    assert.deepEqual(source(store, rows[1][0]), ['Lantern stock check', 'Lantern stock check']);
    assert.equal(store.titleFromNotes(rows[0][0], 'Kite stock check'), false, 'a rename to the dated text is still the user\'s');
  } finally { store.close(); }
});

test('the store names only app-made and AI-made titles from notes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-title-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MeetingStore(directory);
  try {
    const m = store.createMeeting();
    assert.equal(store.titleFromNotes(m.id, '   '), false);
    assert.deepEqual(source(store, m.id), ['Untitled meeting', 'Untitled meeting']);
    assert.equal(store.titleFromNotes(m.id, '"Kite festival budget."'), true);
    assert.deepEqual(source(store, m.id), ['Kite festival budget', 'Kite festival budget']);
    assert.equal(store.titleFromNotes(m.id, 'Kite festival budget and venue'), true);
    assert.deepEqual(source(store, m.id), ['Kite festival budget and venue', 'Kite festival budget and venue']);
    store.rename(m.id, 'My kite notes');
    assert.equal(store.titleFromNotes(m.id, 'Kite festival recap'), false);
    assert.deepEqual(source(store, m.id), ['My kite notes', null]);
  } finally { store.close(); }
});

test('a rename by an older build, which knows nothing of autoTitle, still keeps the user\'s name', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-title-downgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new MeetingStore(directory);
  const dated = store.createMeeting('Meeting Nov 6, 11:30 PM', true), named = store.createMeeting();
  assert.equal(store.titleFromNotes(named.id, 'Lantern parade route'), true);
  store.close();
  // The older build's rename (src/store.ts before this column): it sets the title only.
  const db = new DatabaseSync(join(directory, 'meetings.sqlite'));
  db.prepare('UPDATE meetings SET title=? WHERE id=?').run('Q4 lantern budget', dated.id);
  db.prepare('UPDATE meetings SET title=? WHERE id=?').run('My parade notes', named.id);
  db.close();
  store = new MeetingStore(directory);
  try {
    assert.equal(store.titleFromNotes(dated.id, 'Kite festival'), false);
    assert.equal(store.titleFromNotes(named.id, 'Kite festival'), false);
    assert.equal(store.meeting(dated.id).title, 'Q4 lantern budget', 'a dated name the user renamed stays');
    assert.equal(store.meeting(named.id).title, 'My parade notes', 'a notes name the user renamed stays');
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
  const dated = await create({ title: 'Meeting Apr 9, 02:05 PM', autoTitle: true });
  assert.equal(dated.autoTitle, 'Meeting Apr 9, 02:05 PM');
  await write(dated.id);
  assert.deepEqual([(await meetingOf(dated.id)).title, (await meetingOf(dated.id)).autoTitle], ['Lantern parade route', 'Lantern parade route']);
  assert.equal((await call(`/api/meetings/${dated.id}/notes`)).notes.title, 'Meeting Apr 9, 02:05 PM', 'the notes keep their snapshot title');
  title = '"Lantern parade route and rack."';
  await write(dated.id);
  assert.equal((await meetingOf(dated.id)).title, 'Lantern parade route and rack');

  // Empty and garbage suggestions keep the name.
  for (const bad of ['', '  ', '...', 17]) {
    title = bad; await write(dated.id);
    assert.deepEqual([(await meetingOf(dated.id)).title, (await meetingOf(dated.id)).autoTitle], ['Lantern parade route and rack', 'Lantern parade route and rack'], String(bad));
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
  assert.equal(renamed.autoTitle, null);
  await write(dated.id);
  assert.deepEqual([(await meetingOf(dated.id)).title, (await meetingOf(dated.id)).autoTitle], ['My lantern notes', null]);

  // A typed name (or an older caller that does not say) is the user's; no name at all is the app's.
  const typed = await create({ title: 'Kite club planning' });
  assert.equal(typed.autoTitle, null);
  await write(typed.id);
  assert.equal((await meetingOf(typed.id)).title, 'Kite club planning');
  const untitled = await create({});
  assert.deepEqual([untitled.title, untitled.autoTitle], ['Untitled meeting', 'Untitled meeting']);
  await write(untitled.id);
  assert.deepEqual([(await meetingOf(untitled.id)).title, (await meetingOf(untitled.id)).autoTitle], ['Kite festival', 'Kite festival']);
});
