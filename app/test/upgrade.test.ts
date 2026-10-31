import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';
import { databaseSnapshot } from '../scripts/upgrade-fixture-sql.ts';

const fixture = fileURLToPath(new URL('./fixtures/upgrade-v0.1.0/', import.meta.url));
// This oracle was saved by the old writers, not reconstructed with today's store.
const expected = JSON.parse(await readFile(join(fixture, 'expected.json'), 'utf8'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function files(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(directory, path));
    else { assert.ok(entry.isFile(), `No fixture symlinks: ${path}`); result[path] = digest(await readFile(join(directory, path))); }
  }
  return result;
}
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, value[key]]));

// Match land.test.ts's R3 exception for shared machine accounts, inspecting every text-fixture byte.
const GENERIC_ACCOUNTS = new Set(['runner', 'root', 'admin', 'user', 'ubuntu', 'ec2-user']);
test('the public v0.1.0 fixture contains no personal home identifiers in any file', async () => {
  const home = userInfo().homedir, account = basename(home);
  const forbidden = [['', 'Users', ''].join('/'), '-Users-', home, ...GENERIC_ACCOUNTS.has(account) ? [] : [account]];
  const leaks: string[] = [], paths = Object.keys(await files(fixture));
  assert.ok(paths.includes('meetings.sql') && paths.includes('audio.json'), 'scan the database dump and zero-audio manifest too');
  for (const path of paths) {
    assert.doesNotMatch(path, /\.(wav|f32|sqlite|db|m4a|mp3|mp4|webm|gguf|media)$/i, 'Public fixture must not contain recording or database binaries.');
    const bytes = await readFile(join(fixture, path));
    assert.ok(!bytes.includes(0), `${path}: public fixture must be text, not binary`);
    if (forbidden.some(value => bytes.includes(Buffer.from(value)))) leaks.push(path);
  }
  assert.deepEqual(leaks, [], 'fixture files must not contain personal home identifiers, even in flattened paths or SQL');
});

