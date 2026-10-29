// AI data boundaries: real domain paths, fictional files/transcripts and scripted model runners only.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { readdirSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { MeetingStore } from '../src/store.ts';
import { ActionJobs, checkFileSource } from '../src/actions.ts';
import { Boards } from '../src/board.ts';
import { Memory } from '../src/memory.ts';
import { MemoryFiles } from '../src/memory-files.ts';
import { Proposals } from '../src/proposals.ts';
import { NotesJobs } from '../src/notes.ts';
import { Projects } from '../src/projects.ts';
import { startServer } from '../src/server.ts';
import { Explorations } from '../src/explorations.ts';
import { Cooldowns } from '../src/quota.ts';
import { PdfText } from '../src/pdf-text.ts';
import { PlanJobs } from '../src/plans/jobs.ts';
import { AutoPlanning, PlanTodos, PlanVersions, buildPlanInput, checkPlans, pinRun, plansDocument } from '../src/plans/index.ts';
import type { PiTaskResult } from '../src/pi-task.ts';
import { allowedPath, readRoots } from '../pi-extensions/read-scope.ts';

const SENTINEL = 'FICTIONAL_CREDENTIAL_ONLY never send this excluded content to a provider';
const LINE = 'Use the sheriff bound for the test tomorrow morning.';
const CORRECTED = 'Use the Chernoff bound for the test tomorrow morning.';
const result = (text: string): PiTaskResult => ({ text, ms: 1, tools: [], toolResults: [], toolEvents: 0, aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true });
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) assert.fail('Timed out waiting for a scripted action'); await new Promise(r => setTimeout(r, 5)); }
}
async function fixture(t: TestContext) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'ai-boundaries-')));
  const directory = join(folder, 'data'); await mkdir(directory);
  const store = new MeetingStore(directory);
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { store.close(); await rm(folder, { recursive: true, force: true }); }
  });
  const meeting = store.createMeeting('Fictional bound selection');
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: LINE, words: [], backend: 'fictional', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
  const segment = store.visibleSegments(meeting.id)[0];
  const correct = () => assert.equal(store.applyEdits(segment.id, segment.revision, CORRECTED, [{ start: 8, end: 22, from: 'sheriff bound', to: 'Chernoff bound' }]), true);
  const material = join(folder, 'materials'); await mkdir(material);
  const root = { id: 'fictional-root', scope: `meeting:${meeting.id}`, path: material, kind: 'folder' as const, label: 'materials' };
  return { folder, directory, store, cleanup, meeting, segment, correct, material, root };
}

test('excluded action citation never becomes evidence, a preview or a follow-up prompt', async t => {
  const f = await fixture(t);
  await writeFile(join(f.material, '.env'), SENTINEL);
  const inputs: string[] = [];
  const jobs = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [f.root], runner: async ({ inputPath }) => {
    inputs.push(await readFile(inputPath, 'utf8'));
    return result(inputs.length === 1 ? `Draft [1]\n<<<META\n${JSON.stringify({ sources: [{ id: 1, type: 'file', rootId: f.root.id, path: '.env', lines: '1', quote: 'unrelated invented words' }] })}\nMETA>>>` : 'A follow-up');
  } });
  f.cleanup.push(() => jobs.close());
  const first = (await jobs.submit(f.meeting.id, { action: 'explain', selection: { text: LINE, segmentIds: [f.segment.id] } })).job;
  await until(() => first.state === 'done' || first.state === 'failed');
  assert.equal(first.state, 'done');
  const follow = (await jobs.submit(f.meeting.id, { parentId: first.id, prompt: 'Explain further' })).job;
  await until(() => follow.state === 'done' || follow.state === 'failed');
  assert.equal(follow.state, 'done');
  assert.equal(inputs[1].includes(SENTINEL), false, 'a failed citation must not smuggle excluded text into the next prompt');
  assert.equal(JSON.stringify(first.result).includes(SENTINEL), false);
  assert.equal(first.result!.checks[0].status, 'invalid');
  await assert.rejects(jobs.preview(f.meeting.id, f.root.id, '.env', 1, 1), { status: 404 });
  // A result persisted by the vulnerable version may already hold the refused excerpt.
  Object.assign(first.result!.checks[0], { status: 'quote not found', excerpt: SENTINEL, citedText: SENTINEL });
  const legacyFollow = (await jobs.submit(f.meeting.id, { parentId: first.id, prompt: 'Explain the old saved answer' })).job;
  await until(() => legacyFollow.state === 'done' || legacyFollow.state === 'failed');
  assert.equal(legacyFollow.state, 'done');
  assert.equal(inputs.at(-1)!.includes(SENTINEL), false, 'old saved evidence must be reauthorized before inheritance');
});

