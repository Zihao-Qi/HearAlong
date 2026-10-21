import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const render = app.slice(app.indexOf('function renderNotes('), app.indexOf('async function refreshNotes('));
const menu = app.slice(app.indexOf('// ---------- Notes options ----------'), app.indexOf("$('copy-notes').onclick"));

import { Element, event, words, type UIEvent as Event } from './helpers/ui-dom.ts';
const rows = app.slice(app.indexOf('function noteItem('), app.indexOf('/** Adjacent gaps'));
function fixture() {
  const elements: Record<string, Element> = {};
  const $ = (id: string) => elements[id] ??= new Element('div');
  const doc = { activeElement: null as Element | null, addEventListener: (name: string, fn: (event: Event) => void) => { listeners[name] = fn; } };
  const listeners: Record<string, (event: Event) => void> = {};
  for (const id of ['write-notes', 'notes-options', 'notes-stale', 'rewrite-notes', 'copy-notes']) $(id).tagName = 'BUTTON';
  $('export-notes').tagName = 'A';
  $('notes-menu').hidden = true;
  $('notes-menu').append(...['rewrite-notes', 'export-notes', 'copy-notes'].map(id => {
    const node = $(id); node.setAttribute('role', 'menuitem'); return node;
  }));
  for (const node of Object.values(elements)) node.onFocus = () => { doc.activeElement = node; };
  const posts: string[] = [];
  const context = {
    $, document: doc, meetingId: 'meeting-1',
    el: (tag: string, text?: string, className?: string) => {
      const node = new Element(tag, text, className); node.onFocus = () => { doc.activeElement = node; }; return node;
    },
    SECTION_TITLES: { summary: 'Summary', decisions: 'Decisions', actions: 'Actions', openQuestions: 'Open questions' },
    stamp: (ms: number) => `${ms / 1000}s`, gapText: () => '10–20 (unrecognised)',
    guarded: (fn: unknown) => fn, base: () => '/api/meetings/meeting-1',
    post: async (url: string) => { posts.push(url); }, notesView: { signature: 'old' }, refreshNotes: async () => {},
    jumpTo: (owner: string, id: string, version: number) => jumps.push([owner, id, version]),
    lookIntoIt: () => new Element('button', 'Look into it'),
  };
  const jumps: unknown[][] = [];
  runInNewContext(rows + render + menu, context);
  const record = {
    version: 2, title: 'Meeting notes', createdAt: '2026-10-17T12:00:00Z', model: 'scripted',
    input: { coverage: { untilMs: 20000, pendingChunks: 1, gaps: [{ startMs: 10000, reason: 'unrecognised' }], uncorrected: 2 } },
    sources: { s1: { startMs: 1000, text: 'corrected', originalText: 'original' }, s2: { startMs: 2000, text: 'second' } },
    notes: { summary: [] as any[], decisions: [] as any[], actions: [] as any[], openQuestions: [] as any[], otherMatters: [] as any[], needsReview: [] as any[], otherTalk: [] as any[] },
  };
  const data = { notes: record as typeof record | null, enabled: true, stale: false, currentUntilMs: 30000,
    coverage: { gaps: [{ startMs: 25000, reason: 'failed' }] }, job: null as { state: string; startedAt: string } | null };
  return { $, doc, listeners, posts, jumps, data, render: () => runInNewContext(rows + 'renderNotes(data, meetingId)', { ...context, data }) };
}

test('Notes warnings live only in the options menu; fresh notes have no stale line', () => {
  const menuStart = html.indexOf('id="notes-menu"');
  const status = html.indexOf('id="notes-status"');
  assert.ok(html.indexOf('id="notes-warnings"') > menuStart && html.indexOf('id="notes-warnings"') < status);
  assert.equal(html.match(/id="notes-warnings"/g)?.length, 1);
  assert.ok(html.indexOf('id="plans-panel"') > html.indexOf('id="notes-body"'));
  assert.match(html, /id="plans-panel" role="tabpanel"/);
  assert.match(html, /<span class="notes-options-label">Options<\/span><svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /About these notes|notes-about-title/);
  assert.match(html, /id="notes-warnings" role="note" aria-label="Notes details"/);
  const f = fixture(); f.render();
  assert.equal(f.$('notes-stale').hidden, true);
  assert.equal(f.$('notes-menu').hidden, true);
  assert.equal(f.$('write-notes').hidden, true);
  assert.equal(f.$('notes-options').hidden, false);
  assert.equal(f.$('notes-warnings').children.length, 6, 'version, pending chunks, gaps, unchecked lines, new gaps and AI caution');
  assert.ok(f.$('notes-warnings').children.every(node => node.className === 'notes-warning'));
  assert.equal(f.$('export-notes').href, '/api/meetings/meeting-1/notes.md?version=2');
  assert.equal(f.$('export-notes-panel').href, f.$('export-notes').href);
});

