import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Element, event, type UIEvent } from './helpers/ui-dom.ts';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('Cloud settings render no web note or install command, including after switching from local mode', () => {
  const elements: Record<string, { hidden: boolean; children: unknown[]; replaceChildren(...children: unknown[]): void }> = {};
  const $ = (id: string) => elements[id] ??= { hidden: true, children: [], replaceChildren(...children) { this.children = children; } };
  const source = app.slice(app.indexOf('function setupStatusChanged('), app.indexOf('const setupUi ='));
  const context = { $, setupSnapshot: null, renderStatusDot() {}, copyCommand: (command: string) => ({ command }) };
  runInNewContext(`${source}\nglobalThis.render = setupStatusChanged;`, context);
  const render = (context as typeof context & { render: (snapshot: unknown) => void }).render;
  const show = (mode: string, web: boolean) => render({ rows: [{ id: 'ai', mode, web }] });
  show('cloud', false);
  assert.equal($('setup-web').hidden, true);
  assert.deepEqual($('setup-web').children, []);
  show('local', false);
  assert.equal($('setup-web').hidden, false);
  assert.deepEqual($('setup-web').children, ['Web lookups are unavailable in On this Mac mode.']);
  show('cloud', false);
  assert.equal($('setup-web').hidden, true);
  assert.deepEqual($('setup-web').children, []);
  for (const [mode, web] of [['off', false], ['cloud', true]] as const) {
    show(mode, web);
    assert.equal($('setup-web').hidden, true);
    assert.deepEqual($('setup-web').children, []);
  }
});

function selectionFixture(web: boolean | null) {
  const elements: Record<string, Element> = {};
  const listeners: Record<string, (event: UIEvent) => void> = {};
  const doc = { activeElement: null as Element | null, addEventListener: (name: string, fn: (event: UIEvent) => void) => { listeners[name] = fn; } };
  const $ = (id: string) => elements[id] ??= new Element('div');
  const menu = $('selection-menu');
  const body = html.split('<div class="selection-actions">')[1].split('</div>')[0];
  for (const match of body.matchAll(/<button[^>]*data-action="([^"]+)"[^>]*>([^<]+)<\/button>/g)) {
    const button = new Element('button', match[2]);
    button.dataset.action = match[1]; button.hidden = /\bhidden\b/.test(match[0]);
    button.onFocus = () => { doc.activeElement = button; };
    menu.append(button);
  }
  const query = menu.querySelectorAll.bind(menu);
  menu.querySelectorAll = selector => query(selector === '.selection-actions button' ? 'button' : selector);
  const rect = { top: 100, bottom: 120, left: 10, width: 600 };
  Object.assign(menu, { style: {}, offsetWidth: 300, offsetHeight: 60 });
  Object.assign($('transcript'), { contains: () => true, parentElement: { getBoundingClientRect: () => rect }, getBoundingClientRect: () => rect,
    querySelectorAll: (selector: string) => selector === 'span[data-id]' ? [{ dataset: { id: 's1' } }] : [] });
  const range = { commonAncestorContainer: {}, intersectsNode: () => true, getBoundingClientRect: () => rect,
    cloneContents: () => ({ textContent: 'Selected speech', querySelectorAll: () => [] }) };
  const actionsView = { web, owner: 'm1', sequence: 0 };
  const context = { $, document: doc, window: { getSelection: () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }) },
    activeRange: () => range, actionsView, meetingId: 'm1', guarded: (fn: unknown) => fn,
    clearTimeout() {}, setTimeout() {}, api: async () => ({ jobs: [], enabled: true, materials: false, web: actionsView.web }),
    renderActions() {}, updateBoardBadge() {}, startAction() {} };
  const source = app.slice(app.indexOf('// Selection menu (M3):'), app.indexOf('// ---------- Polling ----------'));
  const refresh = app.slice(app.indexOf('async function refreshActions()'), app.indexOf('// ---------- Board (M4):'));
  runInNewContext(`${source}\n${refresh}\nglobalThis.open = placeSelectionMenu; globalThis.refresh = refreshActions;`, context);
  const functions = context as typeof context & { open: () => void; refresh: () => Promise<void> };
  return { $, menu, doc, listeners, actionsView, open: functions.open, refresh: functions.refresh };
}

test('Look up is absent when web is missing or unknown and present when available', () => {
  for (const web of [false, null, true]) {
    const f = selectionFixture(web); f.open();
    assert.equal(f.menu.hidden, false);
    assert.equal(f.menu.querySelector('[data-action="lookUp"]')!.hidden, web !== true);
    assert.equal(f.menu.querySelector('[data-action="explain"]')!.hidden, false);
    assert.equal(f.menu.querySelector('[data-action="answer"]')!.hidden, false);
    assert.equal(f.$('selection-hint').textContent, '');
  }
});

test('selection keyboard navigation skips hidden Look up in both directions', () => {
  const f = selectionFixture(false); f.open();
  f.menu.querySelector('[data-action="findSource"]')!.focus();
  f.listeners.keydown(event('ArrowRight'));
  assert.equal(f.doc.activeElement, f.menu.querySelector('[data-action="other"]'));
  f.listeners.keydown(event('ArrowLeft'));
  assert.equal(f.doc.activeElement, f.menu.querySelector('[data-action="findSource"]'));
});

test('availability refresh updates an already open selection menu', async () => {
  const f = selectionFixture(true); f.open();
  const lookUp = f.menu.querySelector('[data-action="lookUp"]')!;
  assert.equal(lookUp.hidden, false);
  f.actionsView.web = false; await f.refresh();
  assert.equal(lookUp.hidden, true);
  f.actionsView.web = true; await f.refresh();
  assert.equal(lookUp.hidden, false);
});
