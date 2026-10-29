import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Element, event, words, type UIEvent } from './helpers/ui-dom.ts';
// @ts-expect-error browser fixture module
import { STATES } from '../public/plans-fixtures-data.js';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const plans = (await readFile(new URL('../public/plans.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');

test('Plans belongs to both tab lists, persists, selects its panel only on request, and arrow navigation includes it', () => {
  assert.match(html, /id="plans-panel" role="tabpanel" aria-labelledby="tab-plans"/);
  const wide = [...html.matchAll(/id="tab-(\w+)" role="tab"/g)].map(m => m[1]);
  const compact = [...html.matchAll(/id="ctab-(\w+)" role="tab"/g)].map(m => m[1]);
  assert.deepEqual(wide, ['board', 'notes', 'plans', 'project']);
  assert.deepEqual(compact, ['live', 'board', 'notes', 'plans', 'project']);
  const nodes: Record<string, Element> = {};
  const $ = (id: string) => nodes[id] ??= new Element('button');
  const tabs = new Element('div');
  const saved = new Map<string, string>();
  const context = {
    $, document: { querySelector: () => tabs }, notesView: { tab: 'board' }, layoutView: { compact: false, tab: 'live' },
    store: { set: (k: string, v: string) => saved.set(k, v) }, projectView: { project: { id: 'p' } as { id: string } | null },
    closeNotesMenu() {}, plansView: { refresh() {}, closeMenu() {} }, refreshNotes() {}, refreshProject() {}, updateBoardBadge() {},
    closePanel() {}, closeSelectionMenu() {}, saveScroll() {}, restoreScroll() {},
  };
  runInNewContext(app.slice(app.indexOf('const SECTION_TITLES ='), app.indexOf('// ---------- Layouts:')), context);
  assert.equal(context.notesView.tab, 'board');
  $('tab-notes').click(); tabs.listeners.keydown(event('ArrowRight'));
  assert.equal(context.notesView.tab, 'plans');
  assert.equal($('plans-panel').hidden, false);
  assert.equal($('notes-panel').hidden, true);
  assert.equal(saved.get('right-tab'), 'plans');
  assert.equal($('tab-plans').tabIndex, 0);
  context.projectView.project = null; $('tab-project').hidden = true;
  tabs.listeners.keydown(event('ArrowRight'));
  assert.equal(context.notesView.tab, 'board');
  const compactList = new Element('div'); nodes['compact-tabs'] = compactList;
  const body = { dataset: {} };
  Object.assign(context.document, { body });
  runInNewContext(app.slice(app.indexOf('function compactTabs()'), app.indexOf('function setBoardWidth(')), context);
  context.layoutView.compact = true;
  $('ctab-notes').click(); compactList.listeners.keydown(event('ArrowRight'));
  assert.equal(context.layoutView.tab, 'plans');
  assert.equal(saved.get('compact-tab'), 'plans');
  assert.equal($('ctab-plans').tabIndex, 0);
  assert.match(app, /\['notes', 'plans', 'project'\]\.includes\(store.get\('right-tab'\)\)/);
  assert.match(app, /\['board', 'notes', 'plans', 'project'\]\.includes\(store.get\('compact-tab'\)\)/);
});

async function fixture(state: string) {
  const page = structuredClone(STATES[state].page);
  const listeners: Record<string, (e: UIEvent) => void> = {};
  const doc = { activeElement: null as Element | null, createElement: (tag: string) => {
    const node = new Element(tag); node.onFocus = () => { doc.activeElement = node; }; return node;
  }, addEventListener: (name: string, fn: (e: UIEvent) => void) => { listeners[name] = fn; } };
  const host = doc.createElement('section');
  const api = { getPlans: async () => structuredClone(page) };
  const context = { document: doc, host, api, CSS: { escape: (s: string) => s }, crypto, URL, Blob,
    stamp: (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`,
    requestAnimationFrame: (fn: () => void) => fn(), setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    hooks: { meetingId: () => 'm', meetingTitle: () => 'Meeting', visible: () => false, log() {}, noteCounts: () => ({ questions: 3, actions: 2 }) },
  };
  runInNewContext(plans + '\nglobalThis.view = createPlansView({host, api, hooks});', context);
  const view = (context as typeof context & { view: { refresh: () => Promise<void>; closeMenu: () => void } }).view;
  await view.refresh();
  return { page, host, doc, view, listeners };
}

test('Plans no-notes is exactly one calm line; idle is a primary card with real counts and an off-cloud variant', async () => {
  const f = await fixture('idle');
  assert.match(words(f.host), /Answers and next steps for the 3 open questions and 2 actions in the notes\. About 2 minutes\./);
  assert.equal(f.host.querySelector('.primary')!.textContent, 'Plan');
  assert.equal(f.host.querySelector('.plans-head'), null);
  f.page.enabled = false; await f.view.refresh();
  assert.match(words(f.host), /AI models, which are off/);
  assert.equal(f.host.querySelector('button'), null);
  f.page.notes = null; await f.view.refresh();
  assert.equal(f.host.hidden, false);
  assert.equal(words(f.host), 'Plans are made from the notes. Write the notes first.');
  assert.equal(f.host.querySelector('button'), null);
});

test('Plans running uses the four-step card and Cancel, waiting retains its explicit reason', async () => {
  const f = await fixture('running');
  const card = f.host.querySelector('.job-progress')!;
  assert.match(words(card), /Making plans · .*Cancel/);
  assert.deepEqual(card.querySelectorAll('.progress-label').map(n => n.textContent), ['Read the notes', 'Read your materials', 'Write the plans', 'Check every source']);
  assert.match(words(card), /3\u00a0web\u00a0pages · 1\u00a0check\u00a0run/);
  assert.equal(card.querySelector('.progress-cancel')!.textContent, 'Cancel');
  assert.equal(f.host.querySelector('.plans-reading'), null, 'no extra status row');
  assert.equal(f.host.querySelector('.plans-head'), null);
  const waiting = await fixture('waiting-recording');
  assert.match(words(waiting.host.querySelector('.plans-status')!), /waiting for the recording to end/);
  waiting.host.querySelector('[data-focus="options"]')!.click();
  assert.equal(waiting.host.querySelector('[data-focus="plan-again"]')!.getAttribute('aria-disabled'), 'false', 'waiting automatic run can still be replaced');
});

test('plans progress-only updates keep saved rows and focused controls, with unknown expected count', async () => {
  const f = await fixture('replanning');
  const row = f.host.querySelector('.plan-row')!;
  const control = row.querySelector('button')!; control.focus();
  f.page.run.progress = { ...f.page.run.progress, phase: 'write', written: 2, latest: 'A streamed label', expected: null };
  await f.view.refresh();
  assert.equal(f.host.querySelector('.plan-row'), row);
  assert.equal(f.doc.activeElement, control);
  assert.match(words(f.host.querySelector('.job-progress')!), /2 so far Latest: A streamed label/);
});

test('Explore further gets the same isolated progress card and retains focused saved plans', async () => {
  const f = await fixture('explore-stopped');
  f.page.run.state = 'running'; f.page.run.finishedAt = null;
  f.page.run.progress = { phase: 'materials', startedAt: Date.now(), materials: ['guide.md'], files: 1, pages: 1, checks: 1, questions: 1, written: 0, expected: 1, latest: null, estimate: 630000 };
  await f.view.refresh();
  const card = f.host.querySelector('.job-progress'); assert.ok(card, 'Explore further has phase/clock/Cancel card');
  const row = f.host.querySelector('.plan-row')!, control = row.querySelector('button')!; control.focus();
  f.page.run.progress = { ...f.page.run.progress, phase: 'write', written: 1, latest: 'An explored label' };
  await f.view.refresh();
  assert.equal(f.host.querySelector('.plan-row'), row); assert.equal(f.doc.activeElement, control);
  const text = words(f.host.querySelector('.job-progress')!).replaceAll('\u00a0', ' ');
  assert.match(text, /1 open question/); assert.doesNotMatch(text, /open decisions|1 open questions|1 web pages|1 checks run/);
  assert.match(text, /1 web page · 1 check run/); assert.match(text, /1 so far Latest: An explored label/);
});

test('Plans planned bar has only Options when fresh; menu owns actions, time and plan-only warnings, with keyboard focus return', async () => {
  const f = await fixture('mixed');
  const options = f.host.querySelector('[data-focus="options"]')!;
  const notesSvg = html.match(/id="notes-options"[^>]*>.*?(<svg.*?<\/svg>)/)?.[1];
  assert.equal(options.innerHTML, notesSvg, 'Notes and Plans Options use the identical SVG');
  assert.match(options.innerHTML, /viewBox="0 0 12 12"/);
  assert.match(options.innerHTML, /d="M3 4.5l3 3 3-3"/);
  assert.match(options.innerHTML, /stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/);
  assert.equal(f.host.querySelector('.plans-head')!.children.length, 1);
  assert.equal(options.getAttribute('aria-expanded'), 'false');
  const originalHead = f.host.querySelector('.plans-head')!;
  options.click();
  f.listeners.click({ ...event(undefined, options), composedPath: () => [options, originalHead, f.host] });
  assert.equal(f.host.querySelector('[data-focus="options"]')!.getAttribute('aria-expanded'), 'true', 'the opening click is not an outside click after re-render');
  assert.equal(f.doc.activeElement?.textContent, 'Plan again');
  const menu = f.host.querySelector('#plans-menu')!;
  assert.deepEqual(menu.querySelectorAll('[role="menuitem"]').map(n => n.textContent), ['Plan again', 'Download (.md)']);
  assert.match(words(menu), /Made at/);
  assert.doesNotMatch(words(menu), /About these plans/);
  assert.equal(menu.querySelector('h3'), null);
  assert.equal(menu.querySelector('.notes-about')!.children[0].tagName, 'P');
  assert.doesNotMatch(words(menu), /notes version|Missing speech:/);
  assert.match(words(menu), /Sources are checked, not the ideas themselves/);
  assert.match(words(menu), /Quick checks were off/);
  assert.equal(f.host.querySelector('.plans-banner'), null, 'document warnings are not banners');
  menu.onkeydown!(event('ArrowDown')); assert.equal(f.doc.activeElement?.textContent, 'Download (.md)');
  menu.onkeydown!(event('Home')); assert.equal(f.doc.activeElement?.textContent, 'Plan again');
  menu.onkeydown!(event('Escape'));
  assert.equal(f.host.querySelector('#plans-menu'), null);
  assert.equal(f.doc.activeElement?.dataset.focus, 'options');
  f.host.querySelector('[data-focus="options"]')!.click();
  f.listeners.focusin(event(undefined, new Element('button')));
  assert.equal(f.host.querySelector('#plans-menu'), null, 'focus leaving dismisses the menu');
  f.host.querySelector('[data-focus="options"]')!.click();
  f.listeners.click(event(undefined, new Element('div')));
  assert.equal(f.host.querySelector('#plans-menu'), null, 'outside click dismisses the menu');
});

test('Plans folds have plain labels, toggle aria-expanded and stay with the rows on one surface', async () => {
  const f = await fixture('plans');
  const card = f.host.querySelector('.plans-card')!;
  assert.ok(card.contains(f.host.querySelector('.plans-list')));
  assert.ok(card.contains(f.host.querySelector('.plans-aside')));
  assert.deepEqual(card.children.map(n => n.className), ['plans-list', 'plans-aside']);
  const more = () => f.host.querySelector('[data-focus="more"]')!;
  assert.equal(more().textContent, '3 more');
  assert.equal(more().getAttribute('aria-expanded'), 'false');
  more().click();
  assert.equal(more().textContent, 'Show fewer');
  assert.equal(more().getAttribute('aria-expanded'), 'true');
  assert.equal(f.host.querySelectorAll('.plan').length, 6);
  more().click(); assert.equal(f.host.querySelectorAll('.plan').length, 3);
  const aside = () => f.host.querySelector('[data-focus="aside"]')!;
  assert.equal(aside().textContent, 'Not planned (2)');
  aside().click(); assert.equal(aside().getAttribute('aria-expanded'), 'true');
  assert.ok(f.host.querySelector('.plans-aside-list'));
  aside().click(); assert.equal(aside().getAttribute('aria-expanded'), 'false');
  const mixed = await fixture('mixed');
  mixed.host.querySelector('[data-focus="review"]')!.click();
  assert.equal(mixed.host.querySelector('[data-focus="review"]')!.getAttribute('aria-expanded'), 'true');
  assert.equal(mixed.host.querySelector('[data-focus="review"]')!.textContent, 'Needs review (2)');
  assert.doesNotMatch(plans, /[▸▾]/, 'disclosure chevrons are visual, never text characters in labels');
});

for (const change of ['transcript', 'notes'] as const) test(`Plans stale control and Options use the server's ${change} wording`, async () => {
  const f = await fixture('plans');
  const label = `Made before the ${change} changed`;
  f.page.current.plans[0].freshness = { current: false, changed: [change], label };
  f.page.current.warnings.push('The transcript changed after the notes were written.');
  await f.view.refresh();
  const stale = f.host.querySelector('.plans-stale')!;
  assert.equal(stale.textContent, label);
  stale.click();
  const menu = words(f.host.querySelector('#plans-menu')!);
  assert.ok(menu.includes(`${label}.`));
  assert.ok(menu.includes('The transcript changed after the notes were written.'), 'Options must not filter the transcript warning as coverage noise');
  if (change === 'transcript') assert.doesNotMatch(menu, /Made before the notes changed/);
});

test('Plans stale bar uses any per-plan freshness, not document-level or current notes-version guesses', async () => {
  const f = await fixture('plans');
  f.page.current.freshness = { current: false, label: 'Ignore this aggregate', changed: ['notes'] };
  await f.view.refresh();
  assert.equal(f.host.querySelector('.plans-stale'), null);
  f.page.current.plans[1].freshness = { current: false, label: 'Made before the materials changed', changed: ['materials'] };
  await f.view.refresh();
  const stale = f.host.querySelector('.plans-stale')!;
  assert.equal(stale.textContent, 'Made before the materials changed');
  stale.click();
  assert.equal(f.doc.activeElement?.textContent, 'Plan again');
  assert.match(words(f.host.querySelector('#plans-menu')!), /Made before the materials changed\./);
  assert.doesNotMatch(words(f.host.querySelector('#plans-menu')!), /Made before the notes changed/);
  assert.doesNotMatch(words(f.host.querySelector('#plans-menu')!), /Ignore this aggregate/);
  f.host.querySelector('#plans-menu')!.onkeydown!(event('Escape'));
  assert.equal(f.doc.activeElement?.dataset.focus, 'plans-stale');
});