test('a v0.1.0 folder survives upgrade and a second start without losing saved data or retained audio', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-upgrade-'));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const sourceFiles = await files(fixture);
  await cp(fixture, directory, { recursive: true });
  // Reconstruction is the only direct SQLite inspection; all upgrade assertions below still use public HTTP.
  const db = new DatabaseSync(join(directory, 'meetings.sqlite'));
  try {
    db.exec(await readFile(join(directory, 'meetings.sql'), 'utf8'));
    assert.deepEqual(databaseSnapshot(db), expected.database, 'every rebuilt table (including empty ones), rowid, schema and version matches the v0.1.0 database');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { db.close(); }
  const audio = JSON.parse(await readFile(join(directory, 'audio.json'), 'utf8'));
  assert.equal(audio.format, 'float32 zeros');
  assert.equal(audio.sampleRate, 16000);
  assert.equal(audio.files.length, 5);
  const audioPaths = new Set<string>();
  for (const file of audio.files) {
    assert.match(file.path, /^audio\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.f32$/);
    assert.equal(file.bytes, 16000 * 4, 'one second of float32 zeros per recording');
    assert.ok(!audioPaths.has(file.path)); audioPaths.add(file.path);
    await mkdir(dirname(join(directory, file.path)), { recursive: true });
    await writeFile(join(directory, file.path), Buffer.alloc(file.bytes), { flag: 'wx' });
  }
  await rm(join(directory, 'meetings.sql'));
  await rm(join(directory, 'audio.json'));
  // Preserve every original *materialized* file, not the text transport files deliberately removed above.
  const original = await files(directory);
  const pi = await fakePi(t, { table: table([
    'fictional-atlas main 32K 4K no no', 'fictional-lark quick 32K 4K no no', 'ollama fictional-lantern:8b 32K 4K no no',
  ]) });
  for (const name of ['MEETING_HEAVY_MODEL', 'MEETING_QUICK_MODEL', 'MEETING_CORRECTION_MODEL']) delete pi.env[name];
  // Well beyond day/week/month expiry, but before the intentionally deferred retry.
  const now = Math.max(...expected.meetings.map((m: any) => m.createdAt)) + 366 * 86_400_000;
  let recognitions = 0;
  const overflowWarnings: string[] = [];
  const warning = (error: Error) => { if (error.name === 'TimeoutOverflowWarning') overflowWarnings.push(error.message); };
  process.on('warning', warning);
  t.after(() => process.off('warning', warning));
  const snapshots: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    app = await startServer({ directory, port: 0, clock: () => now, quick: null, heavy: null, notes: null, actions: null, board: null, plans: null, drafts: null,
      recognizer: { async transcribe() { recognitions++; throw new Error('Upgrade must not retranscribe saved or deferred work.'); }, close() {} },
      ai: { env: pi.env }, setup: { scan: { home: directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: false }) } });
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, options: RequestInit = {}) => fetch(app!.url + path, {
      ...options, headers: { Cookie: cookie, Origin: app!.url, 'Content-Type': 'application/json', ...options.headers },
    });
    const json = async (path: string) => {
      const response = await request(path);
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      return response.json();
    };
    // Startup retention is async. Wait for its eligible completed meeting to be observed, using HTTP only.
    const solo = expected.meetings.find((m: any) => m.projectId === null);
    await until(async () => (await json(`/api/meetings/${solo.id}`)).meeting.audioDoneAt !== null);
    const settings = await json('/api/settings');
    assert.deepEqual(pick(settings, Object.keys(expected.settings)), expected.settings, 'every saved v0.1.0 setting');
    assert.equal(settings.autoAnswers, true, 'new setting absent from v0.1.0 gets its default');
    const status = await json('/api/status');
    assert.equal(status.queued, 1, 'the deferred retry is not discarded or run early');
    assert.equal(status.audioRetentionNotice, null, 'Always needs no deletion consent prompt');
    assert.deepEqual(status.meetings.map((m: any) => m.id).sort(), expected.meetings.map((m: any) => m.id).sort());
    const projects = (await json('/api/projects')).projects;
    assert.deepEqual(projects, [{ ...expected.project, meetings: 1, hasGlossary: true }]);
    const snapshot: Record<string, unknown> = { settings: pick(settings, Object.keys(expected.settings)), projects };
    for (const meeting of expected.meetings) {
      const base = `/api/meetings/${meeting.id}`;
      const detail = await json(base);
      // Retention may populate its completion clock; everything the user saved must be unchanged.
      const { audioDoneAt: _done, ...savedMeeting } = meeting;
      assert.deepEqual(pick(detail.meeting, Object.keys(savedMeeting)), savedMeeting);
      assert.equal(detail.meeting.audioRemovedAt, null);
      assert.equal(detail.meeting.audioEmpty, 0);
      assert.equal(detail.project?.id ?? null, meeting.projectId);
      assert.deepEqual(detail.materials, expected.materials[meeting.id], 'material ids, scopes, labels, kinds and original external paths');
      assert.deepEqual(detail.sourceSettings, expected.sourceSettings[meeting.id]);
      const chunks = expected.chunks[meeting.id].map(({ path: _path, hash: _hash, ...chunk }: any) => chunk);
      assert.deepEqual(detail.chunks, chunks, 'chunk states, attempts, retry times, results and metrics');
      const segments = await json(`${base}/segments`);
      assert.deepEqual(segments.segments, expected.segments[meeting.id].map((s: any) => ({
        ...pick(s, ['id', 'startMs', 'endMs', 'text', 'originalText', 'revision', 'timing']), edits: JSON.parse(s.edits),
      })), 'raw/corrected text, exact edit spans, revisions and timings');
      assert.deepEqual((await json(`${base}/glossary`)).glossary, expected.glossaries[meeting.id]);
      const notes = (await json(`${base}/notes`)).notes;
      const savedNotes = expected.notes.find((n: any) => n.meetingId === meeting.id);
      assert.equal(notes.version, 2, 'the old writer saved twice; latest note version survives');
      assert.deepEqual(notes, savedNotes, 'all note sections, sources, input pins and coverage');
      const exported = await request(`${base}/notes.md?version=2`);
      assert.equal(exported.status, 200);
      assert.ok((await exported.text()).includes(savedNotes.notes.summary[0].text));
      for (const [mode, key] of [['corrected', 'text'], ['raw', 'originalText']]) {
        const response = await request(`${base}/transcript.md?mode=${mode}`);
        assert.equal(response.status, 200);
        const text = await response.text();
        for (const s of expected.segments[meeting.id]) assert.ok(text.includes(s[key]), `${mode} export includes ${s.id}`);
      }
      const seconds = Math.max(...chunks.map((c: any) => c.startMs / 1000 + c.seconds));
      assert.deepEqual(await json(`${base}/audio?metadata=1`), { seconds });
      const audio = await request(`${base}/audio`);
      assert.equal(audio.status, 200, 'Always must retain playable audio despite its age');
      const wav = Buffer.from(await audio.arrayBuffer());
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.length, 44 + seconds * 16000 * 2);
      assert.ok(wav.subarray(44).every(byte => byte === 0), 'the fictional silence is intact');
      snapshot[meeting.id] = { meeting: detail.meeting, chunks: detail.chunks, materials: detail.materials, sourceSettings: detail.sourceSettings,
        segments: segments.segments, glossary: (await json(`${base}/glossary`)).glossary, notes, audio: digest(wav) };
    }
    const base = `/api/meetings/${expected.board.meetingId}`;
    const board = await json(`${base}/board`);
    const cards = expected.board.cards.map((card: any) => ({ ...card,
      ...(card.auto ? { auto: { ...card.auto, state: 'uncertain' }, attempts: expected.actions.filter((j: any) => j.cardId === card.id).map((j: any) => j.id) } : {}),
    }));
    assert.deepEqual(board.cards, cards, 'reservation becomes uncertain without losing its key, card, quotes or linked attempts');
    assert.equal(board.autoUsed, expected.board.autoUsed, 'a crashed reservation still consumes its slot');
    assert.equal(board.preset, expected.board.preset);
    assert.equal(board.lastScanAt, expected.board.lastScanAt);
    assert.equal(board.backlog, 0);
    assert.deepEqual((await json(`${base}/actions`)).jobs, expected.actions, 'saved answer job and frozen context');
    const page = await json(`${base}/plans`);
    const savedPlan = expected.plans.plans[0], plan = page.current.plans[0];
    assert.equal(page.current.version, expected.plans.version);
    assert.equal(page.current.run, expected.plans.run);
    assert.deepEqual(page.current.evidence, expected.plans.evidence);
    assert.equal(page.current.plans.length, 1);
    assert.deepEqual(pick(plan, ['id', 'label', 'answerLine', 'stepLine', 'question', 'from', 'fromItems', 'owner', 'answer', 'waitingOn', 'decideAfter', 'changeIf', 'further', 'review']),
      pick(savedPlan, ['id', 'label', 'answerLine', 'stepLine', 'question', 'from', 'fromItems', 'owner', 'answer', 'waitingOn', 'decideAfter', 'changeIf', 'further', 'review']));
    assert.deepEqual(plan.steps.map(({ todo: _todo, ...step }: any) => step), savedPlan.steps);
    assert.deepEqual(plan.steps[0].todo, { state: 'in to-dos', generation: 1, todo: 'T-2', project: expected.project.id });
    const runs = await json(`${base}/plans/runs?opId=fictional-plan-op`);
    assert.equal(runs.run.id, expected.runs[0].id);
    assert.equal(runs.run.state, 'done');
    assert.equal(runs.run.outcome, 'published');
    const memory = await json(`/api/projects/${expected.project.id}/memory`);
    assert.deepEqual(memory.items, expected.memory, 'every memory item including the sourced plan to-do');
    assert.deepEqual(memory.brief, expected.brief);
    for (const item of expected.memory) {
      const detail = await json(`/api/projects/${expected.project.id}/memory/items/${item.id}`);
      assert.deepEqual(detail.item, item);
      assert.deepEqual(detail.timeline, expected.timelines[item.id], 'event history and original sources');
    }
    assert.deepEqual(await json(`/api/projects/${expected.project.id}/brief`), { brief: expected.brief, versions: expected.briefVersions });
    Object.assign(snapshot, { cards: board.cards, autoUsed: board.autoUsed, plans: page.current, runs, memory: memory.items, brief: memory.brief });
    snapshots.push(snapshot);
    assert.deepEqual(overflowWarnings, [], 'opening a deferred retry must not overflow timers into a 1 ms wake loop');
    if (pass === 1) {
      assert.deepEqual(snapshots[1], snapshots[0], 'opening the same folder twice is idempotent through the API');
      // There is no public GET for frame rows. A repeat of the original frame must return its old identity,
      // not write/retranscribe it. This probes persistence through public HTTP after both opens.
      const frame = expected.frame;
      const response = await request(`/api/meetings/${frame.meetingId}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: {
        'X-Audio-Source': frame.source, 'X-Sequence': String(frame.sequence), 'X-Start-Ms': String(frame.startMs), 'X-Sample-Rate': '16000',
      } });
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal((await response.json()).id, frame.id, 'the old sealed frame row is still there');
    }
    await app.close(); app = undefined;
    const after = await files(directory);
    for (const [path, hash] of Object.entries(original)) {
      assert.ok(path in after, `Upgrade/start/stop must not delete ${path}`);
      if (path !== 'meetings.sqlite') assert.equal(after[path], hash, `Saved file changed unexpectedly: ${path}`);
    }
  }
  assert.equal(recognitions, 0, 'no saved transcript, failure or deferred retry was resubmitted');
  assert.deepEqual(await files(fixture), sourceFiles, 'the committed text fixture itself is never opened writable');
});