test('Only stale notes show the quiet link, which opens options focused on writing again', () => {
  const f = fixture(); f.data.stale = true; f.render();
  assert.equal(f.$('notes-stale').hidden, false);
  const trigger = html.match(/<button id="notes-stale"[^>]+>/)?.[0] ?? '';
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-haspopup="menu"/);
  assert.match(trigger, /aria-controls="notes-menu"/);
  assert.match(html, /id="notes-stale"[^>]*>Older than the transcript<\/button>/);
  f.$('notes-stale').onclick!(event());
  assert.equal(f.$('notes-menu').hidden, false);
  assert.equal(f.$('notes-options').getAttribute('aria-expanded'), 'true');
  assert.equal(f.doc.activeElement, f.$('rewrite-notes'));
  assert.equal(f.$('notes-warnings').children.length, 7);
  assert.match(f.$('notes-warnings').children[1].textContent, /Write the notes again for an up-to-date version\./);
  assert.doesNotMatch(f.$('notes-warnings').children[1].textContent, /regenerate/i);
  f.data.stale = false; f.render();
  assert.equal(f.$('notes-stale').hidden, true);
  assert.equal(f.$('notes-warnings').children.length, 6);
});

test('Notes menu supports arrow keys, Escape with focus return, outside click and focus leaving', () => {
  const f = fixture(); f.render();
  f.$('notes-options').onclick!();
  assert.equal(f.doc.activeElement, f.$('rewrite-notes'));
  const key = (value: string) => f.$('notes-menu').listeners.keydown(event(value));
  key('ArrowDown'); assert.equal(f.doc.activeElement, f.$('export-notes'));
  key('ArrowDown'); assert.equal(f.doc.activeElement, f.$('copy-notes'));
  key('ArrowDown'); assert.equal(f.doc.activeElement, f.$('rewrite-notes'));
  key('ArrowUp'); assert.equal(f.doc.activeElement, f.$('copy-notes'));
  key('Home'); assert.equal(f.doc.activeElement, f.$('rewrite-notes'));
  key('End'); assert.equal(f.doc.activeElement, f.$('copy-notes'));
  key('Escape');
  assert.equal(f.$('notes-menu').hidden, true);
  assert.equal(f.$('notes-options').getAttribute('aria-expanded'), 'false');
  assert.equal(f.doc.activeElement, f.$('notes-options'));
  f.$('notes-options').onkeydown!(event('ArrowUp'));
  assert.equal(f.doc.activeElement, f.$('copy-notes'));
  f.listeners.click(event(undefined, new Element('div')));
  assert.equal(f.$('notes-menu').hidden, true);
  f.$('notes-options').onclick!();
  f.listeners.focusin(event(undefined, new Element('button')));
  assert.equal(f.$('notes-menu').hidden, true);
});

test('Notes menu returns focus to each opener when dismissed without choosing', () => {
  for (const id of ['notes-options', 'notes-stale']) {
    const f = fixture(); f.data.stale = true; f.render();
    const open = () => f.$(id).onclick!(event());
    const closed = () => {
      assert.equal(f.$('notes-menu').hidden, true);
      assert.equal(f.$('notes-options').getAttribute('aria-expanded'), 'false');
      assert.equal(f.doc.activeElement, f.$(id));
    };
    open(); f.$('notes-menu').listeners.keydown(event('Escape')); closed();
    open(); f.listeners.click(event(undefined, new Element('div'))); closed();
    open(); f.listeners.focusin(event(undefined, new Element('button'))); closed();
    open(); f.$(id).onclick!(event()); closed();
  }
});