test('citation reads share sensitive, hard-link and protected-data policy; approved memory snapshots still work', async t => {
  const f = await fixture(t);
  const cwd = join(f.directory, 'scratch', 'actions', 'fictional'); await mkdir(cwd, { recursive: true });
  const snapshot = join(f.directory, 'scratch', 'memory-snapshots', 'fictional'); await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, 'brief.md'), 'An approved fictional project brief for the next meeting.');
  await writeFile(join(f.material, 'api-token.txt'), SENTINEL);
  await writeFile(join(f.directory, 'other-meeting.txt'), SENTINEL);
  const outside = join(f.folder, 'outside.txt'); await writeFile(outside, SENTINEL);
  await link(outside, join(f.material, 'linked.txt'));
  const roots = [f.root, { ...f.root, id: 'broad', path: f.folder }, { ...f.root, id: 'memory-fictional', path: snapshot }];
  for (const [rootId, path] of [[f.root.id, 'api-token.txt'], [f.root.id, 'linked.txt'], ['broad', 'data/other-meeting.txt']]) {
    const root = roots.find(r => r.id === rootId)!;
    assert.equal(allowedPath(join(root.path, path), cwd, readRoots([root.path])), false);
    const check = await checkFileSource({ id: 1, rootId, path, lines: '1', quote: SENTINEL }, roots, 60, undefined, cwd);
    assert.equal(check.status, 'invalid', path);
    assert.equal(check.excerpt, undefined);
    assert.equal(check.citedText, undefined);
  }
  const approved = await checkFileSource({ id: 1, rootId: 'memory-fictional', path: 'brief.md', lines: '1', quote: 'approved fictional project brief' }, roots, 60, undefined, cwd);
  assert.equal(approved.status, 'quote found');
});

async function memoryFixture(t: TestContext, onInterpret?: () => Promise<void>) {
  const f = await fixture(t);
  const repo = join(f.folder, 'repo'); await mkdir(repo);
  const project = { id: randomUUID(), name: 'Fictional project', repoPath: repo, createdAt: 0, planAfterNotes: false };
  const memory = new Memory(f.store);
  const proposals = new Proposals(f.store, memory, { runner: null, directory: f.directory, clock: Date.now, notesFor: async () => null, projectOf: () => project.id });
  const inputs: string[] = [], logs: string[] = [];
  const files = new MemoryFiles(f.store, memory, proposals, { directory: f.directory, clock: Date.now, project: () => project, projects: () => [project], meetingTitle: () => 'Fictional meeting', guesser: null,
    log: message => logs.push(message), interpreter: async ({ inputPath }) => { inputs.push(await readFile(inputPath, 'utf8')); await onInterpret?.(); return { text: '{"results":[]}' }; } });
  f.cleanup.push(() => files.close());
  await files.sync(project.id);
  return { ...f, repo, project, memory, files, inputs, logs, memoryFolder: join(repo, 'project-memory') };
}

for (const unsafe of ['symlink', 'hardlink', 'oversized', 'directory'] as const) test(`memory inbox visibly refuses a ${unsafe} entry without reading it into a prompt`, async t => {
  const f = await memoryFixture(t);
  const outside = join(f.folder, 'outside.md'); await writeFile(outside, SENTINEL);
  const entry = join(f.memoryFolder, 'inbox', 'entry.md');
  if (unsafe === 'symlink') await symlink(outside, entry);
  else if (unsafe === 'hardlink') await link(outside, entry);
  else if (unsafe === 'directory') await mkdir(entry);
  else await writeFile(entry, SENTINEL + 'x'.repeat(1024 * 1024));
  const status = await f.files.sync(f.project.id);
  assert.equal(f.inputs.length, 0, 'unsafe contents never reach interpretation');
  assert.ok(status.error || f.logs.length, 'refusal must be visible in status or diagnostics');
  assert.equal(await readFile(outside, 'utf8'), SENTINEL);
});

for (const ancestor of ['project-memory', 'inbox'] as const) test(`memory sync refuses a symlinked ${ancestor} ancestor`, async t => {
  const f = await memoryFixture(t);
  const path = ancestor === 'project-memory' ? f.memoryFolder : join(f.memoryFolder, 'inbox');
  const moved = join(f.folder, 'outside-tree'); await rename(path, moved); await symlink(moved, path);
  await writeFile(join(ancestor === 'project-memory' ? join(moved, 'inbox') : moved, 'entry.md'), SENTINEL);
  const status = await f.files.sync(f.project.id);
  assert.equal(f.inputs.length, 0);
  assert.ok(status.error || f.logs.length);
});

