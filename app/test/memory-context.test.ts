import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

test('memory reaches the next meeting: board scans get open items; actions get a read-only snapshot from the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-memory-context-'));
  const boardMessages: string[] = [];
  const actionInputs: string[] = [];
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null,
    board: async message => { boardMessages.push(message); return { text: '{"items":[]}' } as any; },
    actions: async ({ inputPath }) => { actionInputs.push(await readFile(inputPath, 'utf8')); return { text: 'not json', tools: [], toolEvents: 0, toolResults: [], aborted: false, exitCode: 0, exitSignal: null, settled: true, ms: 1 } as any; } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, method = 'GET', body?: unknown) => fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const meeting = app.store.createMeeting('Aquarium opening checklist');
    const words = 'The octopus enclosure has fresh seals and a new latch but the spare feeding tongs are still drying beside the blue sink';
    for (let i = 0; i < 3; i++) {
      const chunk = await app.store.addPcm(meeting.id, 'mic:t', i, i * 20_000, 16000, Buffer.alloc(16000 * 4, i + 1));
      app.store.completeChunk(chunk.id, { text: `${words} ${i}.`, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' } as any);
    }
    // Without a project, nothing about memory is sent.
    assert.equal((await call(`/api/meetings/${meeting.id}/board/scan`, 'POST')).status, 202);
    for (let i = 0; i < 100 && !boardMessages.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.doesNotMatch(boardMessages[0], /Project memory/);
    // A meeting cannot join a project while its board scan runs (the move guard), so wait for the scan to end.
    let created: Response | undefined;
    for (let i = 0; i < 500 && (created = await call('/api/projects', 'POST', { name: 'Tidepool Care', fromMeetingId: meeting.id })).status === 409; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(created!.status, 201);
    const project = await created!.json();
    for (const [requestId, change] of [['r1', { op: 'create', type: 'decision', text: 'Use silicone clips on the octopus lid' }], ['r2', { op: 'create', type: 'todo', text: 'Discard the cracked scoop' }], ['r3', { op: 'status', item: 'T-1', to: 'done' }]] as const) {
      assert.equal((await call(`/api/projects/${project.id}/memory`, 'POST', { requestId, changes: [change] })).status, 200);
    }
    // A new board for a fresh meeting of the project.
    const next = await (await call('/api/meetings', 'POST', { title: 'Next meeting', projectId: project.id })).json();
    for (let i = 0; i < 3; i++) {
      const chunk = await app.store.addPcm(next.id, 'mic:t', i, i * 20_000, 16000, Buffer.alloc(16000 * 4, i + 1));
      app.store.completeChunk(chunk.id, { text: `${words} ${i}.`, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' } as any);
    }
    assert.equal((await call(`/api/meetings/${next.id}/board/scan`, 'POST')).status, 202);
    // Under load the first meeting may be scanned again meanwhile; the new meeting's scan is the one with memory in it.
    const withMemory = () => boardMessages.find(m => /Project memory from earlier meetings/.test(m));
    for (let i = 0; i < 300 && !withMemory(); i++) await new Promise(r => setTimeout(r, 10));
    assert.match(withMemory() ?? '', /Project memory from earlier meetings[^\n]*\n- D-1 \[decision\] Use silicone clips on the octopus lid/);
    assert.doesNotMatch(withMemory()!, /Discard the cracked scoop/, 'only open items');
    // An action gets the snapshot folder as a read-only root, made from the database.
    const segment = app.store.segments(next.id)[0];
    assert.equal((await call(`/api/meetings/${next.id}/actions`, 'POST', { action: 'explain', selection: { text: 'spare feeding tongs', segmentIds: [segment.id] } })).status, 202);
    for (let i = 0; i < 200 && !actionInputs.length; i++) await new Promise(r => setTimeout(r, 10));
    const root = actionInputs[0].match(/- (memory-[a-f0-9-]{36}): (\S+) \(folder\)/);
    assert.ok(root, 'the snapshot is listed with the materials');
    assert.match(await readFile(join(root![2], 'decisions.md'), 'utf8'), /D-1 · Use silicone clips on the octopus lid/);
    const preview = await (await call(`/api/meetings/${next.id}/materials/preview?rootId=${root![1]}&path=decisions.md&from=1&to=7`)).json();
    assert.match(String(preview.text), /D-1/, `its citations can be previewed: ${JSON.stringify(preview)}`);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