test('Write again shares Write notes action and disabled/running states; no notes hides options', async () => {
  const f = fixture(); f.render();
  assert.equal(f.$('rewrite-notes').onclick, f.$('write-notes').onclick);
  await f.$('rewrite-notes').onclick!();
  assert.deepEqual(f.posts, ['/api/meetings/meeting-1/notes']);
  for (const running of [false, true]) {
    f.data.enabled = running;
    f.data.job = running ? { state: 'running', startedAt: '2026-10-17T12:00:00Z' } : null;
    f.render();
    assert.equal(f.$('rewrite-notes').getAttribute('aria-disabled'), 'true');
    await f.$('rewrite-notes').onclick!();
    assert.equal(f.posts.length, 1);
    f.data.stale = true; f.render(); f.$('notes-stale').onclick!(event());
    assert.equal(f.doc.activeElement, f.$('rewrite-notes'), 'disabled menu items remain focusable');
    f.$('notes-menu').listeners.keydown(event('Escape'));
  }
  f.data.notes = null; f.render();
  assert.equal(f.$('notes-options').hidden, true);
  assert.equal(f.$('notes-menu').hidden, true);
  assert.equal(f.$('notes-stale').hidden, true);
  assert.equal(f.$('write-notes').hidden, false);
  assert.equal(f.$('write-notes').textContent, 'Writing…');
});

const note = (extra = {}) => ({ text: 'Label the clips.', startMs: 1000, cites: ['s1', 's2'], quote: 'original', quoteIn: 'original', section: 'actions', ...extra });

test('Notes rows toggle details, keep owner tooltip and memory label, and Go to links track visited citations', () => {
  const f = fixture();
  f.data.notes!.notes.actions.push(note({ ownerProposed: 'Marta', label: 'lab', kind: 'todo', reviewReason: 'Check the assignment.' }));
  f.render();
  const body = f.$('notes-body');
  assert.doesNotMatch(words(body), /Meeting notes|Covers the transcript|Nothing recorded for/);
  const row = body.querySelector('.note')!;
  assert.equal(row.querySelector('.owner')!.textContent, 'Marta?');
  assert.match(row.querySelector('.owner')!.title, /no cited line clearly assigns/);
  assert.equal(row.querySelector('.note-memory')!.textContent, 'lab · todo');
  const toggle = row.querySelector('.note-time')!, details = row.querySelector('.note-details')!;
  assert.equal(toggle.textContent, '1s');
  assert.equal(toggle.getAttribute('aria-controls'), details.id);
  assert.equal(details.hidden, true);
  toggle.click();
  assert.equal(details.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.match(words(details), /as originally heard/);
  assert.match(words(details), /Check the assignment/);
  const links = details.querySelectorAll('.cite');
  assert.deepEqual(links.map(n => n.textContent), ['Go to 1s in the transcript', 'Go to 2s in the transcript']);
  links[1].click();
  assert.deepEqual(f.jumps, [['meeting-1', 's2', 2]]);
  assert.equal(links[1].classList.contains('visited'), true);
  toggle.click(); assert.equal(details.hidden, true);
  toggle.click(); toggle.focus();
  f.data.stale = true; f.render();
  const restored = f.$('notes-body').querySelector('.note-details')!;
  assert.equal(restored.hidden, false, 'coverage polling keeps details open');
  assert.equal(restored.querySelectorAll('.cite')[1].classList.contains('visited'), true);
  assert.equal(f.doc.activeElement, f.$('notes-body').querySelector('.note-time'), 'focus survives a same-version redraw');
});

test('Notes folds count other items plus talk ranges, nest small talk, and omit empty review and sections', () => {
  const f = fixture();
  f.data.notes!.notes.otherMatters.push(note({ section: 'otherMatters' }));
  f.data.notes!.notes.otherTalk.push(
    { startMs: 1000, endMs: 2000, fromId: 's1', label: 'Travel', smallTalk: false },
    { startMs: 2000, endMs: 3000, fromId: 's2', label: 'Weather', smallTalk: true });
  f.data.notes!.notes.needsReview.push(note({ reviewReason: 'Quote not found' }));
  f.render();
  const body = f.$('notes-body');
  assert.deepEqual(body.children.map(n => n.children[0].textContent), ['Not about the project (3)', 'Needs review (1)']);
  const other = body.children[0];
  assert.equal(other.tagName, 'DETAILS');
  assert.equal(other.querySelector('.note-details')!.querySelector('button')!.textContent, 'Go to 1s in the transcript');
  assert.match(words(other), /Look into it/);
  assert.equal(other.querySelector('.notes-fold')!.children[0].textContent, 'Small talk (1)');
  assert.ok(other.children.findIndex(n => n.className === 'note') < other.children.findIndex(n => n.className === 'offtopic-row'));
  other.open = true; other.querySelector('.notes-fold')!.open = true;
  f.data.notes!.notes.needsReview = [];
  f.render();
  assert.equal(f.$('notes-body').children.length, 1);
  assert.equal(f.$('notes-body').children[0].open, true);
  assert.equal(f.$('notes-body').querySelector('.notes-fold')!.querySelector('.notes-fold')!.open, true);
});