for (const file of ['brief.md', 'todos.md'] as const) test(`outside memory edits cannot ingest a symlinked ${file}`, async t => {
  const f = await memoryFixture(t);
  const outside = join(f.folder, 'outside.md'); await writeFile(outside, file === 'brief.md' ? SENTINEL : `- ${SENTINEL}`);
  const path = join(f.memoryFolder, file); await rm(path); await symlink(outside, path);
  const status = await f.files.sync(f.project.id);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.memory.brief(f.project.id), null);
  assert.ok(status.error || f.logs.length);
});

test('inbox archival uses admitted bytes even if the entry is replaced with a symlink during interpretation', async t => {
  let swap = async () => {};
  const f = await memoryFixture(t, () => swap());
  const outside = join(f.folder, 'outside.md'); await writeFile(outside, SENTINEL);
  const entry = join(f.memoryFolder, 'inbox', 'entry.md');
  const admitted = 'A fictional maintenance note about inspecting a clean filter.';
  await writeFile(entry, admitted);
  swap = async () => { await rm(entry); await symlink(outside, entry); };
  await f.files.sync(f.project.id);
  const archive = join(f.directory, 'projects', f.project.id, 'inbox-read');
  const names = await readdir(archive);
  assert.equal(names.length, 1);
  assert.equal(await readFile(join(archive, names[0]), 'utf8'), admitted);
  assert.ok(f.logs.length);
});

test('plans report stale transcript input after corrections without changing historical evidence', async t => {
  const f = await fixture(t);
  const memory = new Memory(f.store), projects = new Projects(f.store, f.directory);
  const notes = new NotesJobs({ store: f.store, directory: f.directory, runner: null, clock: Date.now, glossaryFor: async () => null });
  const snapshot = await notes.snapshot(f.meeting.id);
  await notes.file(f.meeting.id).save({ meetingId: f.meeting.id, title: f.meeting.title, createdAt: Date.now(), model: 'fictional', input: { inputHash: snapshot.inputHash, coverage: snapshot.coverage, glossaryVersion: null, takenAt: snapshot.takenAt, segments: 1 }, sources: { [f.segment.id]: snapshot.segments[0] }, dropped: [], notes: { suggestedTitle: null, summary: [], decisions: [], actions: [], otherMatters: [], needsReview: [], otherTalk: [], openQuestions: [{ text: 'Which bound should be used tomorrow?', section: 'openQuestions', cites: [f.segment.id], quote: LINE, quoteIn: 'corrected', startMs: 0 }] } });
  const record = (await notes.file(f.meeting.id).load())!;
  const pins = await pinRun({ notes: record, project: null, memory, roots: [], stale: false });
  const input = buildPlanInput({ notes: record, roots: [] }); if ('refused' in input) assert.fail(input.refused);
  const checked = checkPlans({ plans: [{ label: 'Bound selection', question: 'Which bound should be used tomorrow?', from: ['N1'], stateNow: [{ id: 'k1', text: 'The sheriff bound was selected', source: { type: 'transcript', ref: 'S1', quote: LINE } }], answer: { text: 'Use the sheriff bound', complete: true, basis: ['k1'] }, next: { text: 'Apply the bound to the test', basis: ['k1'] } }], deferred: [] }, { run: 'fictional-run', refs: input.refs, evidence: { schema: 1, items: [], state: { items: 0, bytes: 0, cut: 0, dropped: 0, full: false, error: null } }, pins });
  const versions = new PlanVersions(f.directory);
  await versions.publish(f.meeting.id, plansDocument(checked, { kind: 'plan', base: null, createdAt: Date.now(), pins, finished: true, evidenceComplete: true }));
  const cooldowns = new Cooldowns(Date.now), explorations = new Explorations({ directory: f.directory, clock: Date.now, cooldowns });
  const pdfText = new PdfText(f.directory);
  f.cleanup.push(async () => { await explorations.close(); await pdfText.close(); await notes.close(); });
  const plans = new PlanJobs({ store: f.store, directory: f.directory, clock: Date.now, projects, memory, notes, versions, auto: new AutoPlanning(f.store, Date.now), enabled: true, cooldowns, explorations, todos: new PlanTodos(f.store, memory), pdfText, web: () => false, final: () => true, stale: async id => (await notes.status(id)).stale, changed: () => {} });
  const before = await plans.page(f.meeting.id);
  assert.equal(before.current!.plans[0].freshness.current, true);
  const evidence = structuredClone(before.current!.evidence);
  f.correct();
  assert.equal((await notes.status(f.meeting.id)).stale, true);
  const after = await plans.page(f.meeting.id);
  assert.equal(after.current!.plans[0].freshness.current, false, 'unchanged notes version cannot hide superseded transcript input');
  assert.ok(after.current!.warnings.includes('The transcript changed after the notes were written.'));
  assert.deepEqual(after.current!.evidence, evidence, 'historical checks remain immutable');
  assert.equal(after.current!.plans[0].answer!.check, 'checked');
});

