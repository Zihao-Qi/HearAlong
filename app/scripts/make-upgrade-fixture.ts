// Run from app with an explicit, disposable v0.1.0 checkout and a NEW output directory.
// All application imports below resolve in that checkout, never in the current app.
import './check-isolation.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Recognition } from '../src/recognizer.ts';
import { databaseSnapshot, dumpDatabase } from './upgrade-fixture-sql.ts';

const COMMIT = '570b8032418cbbfc01a20cc0f64257135cd6c5ef';
const [checkoutArg, outputArg] = process.argv.slice(2);
assert.ok(checkoutArg && outputArg, 'Usage: node --experimental-strip-types scripts/make-upgrade-fixture.ts V0_CHECKOUT NEW_OUTPUT');
const checkout = await realpath(checkoutArg), output = resolve(outputArg);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), COMMIT);
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout, encoding: 'utf8' }).trim(), '', 'Old writers must be unmodified.');
for (const path of [checkout, output]) {
  assert.doesNotMatch(path, /(?:^|\/)app\/data(?:\/|$)/);
  assert.ok(!path.includes('/Library/Application Support/HearAlong/'), 'Installed data is off limits.');
}
// Never derive public fixture paths from a checkout, home or scratch folder.
const assetsPath = '/private/tmp/hearalong-upgrade-v0.1.0-assets';
await mkdir(output); // Never overwrite an existing fixture or user data.
await mkdir(assetsPath); // Refuse any pre-existing file, directory or symlink here.
const assets = await realpath(assetsPath);
await mkdir(join(assets, 'repo'));
await writeFile(join(assets, 'repo', 'README.md'), '# Fictional lantern club\nNo real meetings or repository content.\n');
await writeFile(join(assets, 'lantern-handbook.md'), 'The fictional lantern club stores paper stars in the blue cupboard.\n');
const old = (path: string) => import(pathToFileURL(join(checkout, 'app', path)).href);
const { startServer } = await old('src/server.ts') as typeof import('../src/server.ts');
const { MeetingStore } = await old('src/store.ts') as typeof import('../src/store.ts');
const { Projects, projectScope, meetingScope } = await old('src/projects.ts') as typeof import('../src/projects.ts');
const { Memory } = await old('src/memory.ts') as typeof import('../src/memory.ts');
const { NotesFile, takeSnapshot, validateNotes, sourcesFor } = await old('src/notes.ts') as typeof import('../src/notes.ts');
const { Boards, scanWindow } = await old('src/board.ts') as typeof import('../src/board.ts');
const { ActionJobs } = await old('src/actions.ts') as typeof import('../src/actions.ts');
const { Explorations } = await old('src/explorations.ts') as typeof import('../src/explorations.ts');
const { Cooldowns } = await old('src/quota.ts') as typeof import('../src/quota.ts');
const plans = await old('src/plans/index.ts') as typeof import('../src/plans/index.ts');
const { fakePi, table, until } = await old('test/helpers/setup-pi.ts') as typeof import('../test/helpers/setup-pi.ts');
let removePi: (() => unknown) | undefined;
const pi = await fakePi({ after: fn => { removePi = fn; } }, { table: table([
  'fictional-atlas main 32K 4K no no', 'fictional-lark quick 32K 4K no no', 'ollama fictional-lantern:8b 32K 4K no no',
]) });
for (const key of ['MEETING_HEAVY_MODEL', 'MEETING_QUICK_MODEL', 'MEETING_CORRECTION_MODEL']) delete pi.env[key];
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let store: InstanceType<typeof MeetingStore> | undefined;
try {
  server = await startServer({ directory: output, port: 0, recognizer: null, drafts: null, quick: null, heavy: null,
    notes: null, actions: null, board: null, plans: null, ai: { env: pi.env },
    setup: { scan: { home: pi.directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: false }) } });
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const request = async (path: string, method = 'GET', value?: object) => {
    const response = await fetch(server!.url + path, { method, headers: { Cookie: cookie, Origin: server!.url, 'Content-Type': 'application/json' },
      ...(value ? { body: JSON.stringify(value) } : {}) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  await request('/api/setup/ai/models');
  await request('/api/setup/ai', 'PUT', { mode: 'local', main: 'ollama/fictional-lantern:8b', quick: 'ollama/fictional-lantern:8b' });
  await request('/api/setup/ai', 'PUT', { mode: 'cloud', main: 'fictional-atlas/main', quick: 'fictional-lark/quick', consent: true });
  await request('/api/settings', 'PUT', { boardModel: 'main', miniOpensItself: true, audioRetention: 'always', setupSeen: true });
  await server.close(); server = undefined;
  const settings = JSON.parse(await readFile(join(output, 'settings.json'), 'utf8'));

  store = new MeetingStore(output);
  const projects = new Projects(store, output), memory = new Memory(store);
  const project = await projects.create('Fictional lantern club', join(assets, 'repo'));
  await projects.update(project.id, { planAfterNotes: true });
  const meeting = store.createMeeting('Fictional lantern inventory'), solo = store.createMeeting('Fictional kite rehearsal');
  store.updateMode(meeting.id, 'manual', 90);
  store.updateMode(solo.id, 'questions', 120);
  projects.move(meeting.id, project.id, []);
  const root = await projects.addRoot(projectScope(project.id), join(assets, 'lantern-handbook.md'));
  const extraRoot = await projects.addRoot(meetingScope(solo.id), join(assets, 'repo'));
  const glossary = projects.saveGlossary(projectScope(project.id), [{ term: 'Asterbeam', spokenVariants: ['aster been'] }], 'user');
  const soloGlossary = projects.saveGlossary(meetingScope(solo.id), [{ term: 'Kitewheel', spokenVariants: ['kite wheel'] }], 'generated', 'fictional-atlas/main');
  const silence = Buffer.alloc(16000 * 4);
  const recognition = (text: string): Recognition => ({ text, backend: 'fictional', computeMs: 1, decodeMs: 1, audioSeconds: 1,
    processRssBytes: 0, words: [], timestampKind: 'none', retries: 0 });
  const raw = 'Must the club store aster been paper stars in the blue cupboard?';
  const corrected = 'Must the club store Asterbeam paper stars in the blue cupboard?';
  const completed = await store.addPcm(meeting.id, `mic:${randomUUID()}`, 0, 0, 16000, silence);
  store.startChunk(completed.id); store.completeChunk(completed.id, recognition(raw));
  const segment = store.segments(meeting.id)[0];
  const start = raw.indexOf('aster been');
  assert.equal(store.applyEdits(segment.id, 0, corrected, [{ start, end: start + 'aster been'.length, from: 'aster been', to: 'Asterbeam' }]), true);
  store.markCorrectionChecked([segment.id], glossary.version);
  const failed = await store.addPcm(meeting.id, completed.source, 1, 1000, 16000, silence);
  for (let i = 0; i < 3; i++) { store.startChunk(failed.id); store.failChunk(failed.id, 'Fictional decoder failure.', null); }
  const cancelled = await store.addPcm(meeting.id, completed.source, 2, 2000, 16000, silence);
  store.setStatus(cancelled.id, 'cancelled', '', 'Fictional cancellation.');
  const queued = await store.addPcm(meeting.id, completed.source, 3, 3000, 16000, silence);
  store.startChunk(queued.id); store.failChunk(queued.id, 'Fictional retry scheduled.', 4_000_000_000_000);
  const source = `mic:${randomUUID()}`;
  const { frame } = await store.addFrame(solo.id, source, 0, 0, silence, { captureWallMs: 1_700_000_000_000 });
  const sealed = await store.sealWindow(solo.id, [frame]);
  store.startChunk(sealed.id); store.completeChunk(sealed.id, recognition('Mira will fold the fictional kite after the rehearsal.'));
  const sourceSettings = { kind: 'mic', label: 'Fictional microphone', echoCancellation: false, roomMode: true };
  store.setSourceSettings(solo.id, source, sourceSettings);
  store.recordingEnded(meeting.id); store.recordingEnded(solo.id);
  memory.apply(project.id, { requestId: 'fictional-seed-memory', actor: 'user', changes: [
    { op: 'create', type: 'todo', text: 'Count the paper stars', owner: 'Mira', fields: { due: '2030-02-03' }, confirmed: true, source: { kind: 'meeting', meetingId: meeting.id } },
    { op: 'create', type: 'decision', text: 'Use the blue cupboard', confirmed: true, source: { kind: 'app' } },
    { op: 'create', type: 'question', text: 'Which shelf holds the spare lantern?', source: { kind: 'chat', text: 'Fictional planning question.' } },
  ] });
  memory.apply(project.id, { requestId: 'fictional-complete-memory', actor: 'user', changes: [{ op: 'status', item: 'T-1', to: 'done', source: { kind: 'app' } }] });
  memory.saveBrief(project.id, 'Fictional club inventory before rehearsal.', 'user', { kind: 'app' }, null);
  memory.saveBrief(project.id, 'Fictional club: use the blue cupboard after counting stars.', 'user', { kind: 'app' }, 1);

  const noteRecords = [];
  for (const m of [meeting, solo]) {
    const snap = takeSnapshot(store, m.id, Date.now(), projects.glossaryFor(m.id));
    const line = snap.segments[0];
    const checked = validateNotes({ title: m.title, summary: [{ text: line.text, cites: [line.ref], quote: line.text }],
      decisions: [], actions: [], openQuestions: [], otherMatters: [], otherTalk: [] }, snap);
    assert.equal(checked.notes.summary.length, 1);
    const file = new NotesFile(join(output, 'notes', `${m.id}.json`));
    const record = { meetingId: m.id, title: m.title, createdAt: Date.now(), model: 'fictional-atlas/main',
      input: { inputHash: snap.inputHash, coverage: snap.coverage, glossaryVersion: snap.glossaryVersion, segments: snap.segments.length, takenAt: snap.takenAt },
      notes: checked.notes, sources: sourcesFor(checked.notes, snap), dropped: checked.dropped };
    await file.save(record);
    noteRecords.push(await file.save({ ...record, title: `${m.title} — revised notes` }));
  }

  // Capture the exact durable reservation before submit/link, as a crash at that point would leave it.
  const boardPath = join(output, 'board', `${meeting.id}.json`), reservedPath = join(assets, 'reserved-board.json');
  const actions = new ActionJobs({ store, directory: output, clock: Date.now, glossaryFor: async id => projects.glossaryFor(id), rootsFor: id => projects.rootsFor(id),
    runner: async () => { throw new Error('Fictional answer service unavailable.'); } });
  const submit = actions.submit.bind(actions);
  actions.submit = async (...args) => { await copyFile(boardPath, reservedPath); return submit(...args); };
  const window = scanWindow(store.segments(meeting.id), {})!;
  const boards = new Boards({ store, directory: output, clock: Date.now, glossaryFor: async id => projects.glossaryFor(id), hasMaterials: () => true, actions,
    ask: async () => ({ text: JSON.stringify({ items: [
      { type: 'question', text: 'Must Asterbeam stars stay in the blue cupboard?', cites: [window.lines[0].ref], quote: corrected, confidence: 'high', materials: true, nonProject: false },
      { type: 'decision', text: 'Discuss the fictional cupboard location', cites: [window.lines[0].ref], quote: corrected, confidence: 'medium', materials: false, nonProject: false },
    ] }), ms: 1, attempts: 1, stopReason: 'stop', aborted: false, usages: [] }) });
  await boards.setPreset(meeting.id, 'lecture');
  await boards.requestScan(meeting.id);
  assert.equal((await boards.status(meeting.id)).cards.length, 2);
  await until(() => actions.list(meeting.id).every(j => j.state === 'failed'));
  await boards.close(); await actions.close();
  await copyFile(reservedPath, boardPath);
  const board = JSON.parse(await readFile(boardPath, 'utf8'));
  assert.equal(board.cards[0].auto.state, 'reserved');

  const versions = new plans.PlanVersions(output), todos = new plans.PlanTodos(store, memory);
  const notes = noteRecords[0];
  const input = plans.buildPlanInput({ notes, roots: plans.planRoots(projects.rootsFor(meeting.id)) });
  assert.ok(!('refused' in input));
  const pins = await plans.pinRun({ notes, memory, project: project.id, roots: input.refs.roots });
  const explorations = new Explorations({ directory: output, clock: Date.now, cooldowns: new Cooldowns(Date.now) });
  const run = await explorations.submit(meeting.id, { kind: 'plan', data: { origin: 'manual', opId: 'fictional-plan-op', base: null, plan: null, notesVersion: notes.version },
    work: async ctx => {
      ctx.log.appendText('Fictional cupboard plan saved by the v0.1.0 writers.');
      const evidence = new plans.EvidenceRecorder(ctx.folder, { cwd: ctx.cwd, locate: plans.materialLocator({ roots: input.refs.roots }) });
      const checked = plans.checkPlans({ plans: [{ label: 'Paper star storage', answerLine: null, stepLine: 'Label the blue cupboard', question: 'Where should the paper stars go?', from: ['N1', 'S1'], owner: null,
        stateNow: [{ id: 'k1', text: 'The meeting asks about the blue cupboard', source: { type: 'transcript', ref: 'S1', quote: corrected } }], answer: null,
        next: { text: 'Label the blue cupboard for paper stars', basis: ['k1'] }, followOn: [], changeIf: 'The cupboard is full', checks: [], waitingOn: [], decideAfter: [], further: null }], deferred: [] },
      { run: ctx.job.id, refs: input.refs, evidence: await evidence.read(), pins });
      assert.equal(checked.plans.length, 1);
      const doc = plans.plansDocument(checked, { kind: 'plan', base: null, createdAt: Date.now(), pins, finished: true, evidenceComplete: true });
      await plans.saveRunPlans(ctx.folder, doc);
      const published = await versions.publish(meeting.id, doc, ctx.commit);
      assert.ok('published' in published);
      return { outcome: 'published', version: published.published.version };
    } });
  await until(() => !explorations.busy(meeting.id));
  assert.equal(explorations.get(run.id)!.state, 'done', explorations.get(run.id)!.error ?? '');
  await explorations.close();
  const published = (await versions.latest(meeting.id))!;
  assert.equal(published.plans[0].steps[0].check, 'checked');
  todos.accept(published, published.plans[0].steps[0].id, { opId: 'fictional-add-plan-todo', expect: 0, project: project.id });

  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const expected = { commit: COMMIT, database: databaseSnapshot(store.db), settings, project: projects.get(project.id), meetings: store.meetings(),
    chunks: Object.fromEntries([meeting, solo].map(m => [m.id, store!.chunks(m.id)])), segments: Object.fromEntries([meeting, solo].map(m => [m.id, store!.segments(m.id)])),
    materials: { [meeting.id]: [root], [solo.id]: [extraRoot] }, glossaries: { [meeting.id]: glossary, [solo.id]: soloGlossary },
    sourceSettings: { [meeting.id]: {}, [solo.id]: { [source]: sourceSettings } }, frame, notes: noteRecords, board,
    actions: actions.list(meeting.id), plans: published, runs: explorations.list(meeting.id),
    memory: memory.items(project.id), timelines: Object.fromEntries(memory.items(project.id).map(i => [i.id, memory.timeline(project.id, i.id)])),
    brief: memory.brief(project.id), briefVersions: memory.briefVersions(project.id) };
  await writeFile(join(output, 'meetings.sql'), dumpDatabase(store.db));
  store.close(); store = undefined;
  await rm(join(output, 'meetings.sqlite'));
  for (const suffix of ['-wal', '-shm']) await rm(join(output, `meetings.sqlite${suffix}`), { force: true });
  const audio: { format: string; sampleRate: number; files: { path: string; bytes: number }[] } = {
    format: 'float32 zeros', sampleRate: 16000, files: [],
  };
  for (const meetingId of (await readdir(join(output, 'audio'))).sort()) {
    for (const name of (await readdir(join(output, 'audio', meetingId))).sort()) {
      const path = join('audio', meetingId, name), bytes = await readFile(join(output, path));
      assert.match(path, /^audio\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.f32$/);
      assert.ok(bytes.length > 0 && bytes.length % 4 === 0 && bytes.every(byte => byte === 0), 'Only float32 silence can use the zero manifest.');
      audio.files.push({ path, bytes: bytes.length });
    }
  }
  await writeFile(join(output, 'audio.json'), JSON.stringify(audio, null, 2) + '\n');
  await rm(join(output, 'audio'), { recursive: true });
  await cp(assets, join(output, 'fictional-assets'), { recursive: true, filter: path => !path.endsWith('reserved-board.json') });
  await writeFile(join(output, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  await writeFile(join(output, 'README.md'), `# v0.1.0 upgrade fixture\n\nGenerated by app/scripts/make-upgrade-fixture.ts using **v0.1.0**, commit\n\`${COMMIT}\` (the annotated tag points to this commit). Fictional text and one-second\n16 kHz float32 silence buffers only. No real data, credentials, models, or network AI.\nThe public fixture is text-only: meetings.sql contains the schema and all rows;\naudio.json describes the relative paths and byte lengths of zero-filled float32\naudio. No database/recording binaries or base64 audio are stored in Git.\n\nFrom app/, with dependencies linked in both checkouts:\n\n\`\`\`sh\nnice -n 19 env -u GEMINI_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY node --experimental-strip-types scripts/make-upgrade-fixture.ts /path/to/disposable-v0.1.0 /path/to/NEW-upgrade-v0.1.0\n\`\`\`\n\nThe generator refuses another commit, modified tracked old code, or an existing output.\nFictional external assets are created only at the fixed neutral absolute path\n/private/tmp/hearalong-upgrade-v0.1.0-assets, never under a checkout, home or scratch\nfolder. The generator refuses to run if that path already exists, resolves its\nreal path before calling the old writers, and removes the assets on completion.\nThe privacy test scans every fixture file as bytes, including meetings.sql and\naudio.json, and rejects binary recording/database extensions.\nIt uses the old server's settings/AI-save APIs, MeetingStore, Projects, Memory,\nNotesFile/validator, Boards/scanner, ActionJobs, Explorations, plan checker,\nPlanVersions and PlanTodos. No hand-written SQL data. After the WAL checkpoint,\nupgrade-fixture-sql.ts reads the old database with the same node:sqlite library\nas the app (no sqlite3 CLI or new package). It emits schema in kind/name order\nand rows in original rowid order, retaining rowids, user_version and application_id.\nexpected.json records every table's row count and SHA-256 of its SQL-quoted column\nvalues/rowids, plus the schema. The dump is deterministic for the same database;\nfresh generation still gets the old writers' new UUIDs and timestamps.\n\nAt test time only, the fixture is copied to a disposable folder, node:sqlite\nrebuilds meetings.sqlite and Buffer.alloc recreates the five silent recordings.\nBefore starting the app, the test compares every rebuilt table and schema against\nthe old-writer snapshot in expected.json. It removes meetings.sql and audio.json\nfrom that copy, then takes the file-preservation baseline of the materialized\nfolder. Upgrade data assertions remain HTTP-only. expected.json is the old-writer\nHTTP oracle as well, not a current-code-generated snapshot.\n\nCoverage: two meetings (one in a project), modes/intervals, repo and material paths,\nproject and meeting glossaries, completed/failed/cancelled/deferred-retry chunks,\nretry attempts, corrected/raw text and edit spans, a sealed frame and capture\nsettings, latest notes at version 2, two cards including an interrupted auto\nreservation, a failed answer, a published plan/run and accepted plan to-do,\nthree memory item types, event timelines, two brief versions, non-default\nsettings, local/cloud model choices and fictional-provider consent.\n\nThe reserved board is a byte-for-byte snapshot of the old writer at its durable\nreserve-before-submit boundary, restored after the fake answer finishes. On open\nit must become uncertain, not be automatically resubmitted.\n\nLimits of the release: NotesFile overwrites earlier note bodies (only v2 survives);\nsealed frame bytes are removed by sealWindow (its row survives and duplicate\nHTTP frame admission checks its identity). Materials and repo paths are absolute\nexternal references, not copied attachments: their original fictional files are\nin fictional-assets for inspection, but their recorded paths intentionally no\nlonger exist once the generator removes the fixed neutral external-assets folder. The test checks that\nthose references are unchanged; it does not invent relocation of external files.\nv0.1.0 already writes SQLite materials/glossaries and quick/main board settings;\nit has no autoAnswers setting and cannot naturally produce pre-project materials.json/glossaries .migrated files\nor luna/sol board choices, or missing columns it already creates. Those older\nformats are not fabricated into this release fixture.\n`);
  console.log(`Generated ${output} from ${COMMIT}`);
} finally {
  await server?.close(); store?.close(); await removePi?.();
  await rm(assets, { recursive: true, force: true });
}
