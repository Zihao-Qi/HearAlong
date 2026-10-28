import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Exercise the real Changes selection/confirmation logic; no layout or fake DOM is needed.
const selection = app.slice(app.indexOf('function changesMeeting()'), app.indexOf('function updateProjectBadge()'));
const visibility = app.slice(app.indexOf('function visibleItems()'), app.indexOf('function renderMemoryLists()'));
function view(confirmed: boolean, unconfirmed: { meetingId: string | null; event: string }[]) {
  const item = { id: 'T-1', type: 'todo', status: 'open', fields: {}, confirmed };
  const context = { meetingId: 'live', status: { meetings: [{ id: 'live', projectId: 'p', createdAt: 10 }, { id: 'earlier', projectId: 'p', createdAt: 1 }] },
    projectView: { project: { id: 'p' }, filter: 'changes', data: { proposals: [], items: [item], info: { 'T-1': { meetings: ['deleted'], createdIn: 'deleted', unconfirmed } } } },
    OPEN_STATUSES: ['open', 'in force'], RESOLVED_MS: 15000 };
  return { item, run: (expression: string) => runInNewContext(`(() => { ${selection}\n${visibility}\nreturn (${expression}); })()`, context) };
}

test('deleted-meeting unconfirmed items remain open Changes and visible for confirmation', () => {
  const f = view(false, []);
  assert.equal(f.run('hasOpenChanges()'), true);
  assert.equal(f.run('visibleItems().length'), 1);
  assert.equal(f.run('unconfirmedOf(projectView.data.items[0]).item'), true);
});

test('deleted-meeting unconfirmed sources remain open Changes and included in confirmation', () => {
  const f = view(true, [{ meetingId: 'deleted', event: 'removed-link' }, { meetingId: 'earlier', event: 'other-live-link' }]);
  assert.equal(f.run('hasOpenChanges()'), true);
  assert.equal(f.run('visibleItems().length'), 1);
  assert.equal(f.run('unconfirmedOf(projectView.data.items[0]).links.map(l => l.event).join()'), 'removed-link');
});

test('confirmed deleted-meeting history is not an open Change', () => {
  const f = view(true, []);
  assert.equal(f.run('hasOpenChanges()'), false);
  assert.equal(f.run('visibleItems().length'), 0);
});