for (const swap of ['symlink', 'replacement', 'parent-symlink'] as const) test(`citation refuses a ${swap} swapped in between authorization and reading`, async t => {
  const f = await fixture(t);
  const parent = join(f.material, 'chapter'); await mkdir(parent);
  const target = join(parent, 'source.txt'); await writeFile(target, 'An approved fictional source for this test.');
  const outside = join(f.folder, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'source.txt'), SENTINEL);
  const read = fs.readFile, open = fs.open;
  let swapped = false;
  const replace = async (path: unknown) => {
    if (swapped || String(path) !== target) return;
    swapped = true;
    if (swap === 'parent-symlink') {
      await rename(parent, join(f.material, 'held-chapter'));
      await symlink(outside, parent);
    } else {
      await rename(target, join(parent, 'held.txt'));
      if (swap === 'symlink') await symlink(join(outside, 'source.txt'), target);
      else await writeFile(target, SENTINEL);
    }
  };
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => { await replace(args[0]); return read(...args); });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { await replace(args[0]); return open(...args); });
  syncBuiltinESMExports();
  try {
    const checked = await checkFileSource({ id: 1, rootId: f.root.id, path: 'chapter/source.txt', lines: '1', quote: SENTINEL }, [f.root]);
    assert.equal(swapped, true, 'the race seam must run on the actual file-open/read path');
    assert.equal(checked.status, 'invalid');
    assert.equal(checked.excerpt, undefined);
    assert.equal(checked.citedText, undefined);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('memory publication refuses a parent symlink inserted after the final content check', async t => {
  const f = await memoryFixture(t);
  const outside = join(f.folder, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'brief.md'), 'An outside file that must not be replaced.');
  const held = join(f.folder, 'held-memory');
  f.memory.saveBrief(f.project.id, 'An updated fictional brief.', 'user', { kind: 'app' }, null);
  const prepare = f.store.db.prepare.bind(f.store.db);
  let swapped = false;
  t.mock.method(f.store.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT OR IGNORE INTO memory_files')) {
      const run = statement.run.bind(statement);
      t.mock.method(statement, 'run', (...args: Parameters<typeof statement.run>) => {
        if (!swapped && args[1] === 'brief.md') {
          swapped = true;
          renameSync(f.memoryFolder, held);
          symlinkSync(outside, f.memoryFolder);
          // An attacker can make the source basename exist through the substituted parent as well.
          const tmp = readdirSync(held).find(name => name.startsWith('brief.md.') && name.endsWith('.tmp'))!;
          assert.ok(tmp);
          renameSync(join(held, tmp), join(outside, tmp));
        }
        return run(...args);
      });
    }
    return statement;
  });
  try {
    const status = await f.files.sync(f.project.id);
    assert.equal(swapped, true);
    assert.equal(await readFile(join(outside, 'brief.md'), 'utf8'), 'An outside file that must not be replaced.');
    assert.ok(status.error);
  } finally { t.mock.restoreAll(); }
});

test('manual card investigation uses the first still-current occurrence shown on the card', async t => {
  const f = await fixture(t);
  const actions = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [], runner: async () => result('A scripted answer') });
  let calls = 0;
  const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, hasMaterials: () => false, actions,
    ask: async () => ({ ...result(JSON.stringify({ items: [{ type: 'question', text: 'Which bound should be used for the test?', cites: [++calls === 1 ? 'S1' : 'S2'], quote: calls === 1 ? 'Use the sheriff bound' : 'Use the Chernoff bound', confidence: 'high', materials: false, nonProject: false }] })), usages: [], attempts: 1 }) });
  f.cleanup.push(async () => { await boards.close(); await actions.close(); });
  await boards.requestScan(f.meeting.id);
  const chunk = await f.store.addPcm(f.meeting.id, 'mic:fictional', 1, 30000, 16000, Buffer.alloc(64000));
  f.store.completeChunk(chunk.id, { text: CORRECTED, words: [], backend: 'fictional', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
  await boards.requestScan(f.meeting.id);
  const cards = await boards.cards(f.meeting.id);
  assert.equal(cards.length, 1); assert.equal(cards[0].occurrences.length, 2);
  assert.deepEqual(await boards.selection(f.meeting.id, cards[0].id), { text: 'Use the sheriff bound', segmentIds: [f.segment.id], revisions: { [f.segment.id]: 0 } });
  const job = await boards.investigate(f.meeting.id, cards[0].id);
  assert.equal(job.context.selection.text, 'Use the sheriff bound');
  assert.deepEqual(job.context.selection.segmentIds, [f.segment.id]);
});

