import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { MeetingStore } from '../src/store.ts';
import { Memory } from '../src/memory.ts';
import { render } from '../src/memory-files.ts';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (from: string, to: string) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
class Element {
  children: Element[] = []; hidden = false; value = ''; textContent: string; dataset: Record<string, string> = {};
  style = { setProperty() {} }; onclick?: () => Promise<void> | void;
  constructor(text = '') { this.textContent = text; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
}

test('Pi 1: changing project clears old rows immediately and rendered mutations retain their ownership epoch', async () => {
  const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' };
  const item = { id: 'T-1', type: 'todo', status: 'open', version: 1, text: 'A task' };
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const projectView: any = { project: a, projects: [a, b], data: { items: [item] }, sequence: 0, expanded: new Map(), resolved: new Map(), resolvedEdits: new Map(), sources: new Map(), wordings: new Map() };
  const calls: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const context: any = { $, projectView, document: { activeElement: null }, notesView: { tab: 'project' }, layoutView: { compact: false, tab: 'board' },
    compactTabs: () => [], briefEditing() {}, closeVersions() {}, updateProjectBadge() {}, renderMeetingMenu() {}, renderSettingsNav() {}, renderPlanSetting() {},
    store: { get: () => 'project' }, refreshProject: () => pending, requestId: () => 'request', guarded: (fn: any) => fn,
    focusKey: (node: any) => node, el: (_tag: string, text: string) => new Element(text), unconfirmedOf: () => ({ item: false, links: [] }),
    noteRecent() {}, focusItem() {}, renderMemoryLists() {},
    post: async (url: string) => { calls.push(url); await pending; return { items: [item] }; }, send: async () => {}, api: async () => ({}),
  };
  const source = section('let projectEpoch = 0;', 'async function loadProjects')
    + section('function setProject(project)', 'async function refreshProject')
    + section('function itemActions(item)', '/**\n * Inline form');
  runInNewContext(source + '\nif (typeof bindProjectData === "function") bindProjectData(projectView.data); globalThis.box = itemActions(projectView.data.items[0]); globalThis.switchTo = setProject;', context);
  const drop = context.box.children.find((n: Element) => n.textContent === 'Drop');
  $('memory-lists').append(context.box);
  context.switchTo(b); // B's reload is held, just as in the review.
  await assert.rejects(async () => { const work = drop.onclick(); release(); await work; }, /project changed/i);
  assert.deepEqual(calls, [], 'A controls must not send T-1 to B');
  assert.equal(projectView.data, null); assert.equal($('memory-lists').children.length, 0);
  context.switchTo(a);
  await assert.rejects(async () => drop.onclick(), /project changed/i, 'returning to A cannot revive old controls');
  // A request already sent to A may finish, but may not mark B's T-1 as recently changed.
  projectView.data = { items: [item] };
  runInNewContext('if (typeof bindProjectData === "function") bindProjectData(projectView.data); globalThis.newBox = itemActions(projectView.data.items[0]);', context);
  const newDrop = context.newBox.children.find((n: Element) => n.textContent === 'Drop');
  const work = newDrop.onclick(); context.switchTo(b);
  await assert.rejects(work, /project changed/i);
  assert.deepEqual(calls, ['/api/projects/a/memory']);
});

test('Pi 5: action snapshot text and item version come from the same pre-write read', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'meeting-snapshot-race-')));
  const store = new MeetingStore(directory), memory = new Memory(store);
  const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const source = server.slice(server.indexOf('const memorySnapshots = {'), server.indexOf('    const actionJobs = new ActionJobs'));
  const projectId = 'p', meetingId = 'm';
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(r => { release = r; }), writing = new Promise<void>(r => { reached = r; });
  try {
    memory.apply(projectId, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'create', type: 'todo', text: 'Old snapshot wording', source: { kind: 'app' } }] });
    const context: any = { directory, snapshotRoot: join(directory, 'snapshots'), memory, clock: Date.now, projects: { projectOf: () => projectId },
      appStoreRef: { meeting: () => ({ title: 'M' }), meetings: () => [] }, actionJobs: { list: () => [] },
      randomUUID, join, dirname, mkdir, realpath, readdir, stat, rm, renderMemory: render,
      writeFile: async (...args: Parameters<typeof writeFile>) => { if (String(args[0]).endsWith('todos.md')) { reached(); await held; } return writeFile(...args); },
    };
    runInNewContext(stripTypeScriptTypes(source + '\nglobalThis.prepare = memorySnapshots.prepare;'), context);
    const preparing = context.prepare(meetingId);
    await writing;
    memory.apply(projectId, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'edit', item: 'T-1', text: 'New current wording', source: { kind: 'app' } }] });
    release(); const snapshot = await preparing;
    const text = await readFile(join(snapshot.root.path, 'todos.md'), 'utf8');
    assert.match(text, /Old snapshot wording/); assert.doesNotMatch(text, /New current wording/);
    assert.equal(snapshot.pins.items['T-1'].text, 'Old snapshot wording'); assert.equal(snapshot.pins.items['T-1'].version, 1);
    assert.equal(memory.item(projectId, 'T-1')!.version, 2, 'the pill can now correctly say changed since');
  } finally { release(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
