import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Element, event, type UIEvent } from './helpers/ui-dom.ts';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
function fixture() {
  const elements: Record<string, Element> = {};
  const doc = { activeElement: null as Element | null, addEventListener: (_name: string, _fn: (e: UIEvent) => void) => {} };
  const $ = (id: string) => elements[id] ??= Object.assign(new Element('div'), { id, onFocus: () => { doc.activeElement = $(id); } });
  // Read the real markup so missing/reordered links cannot be hidden by a hand-built fixture.
  for (const id of ['meeting-menu', 'transcript-menu']) {
    const body = html.split(`id="${id}"`)[1]?.split(id === 'meeting-menu' ? '</div>\n    </div>' : '</div>')[0] ?? '';
    const query = $(id).querySelectorAll.bind($(id));
    $(id).querySelectorAll = selector => query(selector === '[role^="menuitem"]' ? '[role="menuitem"]' : selector);
    for (const match of body.matchAll(/<(button|a)[^>]*id="([^"]+)"[^>]*>/g)) {
      const node = $(match[2]); node.tagName = match[1].toUpperCase(); node.hidden = /\bhidden\b/.test(match[0]);
      node.setAttribute('role', 'menuitem'); $(id).append(node);
    }
    $(id).hidden = true;
  }
  const source = app.slice(app.indexOf('function updateTranscriptDownloads('), app.indexOf('function selectMeeting('));
  assert.ok(source.includes('function updateTranscriptDownloads('), 'shared current-meeting link update exists');
  const keys = app.slice(app.indexOf('function bindMenuKeys('), app.indexOf('let notesMenuOpener'));
  const settings = app.slice(app.indexOf('// ---------- Transcript downloads ----------'), app.indexOf('// ---------- End transcript downloads ----------'));
  const meeting = app.slice(app.indexOf('function menuItems()'), app.indexOf('// Rename in place:'));
  const context = { $, document: doc, projectView: {}, closePanel() {} };
  runInNewContext(source + keys + settings + meeting, context);
  return { $, doc, update: (id: string | null) => runInNewContext('updateTranscriptDownloads(id)', { ...context, id }),
    open: () => runInNewContext('openMeetingMenu()', context) };
}

test('meeting transcript downloads have current hrefs, exact order, download semantics and hide without a meeting', () => {
  const f = fixture(); f.update('forest');
  const ids = ['meeting-export', 'meeting-export-plain', 'meeting-export-raw'];
  const paths = ['transcript.md', 'transcript.txt', 'transcript.md?mode=raw'];
  ids.forEach((id, i) => {
    assert.equal(f.$(id).href, `/api/meetings/forest/${paths[i]}`);
    assert.match(html, new RegExp(`<a id="${id}"[^>]*class="menu-item"[^>]*role="menuitem"[^>]*download`));
    assert.equal(f.$(id).hidden, false);
  });
  f.open();
  assert.equal(f.doc.activeElement, f.$('new-meeting'));
  const key = (key: string) => f.$('meeting-menu').listeners.keydown(event(key));
  for (const id of ['rename-meeting', 'open-replay', ...ids]) { key('ArrowDown'); assert.equal(f.doc.activeElement, f.$(id)); }
  key('Home'); assert.equal(f.doc.activeElement, f.$('new-meeting'));
  key('End'); assert.equal(f.doc.activeElement, f.$('move-meeting'));
  f.update('renamed-meeting');
  assert.equal(f.$('meeting-export-plain').href, '/api/meetings/renamed-meeting/transcript.txt');
  f.update(null);
  for (const id of ['meeting-download-sep', 'meeting-download-label', ...ids]) assert.equal(f.$(id).hidden, true);
  key('Home'); key('ArrowDown'); key('ArrowDown'); key('ArrowDown');
  assert.equal(f.doc.activeElement, f.$('switch-project'), 'hidden downloads are skipped');
});

test('Space activates the focused meeting-menu download link', () => {
  const f = fixture(); f.update('forest'); f.open();
  const key = (key: string) => f.$('meeting-menu').listeners.keydown(event(key));
  for (let i = 0; i < 4; i++) key('ArrowDown');
  assert.equal(f.doc.activeElement, f.$('meeting-export-plain'));
  let clicks = 0;
  f.$('meeting-export-plain').onclick = () => { clicks++; };
  key(' ');
  assert.equal(clicks, 1);
});

test('Settings Transcript menu shares the three items and supports choice, keyboard, Escape and Tab', () => {
  const f = fixture(); f.update('forest');
  const ids = ['export', 'export-plain', 'export-raw'];
  const paths = ['transcript.md', 'transcript.txt', 'transcript.md?mode=raw'];
  ids.forEach((id, i) => assert.equal(f.$(id).href, `/api/meetings/forest/${paths[i]}`));
  assert.match(html, /id="transcript-options"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(html, /Without timestamps \(\.txt\)/);
  for (const id of ['meeting-export-raw', 'export-raw']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>Raw speech recognition \\(\\.md\\)<span class="muted small">Before glossary corrections</span>`));
  }
  f.$('transcript-options').onkeydown!(event('ArrowDown'));
  assert.equal(f.doc.activeElement, f.$('export'));
  f.$('transcript-menu').listeners.keydown(event('ArrowDown'));
  assert.equal(f.doc.activeElement, f.$('export-plain'));
  f.$('transcript-menu').listeners.keydown(event('Escape'));
  assert.equal(f.$('transcript-menu').hidden, true);
  assert.equal(f.doc.activeElement, f.$('transcript-options'));
  f.$('transcript-options').onclick!();
  f.$('transcript-menu').listeners.keydown(event('Tab'));
  assert.equal(f.$('transcript-menu').hidden, true);
  f.$('transcript-options').onclick!();
  f.$('transcript-menu').listeners.click(event(undefined, f.$('export-plain')));
  assert.equal(f.$('transcript-menu').hidden, true);
  assert.equal(f.doc.activeElement, f.$('export'), 'choosing a download does not jump focus');
});