test('manual card investigation refuses revised evidence before starting an action', async t => {
  const f = await fixture(t);
  const actions = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [], runner: async () => result('A scripted answer') });
  const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, hasMaterials: () => false, actions,
    ask: async () => ({ ...result(JSON.stringify({ items: [{ type: 'question', text: 'Should the sheriff bound be used tomorrow?', cites: ['S1'], quote: 'Use the sheriff bound', confidence: 'high', materials: false, nonProject: false }] })), usages: [], attempts: 1 }) });
  f.cleanup.push(async () => { await boards.close(); await actions.close(); });
  await boards.requestScan(f.meeting.id);
  const [card] = await boards.cards(f.meeting.id); assert.ok(card);
  f.correct();
  await assert.rejects(boards.investigate(f.meeting.id, card.id), { status: 409 });
  assert.equal(actions.list(f.meeting.id).length, 0);
});

test('a current card selection cannot merge into an action captured at an older revision', async t => {
  const f = await fixture(t);
  const actions = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [], runner: async ({ signal }) => {
    await new Promise<never>((_resolve, reject) => {
      const stop = () => reject(new Error('cancelled'));
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
    return result('Unreachable');
  } });
  f.cleanup.push(() => actions.close());
  const selection = { text: 'the test tomorrow morning', segmentIds: [f.segment.id] };
  const first = await actions.submit(f.meeting.id, { action: 'other', origin: 'card', prompt: 'Explain the test', selection: { ...selection, revisions: { [f.segment.id]: 0 } } });
  f.correct();
  const second = await actions.submit(f.meeting.id, { action: 'other', origin: 'card', prompt: 'Explain the test', selection: { ...selection, revisions: { [f.segment.id]: 1 } } });
  assert.equal(second.merged, false, 'identical words at different revisions are different requests');
  assert.notEqual(first.job.id, second.job.id);
});

test('Ask about this and Look into it cannot bypass card revisions through the actions API', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'card-boundary-api-')));
  let calls = 0, corrected = false;
  const app = await startServer({ directory: folder, port: 0, recognizer: null, quick: null, heavy: null, notes: null, plans: null,
    actions: async () => { calls++; return result('A scripted answer'); },
    board: async () => ({ ...result(JSON.stringify({ items: [{ type: 'other', text: 'Which bound should be used tomorrow?', cites: ['S1'], quote: corrected ? 'Use the Chernoff bound' : 'Use the sheriff bound', confidence: 'high', materials: false, nonProject: true }] })), usages: [], attempts: 1 }) });
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${app.url}${path}`, { method,
    headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const meeting = app.store.createMeeting('Fictional bound choice');
  const chunk = await app.store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  app.store.completeChunk(chunk.id, { text: LINE, words: [], backend: 'fictional', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
  const segment = app.store.visibleSegments(meeting.id)[0];
  const base = `/api/meetings/${meeting.id}`;
  const scan = async () => {
    assert.equal((await call(`${base}/board/scan`, 'POST')).status, 202);
    for (let n = 0; n < 500; n++) {
      const board = await (await call(`${base}/board`)).json();
      if (!board.scanning && board.cards.length) return board.cards[0] as { id: string };
      await new Promise(r => setTimeout(r, 5));
    }
    assert.fail('Timed out waiting for the scripted Board');
  };
  const card = await scan();
  app.store.applyEdits(segment.id, segment.revision, CORRECTED, [{ start: 8, end: 22, from: 'sheriff bound', to: 'Chernoff bound' }]);
  const request = { action: 'other', cardId: card.id, prompt: 'Explain this choice', selection: { text: LINE, segmentIds: [segment.id] } };
  assert.equal((await call(`${base}/actions`, 'POST', request)).status, 409, 'old clients cannot silently rebase card evidence');
  assert.equal(calls, 0);
  corrected = true;
  assert.equal((await scan()).id, card.id, 'a current occurrence may merge into the existing card');
  const accepted = await call(`${base}/actions`, 'POST', request);
  assert.equal(accepted.status, 202);
  const { job } = await accepted.json();
  assert.equal(job.context.selection.text, 'Use the Chernoff bound', 'the server chooses the current occurrence');
  assert.equal(job.context.lines[0].revision, 1);
});
