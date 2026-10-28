// Run outside node:test: the regression used to throw uncaught from the server's real five-second board timer.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../src/server.ts';
import { Boards } from '../../src/board.ts';

// Observe the real watcher without replacing its work or accelerating its interval.
const ticks: string[] = [], tick = Boards.prototype.tick;
Boards.prototype.tick = function(id, finished) { ticks.push(id); return tick.call(this, id, finished); };

const directory = process.argv[2];
if (!directory) throw new Error('A temporary data directory is required.');
let now = 100_000;
const app = await startServer({ directory, port: 0, clock: () => now, quick: null,
  heavy: async () => { throw new Error('fixture glossary failure'); }, notes: null, actions: null, board: null, plans: null, drafts: null,
  recognizer: { async transcribe() { return { text: 'Saved transcript.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; }, close() {} } });
try {
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, init: RequestInit = {}) => fetch(`${app.url}${path}`, { ...init,
    headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...init.headers } });
  const post = (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) });
  const removed = app.store.createMeeting('Delete watched meeting'), kept = app.store.createMeeting('Keep watched meeting');
  const projectResponse = await post('/api/projects', { name: 'Keep scoped build state' });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();
  assert.equal((await post(`/api/meetings/${kept.id}/project`, { projectId: project.id })).status, 200);
  for (const meeting of [removed, kept]) {
    const source = `mic:${randomUUID()}`;
    assert.equal((await request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: {
      'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
    } })).status, 201);
    assert.equal((await post(`/api/meetings/${meeting.id}/pcm/end`, { source, lastSequence: 0 })).status, 200);
    await app.jobs!.wait();
    assert.equal((await post(`/api/meetings/${meeting.id}/materials`, { path: directory })).status, 201);
    assert.equal((await post(`/api/meetings/${meeting.id}/glossary/build`, {})).status, 202);
  }
  async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (!(await check())) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  for (const meeting of [removed, kept]) await until(async () => Boolean((await (await request(`/api/meetings/${meeting.id}/glossary`)).json()).building?.error), 'glossary build should settle');
  now += 70_000;
  for (const meeting of [removed, kept]) assert.equal((await post('/api/live/reveal', { meetingId: meeting.id, cardId: `card-${meeting.id}` })).status, 200);
  await until(() => ticks.includes(removed.id) && ticks.includes(kept.id), 'both meetings should be watched by the board timer');
  app.store.deleteMeeting(removed.id);
  ticks.length = 0;
  await until(() => ticks.includes(kept.id), 'surviving meeting should still receive board ticks');
  assert.equal(ticks.includes(removed.id), false, 'the timer must not visit a deleted meeting');
  assert.equal((await request(`/api/meetings/${removed.id}`)).status, 404);
  assert.equal((await (await request('/api/status')).json()).recording, false);
  assert.equal((await (await request(`/api/meetings/${kept.id}/glossary`)).json()).building.error, 'fixture glossary failure', 'project-scoped build state stays');
  assert.equal((await (await request(`/api/meetings/${kept.id}/segments`)).json()).reveal.cardId, `card-${kept.id}`, 'surviving meeting reveal stays');
  // Diagnostic ID reuse in this TEMP database makes otherwise private stale caches observable through the normal APIs.
  app.store.db.prepare('INSERT INTO meetings(id,title,createdAt) VALUES (?,?,?)').run(removed.id, 'Fresh row, no previous workflow', now);
  const fresh = await (await request(`/api/meetings/${removed.id}/segments`)).json();
  assert.equal(fresh.reveal, null, 'deleted meeting reveal was pruned, not merely hidden by the 404');
  assert.equal((await (await request(`/api/meetings/${removed.id}/glossary`)).json()).building, null, 'meeting-scoped failed build state was pruned');
  ticks.length = 0;
  await until(() => ticks.includes(kept.id), 'surviving watcher should continue across another tick');
  assert.equal(ticks.includes(removed.id), false, 'pruned watcher cannot revive on ID reuse');
  console.log('PASS: real board ticks prune deleted IDs; surviving watcher, reveal and project build remain intact.');
} finally { await app.close(); Boards.prototype.tick = tick; }
