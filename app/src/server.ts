import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { numberInRange } from './config.ts';
import { dataDirectory, LEGACY_DATA_NOTICE } from './data-directory.ts';
import { sessionToken } from './session-token.ts';
import { CaptureConflict } from './capture-error.ts';
import { downloadDisposition } from './download.ts';
import { CodeFingerprint, type FingerprintOptions } from './update-guard.ts';
import { SpeechSetup, type SetupOptions } from './setup/service.ts';
import { AiSetup } from './setup/ai.ts';
import type { ModeSettings } from './setup/ai-settings.ts';
import { isKeyProvider, RECOMMENDED_LOCAL_MODEL, resolvePi, setPiAdmission, stopPiRuns, type KeyProvider } from './pi-command.ts';
import { ApiKeys, Keychain } from './setup/api-keys.ts';
import { probeDuration, CHUNK_SECONDS } from './audio.ts';
import { serveMeetingAudio } from './listen.ts';
import { AudioRetention, isAudioRetention, type AudioRetentionSetting } from './audio-retention.ts';
import { MeetingStore, type Mode } from './store.ts';
import { finishPendingMeetingDeletions } from './delete-meeting.ts';
import { SwitchableRecognizer } from './setup/switchable-recognizer.ts';
import { JobManager, type Recognizer } from './jobs.ts';
import { LiveDrafts, ownsDisplayInterval, type Draft } from './drafts.ts';
import { miniPreviewWords, miniLog, midpoint } from '../public/preview-composition.js';
import { LiveCapture } from './live.ts';
import { captureDiscontinuities } from './capture-gaps.ts';
import { LiveView, type MiniAction } from './live-view.ts';
import { ROLE_LABEL, compareSegments } from './speakers.ts';
import { SegmentsTag } from './segments-tag.ts';
import { searchRoots } from './materials.ts';
import { PdfText } from './pdf-text.ts';
import { Projects, meetingScope, projectScope } from './projects.ts';
import { Memory, transaction, type Change } from './memory.ts';
import { Proposals } from './proposals.ts';
import { MemoryFiles, recentCommits, render as renderMemory } from './memory-files.ts';
import { ModelRpc } from './pi-rpc.ts';
import { runPiTask, extractJson } from './pi-task.ts';
import { CORRECTION_SYSTEM_PROMPT, Corrector, cleanGlossary, glossaryPrompt } from './correction.ts';
import { NotesJobs, notesMarkdown, piNotesRunner, type NotesRunner } from './notes.ts';
import { ActionJobs, piActionRunner, type ActionRunner } from './actions.ts';
import { Boards, type GateAsk } from './board.ts';
import { Cooldowns } from './quota.ts';
import { Explorations, recoverExplorations } from './explorations.ts';
import { AutoPlanning, PlanTodos, PlanVersions } from './plans/index.ts';
import { PlanJobs, planModel } from './plans/jobs.ts';
import { endLeftoverProcesses } from '../pi-extensions/process-groups.ts';

type Quick = { ask(prompt: string): Promise<{ text: string }>; close?(): Promise<void> };
type Heavy = (prompt: string, options: { cwd: string; readRoots: string[]; sessionDir: string; signal: AbortSignal }) => Promise<{ text: string; provider?: string; model?: string }>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[a-f0-9-]{36}$/;
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
async function body(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage) {
  try { return JSON.parse((await body(req, 16_384)).toString()); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Provide valid JSON.'); }
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function lock(directory: string) {
  const path = join(directory, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('The data-directory lock is invalid; inspect server.lock before removing it.');
      try { process.kill(pid, 0); }
      catch (killError) {
        if ((killError as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path); continue; }
        throw killError;
      }
      throw new Error(`Another process (${pid}) owns this data directory. Stop it first.`);
    }
  }
  throw new Error('Could not acquire the data-directory lock.');
}

export async function startServer(options: {
  directory?: string; port?: number; recognizer?: Recognizer | null;
  /** Bounded discovery and injectable OS/network boundaries for setup tests. */
  setup?: SetupOptions;
  ai?: Omit<AiSetup['options'], 'cwd' | 'cloud' | 'keysReady'>;
  /** The Keychain and the provider check behind saved API keys (tests give stand-ins; MEETING_SECURITY also replaces the tool). */
  keys?: { keychain?: Keychain; fetch?: typeof fetch };
  /** Live draft transcription; by default on with the local model, off when a test recognizer is injected. */
  drafts?: LiveDrafts | null;
  /** Cloud model access through Pi; null disables it (MEETING_CLOUD=0 does the same). */
  quick?: Quick | null; heavy?: Heavy | null; notes?: NotesRunner | null; actions?: ActionRunner | null; board?: GateAsk | null; clock?: () => number; correctionTickMs?: number;
  /** Pi for the plans (M7b): tests give a stand-in with runPiTask's shape; null turns making plans off (saved ones stay). */
  plans?: typeof runPiTask | null;
  /**
   * The installed app (M7): `onIdle` is called once no page has been open for `idleMs` (a closed window says goodbye at once) and
   * nothing is recording, transcribing or running. Off by default (npm start keeps running).
   */
  idleMs?: number; onIdle?: () => void;
  /** Disposable roots and process boundary for update-guard checks; production always uses this checkout. */
  codeRoot?: string; publicRoot?: string; exit?: (code: number) => void; fingerprint?: FingerprintOptions;
} = {}) {
  const directory = dataDirectory(ROOT, options.directory ?? process.env.MEETING_DATA_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lock(directory);
  let store: MeetingStore | undefined;
  let jobs: JobManager | undefined;
  let sweep: NodeJS.Timeout | undefined;
  let retentionLoop: NodeJS.Timeout | undefined;
  let retention: AudioRetention | undefined;
  let live: LiveCapture | undefined;
  let drafts: LiveDrafts | null = null;
  let setup: SpeechSetup | undefined;
  let aiSetup: AiSetup | undefined;
  let releasePiAdmission: (() => void) | undefined;
  let apiKeys: ApiKeys | undefined;
  try {
    const publicRoot = options.publicRoot ?? join(options.codeRoot ?? ROOT, 'public');
    const staticFiles: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
      '/setup': ['setup.html', 'text/html'], '/setup.html': ['setup.html', 'text/html'],
      '/setup.js': ['setup.js', 'text/javascript'], '/setup.css': ['setup.css', 'text/css'], '/setup-ui.js': ['setup-ui.js', 'text/javascript'],
      '/page-session.js': ['page-session.js', 'text/javascript'],
      '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript'],
      // The mini view (M7): one page, shown by the helper's native window or in Chrome's Picture-in-Picture window.
      '/mini.html': ['mini.html', 'text/html'], '/mini.js': ['mini.js', 'text/javascript'], '/mini.css': ['mini.css', 'text/css'],
      '/live-shared.js': ['live-shared.js', 'text/javascript'],
      '/preview-composition.js': ['preview-composition.js', 'text/javascript'],
      '/transcript-view.js': ['transcript-view.js', 'text/javascript'],
      '/listen.js': ['listen.js', 'text/javascript'],
      '/segments-poll.js': ['segments-poll.js', 'text/javascript'],
      '/capture-clock.js': ['capture-clock.js', 'text/javascript'],
      '/upload-retry.js': ['upload-retry.js', 'text/javascript'],
      '/recording-end.js': ['recording-end.js', 'text/javascript'],
      '/capture-gaps.js': ['capture-gaps.js', 'text/javascript'],
      // The Plans section (M7b); its fixtures load only with ?plans-fixture= in the page URL (a dev switch).
      '/plans.js': ['plans.js', 'text/javascript'], '/plans-fixtures.js': ['plans-fixtures.js', 'text/javascript'],
      '/plans-fixtures-data.js': ['plans-fixtures-data.js', 'text/javascript'],
      // The installed app (M7): its manifest and icons, and a service worker whose only job is the "Starting…" page when the
      // server is not running yet.
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
      '/sw.js': ['sw.js', 'text/javascript'], '/starting.html': ['starting.html', 'text/html'],
      '/starting.css': ['starting.css', 'text/css'], '/starting.js': ['starting.js', 'text/javascript'],
      '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'], '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
      // Markdown rendering for answer cards; vendored so the app needs no network (public/vendor/README.md).
      '/vendor/marked-15.0.12.umd.js': ['vendor/marked-15.0.12.umd.js', 'text/javascript'],
      '/vendor/purify-3.2.6.min.js': ['vendor/purify-3.2.6.min.js', 'text/javascript'],
      '/vendor/katex-0.16.22.min.js': ['vendor/katex-0.16.22.min.js', 'text/javascript'],
    };
    const staticSnapshot = new Map<string, { bytes: Buffer } | { error: unknown }>();
    await Promise.all([...new Set(Object.values(staticFiles).map(([path]) => path))].map(async path => {
      try { staticSnapshot.set(path, { bytes: await readFile(join(publicRoot, path)) }); }
      catch (error) { staticSnapshot.set(path, { error }); } // Missing assets fail on request, not on startup.
    }));
    const fingerprint = await CodeFingerprint.start(options.codeRoot ?? ROOT, publicRoot, options.clock ?? Date.now, options.fingerprint);
    const canRestart = (options.idleMs ?? Number(process.env.MEETING_IDLE_EXIT_S ?? 0) * 1000) > 0;
    // Before anything else (M7b §4): what a crash left running ends. The Pi group of a run recorded as running and the groups
    // recorded in its process folder first (the run is marked interrupted), then any other task's recorded groups (actions).
    try {
      const { ended } = await recoverExplorations(directory, options.clock ?? Date.now);
      const others = await endLeftoverProcesses(join(directory, 'processes'));
      if (ended + others) console.warn(`Ended ${ended + others} process group(s) left running when the server last stopped.`);
    } catch (error) { console.warn(`Could not end the processes left by the last run: ${(error as Error).message}`); }
    store = new MeetingStore(directory);
    // A committed deletion must finish before recognition, notes/actions, boards or plans load their job records.
    finishPendingMeetingDeletions(store, message => console.log(message));
    await store.removeOrphanAudioFiles(); // Under the lock, before any job or incoming recording can create files.
    const settingsPath = join(directory, 'settings.json');
    type BoardModel = 'quick' | 'main';
    const isBoardModel = (v: unknown): v is BoardModel => v === 'quick' || v === 'main';
    let settings: ModeSettings & { boardModel: BoardModel; miniOpensItself: boolean; audioRetention: AudioRetentionSetting; speechModelPath: string | null; setupSeen: boolean; mainModel: string | null; quickModel: string | null;
      /** Providers with a key in the Keychain, and those whose key a failed change may have altered: names only, never a key. */
      apiKeys: KeyProvider[]; apiKeysUnconfirmed: KeyProvider[] } = {
      boardModel: 'quick', miniOpensItself: false, audioRetention: 'day', speechModelPath: null, setupSeen: false, mainModel: null, quickModel: null, apiKeys: [], apiKeysUnconfirmed: [],
    };
    try {
      const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (isAudioRetention(saved.audioRetention)) settings.audioRetention = saved.audioRetention;
      if (isBoardModel(saved.boardModel)) settings.boardModel = saved.boardModel;
      else if (saved.boardModel === 'luna') settings.boardModel = 'quick';
      else if (saved.boardModel === 'sol') settings.boardModel = 'main';
      for (const key of ['mainModel', 'quickModel'] as const) if (typeof saved[key] === 'string' && saved[key].trim()) settings[key] = saved[key];
      if (typeof saved.miniOpensItself === 'boolean') settings.miniOpensItself = saved.miniOpensItself;
      if (typeof saved.speechModelPath === 'string' && saved.speechModelPath.trim()) settings.speechModelPath = saved.speechModelPath;
      if (typeof saved.setupSeen === 'boolean') settings.setupSeen = saved.setupSeen;
      if (['local', 'cloud', 'off'].includes(saved.aiMode)) settings.aiMode = saved.aiMode;
      for (const key of ['localMainModel', 'localQuickModel', 'cloudMainModel', 'cloudQuickModel'] as const) if (typeof saved[key] === 'string') settings[key] = saved[key];
      if (Array.isArray(saved.cloudConsent?.providers) && saved.cloudConsent.providers.every((p: unknown) => typeof p === 'string') && Number.isFinite(saved.cloudConsent.time)) settings.cloudConsent = saved.cloudConsent;
      if (typeof saved.cloudNotice === 'boolean') settings.cloudNotice = saved.cloudNotice;
      for (const key of ['apiKeys', 'apiKeysUnconfirmed'] as const) if (Array.isArray(saved[key])) settings[key] = [...new Set((saved[key] as unknown[]).filter(isKeyProvider))];
    } catch { /* defaults */ }
    let settingsWrite: Promise<unknown> = Promise.resolve();
    const saveSettings = async (change: Partial<typeof settings>) => {
      const write = settingsWrite.catch(() => {}).then(async () => {
        const candidate = { ...settings, ...change };
        const tmp = `${settingsPath}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(candidate), { mode: 0o600 });
        await rename(tmp, settingsPath);
        settings = candidate;
      });
      settingsWrite = write;
      await write;
    };
    const speechSetup = new SpeechSetup(directory, () => settings, saveSettings, options.setup);
    setup = speechSetup;
    await speechSetup.initialize();
    const config = { ...speechSetup.scan.config };
    const switchable = options.recognizer === undefined ? new SwitchableRecognizer(config.available ? config.path : null, options.setup?.worker) : null;
    const recognizer: Recognizer = switchable ?? options.recognizer ?? { available: () => false,
      transcribe: async () => { throw new Error('No local model is available.'); }, close() {} };
    const modelAvailable = () => recognizer.available?.() ?? true;
    jobs = new JobManager(store, recognizer);
    jobs.kick();
    await store.removeSealedFrameFiles();
    drafts = options.drafts !== undefined ? options.drafts
      : new LiveDrafts({ modelPath: config.available ? config.path ?? '' : '', streaming: Boolean(switchable && config.streaming), log: message => console.warn(message) });
    const liveJobs = jobs;
    // Set once the board exists: a window sealed later (also one recovered after a restart) gets its tail scanned.
    let onLiveChunk = (_meetingId: string) => {};
    const capture = new LiveCapture(store, { drafts, clock: options.clock, onChunk: id => { liveJobs?.kick(); onLiveChunk(id); }, log: message => console.warn(message) });
    live = capture;
    if (switchable) speechSetup.attachRuntime({
      recording: () => capture.recording(), cancelSwitch: () => switchable.cancelSwitch(),
      switchTo: (path, applied, canApply) => switchable.switchTo(path, applied, canApply),
      applied: next => drafts?.setModel(next.path, Boolean(next.streaming)),
      kick: () => liveJobs.kick(),
    });
    // Seals sources that went quiet, including frames saved before a restart.
    let onAudioSweep = () => {};
    sweep = setInterval(() => { void capture.sweep(); onAudioSweep(); }, 2000);
    sweep.unref();
    // Projects own materials and glossaries; a meeting sees its project's plus its own extra materials (M6, §8).
    const projects = new Projects(store, directory);
    await projects.migrate();
    const rootsFor = (meetingId: string) => projects.rootsFor(meetingId);
    // The text of PDF materials, kept in the data folder; extracted in the background at startup and when a root is attached.
    const pdfText = new PdfText(directory, { log: message => console.warn(message) });
    pdfText.warm([...projects.list().flatMap(p => projects.roots(projectScope(p.id))), ...store.meetings().flatMap(m => projects.roots(meetingScope(m.id)))]);
    const memory = new Memory(store, options.clock ?? Date.now);
    /** The board's view of memory (§7): open items, one line each, most recently changed first, about 3,000 tokens at most. */
    const memoryLines = (meetingId: string): string[] => {
      const projectId = projects.projectOf(meetingId);
      if (!projectId) return [];
      const label = { todo: 'to-do', decision: 'decision', question: 'question' } as const;
      const open = memory.items(projectId).filter(i => i.status === 'open' || i.status === 'in force').sort((a, b) => b.updatedAt - a.updatedAt);
      const lines: string[] = [];
      let size = 0;
      for (const item of open) {
        const line = `- ${item.id} [${label[item.type]}${item.confirmed ? '' : ', unconfirmed'}] ${item.text}`;
        if (size + line.length > 12_000) { lines.push(`- (${open.length - lines.length} older items not shown)`); break; }
        lines.push(line);
        size += line.length;
      }
      return lines;
    };
    const glossaryFor = async (meetingId: string) => projects.glossaryFor(meetingId);
    const clock = options.clock ?? Date.now;
    const cloud = process.env.MEETING_CLOUD !== '0';
    const scratchRoot = join(directory, 'scratch');
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    let keysLoaded = Promise.resolve();
    const ai = new AiSetup(() => settings, async change => {
      const previous = settings.aiMode;
      const providers = JSON.stringify([...(settings.cloudConsent?.providers ?? [])].sort());
      await saveSettings(Object.fromEntries(Object.entries(change).filter(([key]) =>
        ['aiMode', 'mainModel', 'quickModel', 'localMainModel', 'localQuickModel', 'cloudMainModel', 'cloudQuickModel', 'cloudConsent', 'cloudNotice'].includes(key))));
      if (previous && (previous !== settings.aiMode || (previous === 'cloud' && providers !== JSON.stringify([...(settings.cloudConsent?.providers ?? [])].sort())))) stopPiRuns();
    }, { ...options.ai, cwd: scratchRoot, cloud, keysReady: () => keysLoaded });
    aiSetup = ai;
    releasePiAdmission = setPiAdmission(model => { ai.allow(model); return ai.mode(); });
    // Saved API keys reach every Pi child through its environment (pi-command.ts); with cloud models off nothing is read.
    const keys = new ApiKeys({ saved: () => settings, persist: change => saveSettings(change), reader: ai.reader,
      keychain: options.keys?.keychain, fetch: options.keys?.fetch, env: options.ai?.env, log: message => console.warn(message) });
    apiKeys = keys;
    let keysStarted = false;
    const loadCloudKeys = () => { if (!keysStarted) { keysStarted = true; keysLoaded = keys.load(); } return keysLoaded; };
    if (cloud && (settings.aiMode === 'cloud' || (!settings.aiMode && settings.setupSeen))) void loadCloudKeys();
    ai.start(); // Discovery, package detection and auth must never delay startup.
    // Exclude the bundled fallback when deciding whether a bare `pi` works in the user's terminal.
    const signInEnv = options.ai?.env ?? process.env;
    const signInCommand = resolvePi({ env: signInEnv, root: '/dev/null' }) ? 'pi'
      : `cd '${ROOT.replace(/'/g, `'\\''`)}' && npx pi`;
    const setupStatus = () => { const status = speechSetup.status(); return { ...status, rows: [...status.rows, { ...ai.status(), signInCommand }] }; };
    const quick: Quick | null = options.quick !== undefined ? options.quick
      : cloud ? new ModelRpc(() => ai.correction(), { cwd: scratchRoot, unavailable: () => localLiveUnavailable(), systemPrompt: CORRECTION_SYSTEM_PROMPT, log: message => console.log(`[pi correction] ${message}`) }) : null;
    const heavy: Heavy | null = options.heavy !== undefined ? options.heavy
      : cloud ? async (prompt, o) => runPiTask(prompt, { model: await ai.require('main'), cwd: o.cwd, readRoots: o.readRoots, sessionDir: o.sessionDir, signal: o.signal, tools: 'read,grep,find,ls', timeoutMs: 600_000 }) : null;
    // Notes: one no-tools call on sol; the transcript goes in as a file. Any tool use or non-normal stop is a failure.
    // An explicit `heavy: null` (tests, smoke runs) also disables notes unless a notes runner is injected.
    const notesRunner: NotesRunner | null = options.notes !== undefined ? options.notes
      : cloud && options.heavy !== null ? piNotesRunner(() => ai.require('main')) : null;
    // Always present: saved notes stay readable and exportable with cloud models off; only writing needs a runner.
    // After notes are written for a meeting in a project, memory proposes changes from them (M6 §4). Set below.
    let afterNotes = (_meetingId: string) => {};
    // One quota cooldown for every sol job (M7b §4): a rate-limit error in any of them pauses the others for as long.
    const cooldowns = new Cooldowns(clock);
    const notesJobs = new NotesJobs({ store, directory, runner: notesRunner, clock, glossaryFor, onSaved: id => afterNotes(id), cooldowns });
    // Memory proposals use sol with no tools (as notes); "Tell the project…" uses the quick model for a sentence.
    const proposals = new Proposals(store, memory, { runner: notesRunner, briefRunner: notesRunner, directory, clock,
      notesFor: id => notesJobs.file(id).load(), projectOf: id => projects.projectOf(id), onChange: id => files.touch(id), cooldowns });
    const tellRunner: NotesRunner | null = cloud && options.heavy !== null ? piNotesRunner(() => ai.require('quick')) : options.notes ?? null;
    // The memory files in each project's repo (§3.3, §6); the quick model reads agents' notes and guesses sources.
    const files: MemoryFiles = new MemoryFiles(store, memory, proposals, { directory, clock, project: id => projects.get(id), projects: () => projects.list(),
      meetingTitle: id => { try { return store!.meeting(id).title; } catch { return 'a meeting'; } }, interpreter: tellRunner, guesser: tellRunner, log: message => console.warn(message) });
    for (const project of projects.list()) files.touch(project.id, 0);
    const lastOpened = new Map<string, number>();
    /** The source an Accept records: 'suggested' (the guess), a commit the user picked from the repo (checked to exist), or the original. */
    const acceptSource = async (projectId: string, value: unknown): Promise<import('./proposals.ts').AcceptSource> => {
      if (value === 'suggested') return 'suggested';
      const hash = typeof value === 'object' && value && typeof (value as { commit?: unknown }).commit === 'string' ? (value as { commit: string }).commit : null;
      if (!hash) return 'original';
      const repo = projects.get(projectId).repoPath;
      const commit = repo ? (await recentCommits(repo, 200).catch(() => [])).find(c => c.hash === hash) : undefined;
      if (!commit) throw new HttpError(400, 'That commit is not in the repo.');
      return { kind: 'commit', hash: commit.hash, subject: commit.subject, paths: commit.paths.slice(0, 10) };
    };
    /** A cheap fingerprint of a project's memory, what waits for an OK, and the files' state. */
    const memoryStamp = (projectId: string) => {
      const db = store!.db;
      const value = (sql: string) => Object.values(db.prepare(sql).get(projectId) as Record<string, unknown>).join('/');
      return [value('SELECT count(*), max(at) FROM memory_batches WHERE project=?'),
        value("SELECT count(*), sum(status='pending'), max(createdAt), max(resolvedAt), group_concat(CASE WHEN status='pending' THEN id END) FROM memory_proposals WHERE project=?"),
        value('SELECT max(version) FROM memory_brief WHERE project=?'), value("SELECT count(*), max(at) FROM memory_captures WHERE project=?"),
        value('SELECT count(*), max(at) FROM memory_inbox WHERE project=?'), files.state(projectId).state].join(':');
    };
    /** After any change to a project's memory: edits read back can resolve, and the files are regenerated. */
    const changed = (projectId: string) => { files.resolveCaptures(projectId); files.touch(projectId); };
    // Only notes written after the meeting update memory by themselves; drafts written while it is still being recorded,
    // replayed or transcribed wait for "Update memory from these notes" (or the next notes after Stop).
    afterNotes = id => {
      // "Plan after the notes" (M7b), when the project has it on; the run waits for the memory update, which goes first.
      void planJobs.notesSaved(id).catch(error => console.warn(`Plan after the notes: ${(error as Error).message}`));
      if (!proposals.enabled || !projects.projectOf(id) || stillComing(id)) return;
      proposals.request(id).catch(error => console.warn(`Memory update: ${(error as Error).message}`));
    };
    // Select-text actions (M3): sol with per-action tools; an explicit `heavy: null` disables them unless a runner is injected.
    const actionRunner: ActionRunner | null = options.actions !== undefined ? options.actions
      : cloud && options.heavy !== null ? piActionRunner(() => ai.require('main')) : null;
    // Memory for actions (§7): a snapshot made from the database (never the repo files, which may hold unresolved edits),
    // with the notes of the project's other meetings, in a read-only folder per action so its citations stay checkable.
    const snapshotRoot = join(directory, 'scratch', 'memory-snapshots');
    const memorySnapshots = {
      async prepare(meetingId: string): Promise<{ root: import('./materials.ts').Material; pins: import('./actions.ts').MemoryPins } | null> {
        const projectId = projects.projectOf(meetingId);
        if (!projectId) return null;
        const id = `memory-${randomUUID()}`;
        const folder = join(snapshotRoot, meetingId, id);
        const title = (m: string) => { try { return appStoreRef.meeting(m).title; } catch { return 'a meeting'; } };
        // Render and pin synchronously: no edit can land between the text and its provenance.
        const contents = renderMemory(memory, projectId, clock(), title);
        const pins = { projectId, items: Object.fromEntries(memory.items(projectId).filter(i => i.status !== 'merged').map(i => [i.id, { version: i.version, type: i.type, status: i.status, text: i.text }])) };
        await mkdir(join(folder, 'past-notes'), { recursive: true, mode: 0o700 });
        for (const [file, content] of Object.entries(contents)) {
          if (file === 'README.md') continue; // that file tells outside agents how to write; these agents only read
          await mkdir(dirname(join(folder, file)), { recursive: true });
          await writeFile(join(folder, file), content, { mode: 0o600 });
        }
        for (const other of appStoreRef.meetings().filter(m => m.id !== meetingId && projects.projectOf(m.id) === projectId)) {
          const record = await notesJobs.file(other.id).load();
          if (record) await writeFile(join(folder, 'past-notes', `${new Date(other.createdAt).toISOString().slice(0, 10)}-${other.id.slice(0, 8)}.md`), notesMarkdown(record, false), { mode: 0o600 });
        }
        // Keep every snapshot an action of this meeting still refers to (its citations stay checkable), plus the latest 30.
        const used = new Set(actionJobs.list(meetingId).flatMap(job => job.context.roots.map(r => r.id)));
        const all = await Promise.all((await readdir(join(snapshotRoot, meetingId))).map(async name => ({ name, at: (await stat(join(snapshotRoot, meetingId, name))).mtimeMs })));
        for (const old of all.sort((a, b) => b.at - a.at).slice(30)) if (!used.has(old.name)) await rm(join(snapshotRoot, meetingId, old.name), { recursive: true, force: true });
        return { root: { id, scope: `project:${projectId}`, path: await realpath(folder), kind: 'folder', label: 'project memory (snapshot from the app; "unconfirmed" = AI-recorded)' }, pins };
      },
      root(meetingId: string, rootId: string) {
        if (!/^memory-[a-f0-9-]{36}$/.test(rootId)) return null;
        const projectId = projects.projectOf(meetingId);
        const path = join(snapshotRoot, meetingId, rootId);
        return projectId && existsSync(path) ? { id: rootId, scope: `project:${projectId}`, path: realpathSync(path), kind: 'folder' as const, label: 'project memory (snapshot)' } : null;
      },
    };
    const webUnavailable = () => ai.mode() === 'local' ? 'Web lookups are unavailable in On this Mac mode.' : null;
    const actionJobs = new ActionJobs({ store, directory, runner: actionRunner, clock, glossaryFor, memory: memorySnapshots,
      rootsFor, webAvailable: () => ai.web, webUnavailable, pdfText, cooldowns });
    await actionJobs.load();
    // Both warm lanes select at call time; old processes drain accepted work on a model change.
    const boardGates = options.board === undefined && cloud && options.heavy !== null;
    const gate = boardGates ? new ModelRpc(() => ai.require(settings.boardModel), {
      cwd: scratchRoot, unavailable: () => localLiveUnavailable(), timeoutMs: 90_000, log: message => console.log(`[pi board] ${message}`),
    }) : null;
    // The scan cadence follows the meeting's own time: the replay position during a replay (60 s of meeting, not of wall time).
    const boardStore = store;
    const meetingClock = (id: string) => { const replay = boardStore.replay(id); return replay ? boardStore.replayPositionMs(replay, clock()) + replay.baseMs : clock(); };
    const boards = new Boards({ store, directory, clock, meetingClock, actions: actionJobs, glossaryFor,
      ask: options.board !== undefined ? options.board : gate ? message => gate.ask(message) : null,
      hasMaterials: id => rootsFor(id).length > 0, memoryFor: id => memoryLines(id) });
    // Only meetings being recorded or replayed (or explicitly asked for) are scanned: an old meeting never spends quota on its own.
    const boardActive = new Set<string>();
    onLiveChunk = id => { boardActive.add(id); };
    const corrector = quick ? new Corrector({ store, clock, ask: prompt => quick.ask(prompt), glossaryFor }) : null;
    // Glossary builds, keyed by glossary scope: two meetings of one project share one build.
    const building = new Map<string, { startedAt: number; error?: string }>();
    const builds = new Map<string, { controller: AbortController; done: Promise<void> }>();
    const lastPcmAt = new Map<string, number>();
    // A recording session per meeting: the sources that sent audio and have not ended (Stop sends /pcm/end per source).
    const recording = new Map<string, Set<string>>();
    // Unvalidated bodies need a temporary guard, not a durable recording claim or a fresh activity timestamp.
    const receivingPcm = new Map<string, number>();
    const importing = new Set<string>();
    const isRecording = (meetingId: string) => Boolean(appStoreRef.heldFrames(meetingId).length
      || (recording.get(meetingId)?.size && clock() - (lastPcmAt.get(meetingId) ?? 0) < 60_000));
    const stillComing = (meetingId: string) => {
      const replay = appStoreRef.replay(meetingId);
      return receivingPcm.has(meetingId) || isRecording(meetingId) || Boolean(replay && appStoreRef.replayPositionMs(replay, clock()) < replay.durationMs)
        || appStoreRef.chunks(meetingId).some(c => c.status === 'queued' || c.status === 'running');
    };
    // Explorations (M7b): the plan pass and Explore further, one at a time across the app, after any recording or replay and
    // after the meeting's own notes, memory update and actions. What a run computes comes with its request; this is its runtime.
    const replaying = () => appStoreRef.meetings().some(m => { const replay = appStoreRef.replay(m.id); return Boolean(replay && appStoreRef.replayPositionMs(replay, clock()) < replay.durationMs); });
    // In-flight bodies count for admission immediately, but only accepted frames publish lasting recording activity.
    const recordingAnywhere = () => receivingPcm.size > 0 || capture.recording() || [...recording.keys()].some(id => isRecording(id));
    const localLiveUnavailable = () => ai.mode() === 'local' && recordingAnywhere() ? 'The local Board and corrections wait until recording stops.' : null;
    // The plans' Pi: the real one with cloud models on (an explicit `heavy: null` turns it off, as for notes), or a test's.
    const planPi = options.plans !== undefined ? options.plans : cloud && options.heavy !== null ? runPiTask : null;
    const explorations = new Explorations({ directory, clock, cooldowns, runPi: planPi ?? undefined, usesWeb: () => ai.web, local: () => ai.mode() === 'local', onEnd: job => planJobs.ended(job),
      recording: () => recordingAnywhere() ? 'the recording to end' : replaying() ? 'the replay to end' : null,
      meetingWork: () => {
        const meetings = appStoreRef.meetings();
        return meetings.some(m => notesJobs.busy(m.id)) ? 'the notes' : meetings.some(m => proposals.busy(m.id)) ? 'the memory update'
          : meetings.some(m => actionJobs.busy(m.id)) ? 'the actions' : null;
      } });
    await explorations.load();
    // The plans of a meeting (M7b §2b): published versions in data/plans, their to-dos and automatic attempts in the database.
    const planJobs = new PlanJobs({ store, directory, clock, explorations, cooldowns, memory, projects, notes: notesJobs, pdfText,
      versions: new PlanVersions(directory, clock), todos: new PlanTodos(store, memory, clock), auto: new AutoPlanning(store, clock),
      enabled: Boolean(planPi), web: () => ai.web, webUnavailable,
      models: async kind => ai.allow(await planModel(kind, () => ai.require('main'))),
      materialEvidence: (path, blocks) => files.evidenceAllowed(path, blocks),
      final: id => !stillComing(id), stale: id => notesJobs.status(id).then(s => s.stale), changed: id => changed(id) });
    /** What is running for a meeting, in words; a move waits for all of it (§8.2). Synchronous, so the caller can move right after. */
    const busy = (meetingId: string) => [
      ...(isRecording(meetingId) || receivingPcm.has(meetingId) ? ['the recording'] : []),
      ...((() => { const replay = appStoreRef.replay(meetingId); return replay && appStoreRef.replayPositionMs(replay, clock()) < replay.durationMs; })() ? ['the replay'] : []),
      ...(notesJobs.busy(meetingId) ? ['the notes'] : []),
      ...(proposals.busy(meetingId) ? ['the memory update'] : []),
      ...(actionJobs.busy(meetingId) ? ['an action'] : []),
      ...(explorations.busy(meetingId) ? ['the plans'] : []),
      ...(boards.busy(meetingId) ? ['a board scan'] : []),
      ...(corrector?.isBusy(meetingId) ? ['the glossary corrections'] : []),
      ...(building.get(projects.scope(meetingId).glossaryScope) && !building.get(projects.scope(meetingId).glossaryScope)!.error ? ['the glossary build'] : []),
    ];
    store.registerDeletionGuard('server activity', id => busy(id).length > 0 || capture.active(id) || importing.has(id));
    // Drain the tail once nothing more is coming: replay finished, or no audio for a minute and nothing queued.
    const finished = (meetingId: string) => {
      if (appStoreRef.chunks(meetingId).some(c => c.status === 'queued' || c.status === 'running')) return false;
      if (appStoreRef.heldFrames(meetingId).length) return false; // Saved live audio not yet in a window.
      const replay = appStoreRef.replay(meetingId);
      if (replay) return appStoreRef.replayPositionMs(replay, clock()) >= replay.durationMs;
      return clock() - (lastPcmAt.get(meetingId) ?? 0) > 60_000;
    };
    const appStoreRef = store;
    const audioRetention = new AudioRetention(store, { setting: () => settings.audioRetention, clock,
      pending: id => receivingPcm.has(id),
      active: id => isRecording(id) || capture.active(id) || importing.has(id), log: message => console.warn(message) });
    retention = audioRetention;
    if (jobs) jobs.onSettled = () => audioRetention.observe();
    onAudioSweep = () => audioRetention.observe();
    retentionLoop = setInterval(() => { void audioRetention.run(); }, 60 * 60_000);
    retentionLoop.unref();
    const correctionLoop = corrector ? setInterval(() => {
      if ((options.quick === undefined && ai.mode() === 'off') || (ai.mode() === 'local' && recordingAnywhere())) return;
      for (const meeting of appStoreRef.meetings()) {
        const calls = corrector.state(meeting.id).stats.calls;
        corrector.tick(meeting.id, finished(meeting.id)).then(() => {
          const s = corrector.state(meeting.id).stats;
          if (s.calls !== calls) console.log(`Correction ${meeting.id.slice(0, 8)}: ${s.calls} calls, ${s.linesSent ?? 0} lines sent, ${s.linesSkipped ?? 0} filler lines skipped, tokens in ${s.tokensIn ?? 0} (cached ${s.tokensCached ?? 0}) out ${s.tokensOut ?? 0}${s.callsWithoutUsage ? `, ${s.callsWithoutUsage} calls without usage` : ''}`);
        }).catch(error => console.warn(`Correction failed: ${(error as Error).message}`));
      }
    }, options.correctionTickMs ?? 5000) : undefined;
    correctionLoop?.unref();
    // End of a meeting: the final scan waits for the tail to be transcribed, but at most 60 s after the speech ended. A meeting
    // stays watched for 10 minutes after that, so corrections finishing late are still scanned; later edits need "Scan this meeting".
    const endedAt = new Map<string, number>();
    const meetingIds = appStoreRef.db.prepare('SELECT id FROM meetings');
    const pruneDeletedMeetingState = () => {
      const existing = new Set((meetingIds.all() as { id: string }[]).map(m => m.id));
      for (const state of [boardActive, endedAt, lastPcmAt, recording, receivingPcm, importing]) {
        for (const id of state.keys()) if (!existing.has(id)) state.delete(id);
      }
      // Active builds block deletion; failed meeting builds can linger. Project-scoped builds belong to the project.
      for (const state of [building, builds]) {
        for (const scope of state.keys()) if (scope.startsWith('meeting:') && !existing.has(scope.slice('meeting:'.length))) state.delete(scope);
      }
      capture.pruneMeetings(existing);
      liveView.pruneMeetings(existing);
    };
    const boardLoop = setInterval(() => {
      pruneDeletedMeetingState();
      if ((options.board === undefined && ai.mode() === 'off') || (ai.mode() === 'local' && recordingAnywhere())) return;
      for (const meetingId of boardActive) {
        const replay = appStoreRef.replay(meetingId);
        // Saved live audio not yet in a window keeps a live meeting open.
        const ended = replay ? appStoreRef.replayPositionMs(replay, clock()) >= replay.durationMs
          : clock() - (lastPcmAt.get(meetingId) ?? 0) > 60_000 && !appStoreRef.heldFrames(meetingId).length;
        if (ended && !endedAt.has(meetingId)) endedAt.set(meetingId, clock());
        if (!ended) endedAt.delete(meetingId);
        // "ended" already means 60 s without audio for a live meeting; a replay gets 60 s after its end for the tail.
        const done = finished(meetingId) || (ended && (!replay || clock() - endedAt.get(meetingId)! > 60_000));
        void boards.tick(meetingId, done).then(async () => {
          if (done && clock() - endedAt.get(meetingId)! > 10 * 60_000 && !(await boards.hasBacklog(meetingId))) { boardActive.delete(meetingId); endedAt.delete(meetingId); }
        }).catch(error => console.warn(`Board tick failed: ${(error as Error).message}`));
      }
    }, 5000);
    boardLoop.unref();
    // The destination scope, roots and starting version are fixed before the model call; the save is a compare-and-swap.
    const buildGlossary = async (meetingId: string, scope: string, signal: AbortSignal) => {
      const roots = rootsFor(meetingId).map(root => root.path);
      const before = projects.glossary(scope)?.version ?? null;
      const cwd = join(scratchRoot, meetingId);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      // The PDFs' text, in this build's own view of it (only these roots' PDFs), removed when the build ends.
      const view = join(cwd, 'pdf-text');
      try {
        const pdfs = (await pdfText.prepare(rootsFor(meetingId), { waitMs: 60_000, view, signal })).filter(p => p.ready).map(p => p.text);
        await writeFile(join(cwd, 'AGENTS.md'), `Attached materials are READ-ONLY. Never create, edit or delete files in:\n${roots.map(r => `- ${r}`).join('\n')}\n`);
        signal.throwIfAborted();
        const result = await heavy!(glossaryPrompt(roots, pdfs), { cwd, readRoots: roots, sessionDir: join(directory, 'sessions', meetingId), signal });
        signal.throwIfAborted();
        projects.saveGlossary(scope, cleanGlossary(extractJson(result.text)), 'generated', result.provider && `${result.provider}/${result.model}`, before);
      } finally { await rm(view, { recursive: true, force: true }).catch(() => {}); }
    };
    const token = await sessionToken(directory);
    let origin = '';
    let uploading = false;
    let closing = false;
    let restarting = false;
    let admissions = 0; // Mutations count before their first await, including bodies/uploads not yet represented by jobs.
    const pages = new Map<string, number>(); // page id → last request
    // The installed app's server stops by itself once its window is gone and nothing is in progress. A page silent for 3 min
    // (hidden and throttled, or closed without its goodbye) no longer counts. Until a first page has come, a minute's grace.
    let seenPage = false;
    const startedAt = Date.now();
    let idleSince: number | null = null;
    const working = () => admissions > 0 || uploading || importing.size > 0 || ['downloading', 'checking'].includes(speechSetup.download.state.state) || capture.recording() || appStoreRef.queuedCount() > 0 || appStoreRef.meetings().some(m => stillComing(m.id) || busy(m.id).length > 0);
    const idleLoop = options.idleMs ? setInterval(() => {
      pruneDeletedMeetingState();
      const now = Date.now();
      for (const [id, at] of pages) if (now - at > 180_000) pages.delete(id);
      if (pages.size || working() || closing || restarting || shuttingDown || (!seenPage && now - startedAt < 60_000)) { idleSince = null; return; }
      idleSince ??= now;
      if (now - idleSince >= options.idleMs!) { clearInterval(idleLoop); options.onIdle?.(); }
    }, 1000) : undefined;
    idleLoop?.unref();
    let shuttingDown = false;
    // The mini view (M7 native mini window, docs/design/M7-native-mini.md): drawn from the server alone, so it stays current while
    // the app's page is hidden and throttled (another app in full screen); Stop and cards reach the page through frame replies.
    const liveView = new LiveView(clock);
    const segmentsTag = new SegmentsTag();
    /** The recording now, with only the sources of its own recording (a reloaded page's old sources are not). */
    const recordingNow = () => {
      return capture.recordingNow(source => liveView.has(source));
    };
    /** Speaker-labelled visible lines in the transcript's order, as the snapshot gives them. */
    const labelledLines = (meetingId: string) => {
      const { labelled, roleOf } = appStore.speakers(meetingId);
      const visible = appStore.visibleSegments(meetingId, clock());
      if (labelled) visible.sort(compareSegments);
      const speaker = (source: string, startMs: number, endMs: number) => { const role = roleOf(source, startMs, endMs); return role ? ROLE_LABEL[role] : null; };
      return { labelled, roleOf, visible, speaker };
    };
    /** Display-only previews, annotated once for both response shapes. Retirement sees the finals in the same reply. */
    const displayPreviews = (meetingId: string, visible: ReturnType<typeof appStore.visibleSegments>, speaker: (source: string, startMs: number, endMs: number) => string | null) => {
      const annotate = <T extends Draft>(draft: T) => {
        const { meetingId: _meetingId, ...display } = draft;
        return { ...display, speaker: speaker(draft.source, draft.windowStartMs, Math.max(draft.coveredUntilMs, draft.windowStartMs + 1)) };
      };
      const chunks = drafts ? appStore.chunks(meetingId) : [];
      const rendered = new Set(visible.map(s => s.chunkId));
      const terminal = chunks.filter(c => ownsDisplayInterval(c, rendered));
      return {
        // A final may win even while sealWindow is finishing asynchronous frame cleanup, before the old stream is frozen.
        drafts: (drafts?.drafts(meetingId) ?? []).map(d => {
          const words = d.words.filter(w => !terminal.some(c => c.source === d.source && midpoint(w) >= c.startMs && midpoint(w) < c.startMs + c.seconds * 1000));
          return annotate({ ...d, words, text: words.map(w => w.text).join(' ') });
        }),
        pending: (drafts?.pending(meetingId, chunks, rendered) ?? []).map(annotate),
      };
    };
    /**
     * The recording now, for the mini view. `have` is the `paragraphsTag` of the page's last reply: the paragraphs it already holds
     * (all but the last, which may still grow). While they are unchanged, only the paragraphs after them are sent, so a long
     * meeting's transcript is sent once and then only what changed at its end.
     */
    const liveModel = async (have: string | null = null) => {
      const now = recordingNow();
      if (!now) return { recording: null, mini: { native: liveView.native(), state: liveView.miniState() } };
      const { meetingId } = now;
      const { labelled, roleOf, visible, speaker } = labelledLines(meetingId);
      // The whole meeting's paragraphs, grouped as the transcript groups them; the mini view scrolls back through them.
      const lines = visible.map(s => ({ id: s.id, source: s.source, startMs: s.startMs, endMs: s.endMs, revision: s.revision, text: s.text, ...(labelled ? { speaker: speaker(s.source, s.startMs, s.endMs) } : {}) }));
      const previews = displayPreviews(meetingId, visible, speaker);
      const { paragraphs: meeting, placements } = miniLog(lines, previews.drafts, previews.pending);
      // Names the first n paragraphs as they are now, in this recording: any change among them (a correction, a line hidden)
      // changes it, and so does a new recording, even of the same meeting (a page that held the last one starts afresh).
      const session = liveView.sessionId();
      const tag = (n: number) => `${session}.${n}.${createHash('sha1').update(meeting.slice(0, n).map(p => `${p.key}/${p.signature}`).join('\n')).digest('base64url').slice(0, 16)}`;
      const held = Number((have ?? '').split('.')[1]);
      const from = Number.isInteger(held) && held >= 0 && held <= meeting.length && have === tag(held) ? held : 0;
      const paragraphs = meeting.slice(from).map(p => ({ key: p.key, signature: p.signature, speaker: p.speaker ?? null, text: p.segments.map(s => s.text).join(' ') }));
      // One preview slot per live source, the microphone first: its newest 20 words.
      const all = previews.drafts;
      const slots = now.sources.map(s => s.source).sort((a, b) => (a.startsWith('mic:') ? 0 : 1) - (b.startsWith('mic:') ? 0 : 1)).map(source => {
        const mine = all.filter(d => d.source === source);
        const text = miniPreviewWords(source, visible, all, previews.pending, 20, placements);
        const last = mine.at(-1);
        const role = labelled && last ? roleOf(source, last.windowStartMs, Math.max(last.coveredUntilMs, last.windowStartMs + 1)) : null;
        return { source, speaker: labelled ? (role ? ROLE_LABEL[role] : source.startsWith('tab:') ? 'Them' : 'Me') : null, text };
      });
      // The newest card not dismissed: a project card, or an other matter only when there is nothing else.
      const cards = (await boards.cards(meetingId)).filter(c => !c.dismissed).sort((a, b) => b.createdAt - a.createdAt);
      const newest = cards.find(c => c.type !== 'other') ?? cards[0];
      return {
        recording: { meetingId, session: liveView.sessionId(), clockMs: liveView.clockMs() ?? now.clockMs, stopping: liveView.stopping(), labelled,
          paragraphs, paragraphsFrom: from, paragraphsTag: tag(Math.max(0, meeting.length - 1)), drafts: slots, pending: previews.pending.map(p => ({ ...p,
            placements: placements.filter(r => r.chunkId === p.chunkId) })),
          card: newest ? { id: newest.id, type: newest.type, firstMs: newest.firstMs, text: newest.text } : null, notices: liveView.notices(now.sources) },
        mini: { native: liveView.native(), state: liveView.miniState() },
      };
    };
    const appStore = store;
    const appJobs = jobs;
    const server = createServer(async (req, res) => {
      let admitted = false;
      let releasePcm: (() => void) | undefined;
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      try {
        if (`http://${req.headers.host}` !== origin) throw new HttpError(403, 'Unexpected host. Open the exact local URL printed by the server.');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
        const url = new URL(req.url ?? '/', origin);
        if (req.method === 'GET' && staticFiles[url.pathname]) {
          const [path, type] = staticFiles[url.pathname];
          // The mini page also starts a session: the helper's web view opens it directly.
          if (['/', '/setup', '/setup.html', '/mini.html'].includes(url.pathname)) res.setHeader('Set-Cookie', `meeting_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
          if (url.pathname === '/') {
            const speech = speechSetup.status().rows.find(row => row.id === 'speech')!;
            const neededReady = speech.state === 'ready' && !speechSetup.pending;
            if (!settings.setupSeen || (!neededReady && appStore.meetings().length === 0)) {
              res.writeHead(302, { Location: '/setup', 'Cache-Control': 'no-store' }).end(); return;
            }
          }
          // Chrome's Picture-in-Picture window holds the mini page in a frame of the app's own origin.
          if (url.pathname === '/mini.html') res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
          res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
          const snapshot = staticSnapshot.get(path)!;
          if ('error' in snapshot) throw snapshot.error;
          res.end(snapshot.bytes);
          return;
        }
        const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim());
        if (!cookies.includes(`meeting_session=${token}`)) throw new HttpError(403, 'Open the dashboard first to establish a local session.');
        if (req.method !== 'GET' && req.headers.origin !== origin) throw new HttpError(403, 'Mutations require the dashboard origin.');
        const restartRequest = req.method === 'POST' && url.pathname === '/api/restart';
        const mutation = req.method !== 'GET' && !restartRequest && url.pathname !== '/api/bye';
        // Reserve admission synchronously with restart: a body/preparation already in flight blocks acceptance, and no
        // mutation can slip in after acceptance. Reads and goodbye remain available during the graceful shutdown delay.
        if (restarting && mutation) { send(res, 503, { error: 'Restarting' }); return; }
        if (restarting && restartRequest) { send(res, 202, { restarting: true }); return; }
        if (closing) throw new HttpError(503, 'Server is shutting down.');
        if (mutation) { admissions++; admitted = true; }
        pruneDeletedMeetingState();
        // Open pages (the installed app's window, tabs): each says who it is with every request, and goodbye when it closes.
        const pageId = req.headers['x-page'];
        if (typeof pageId === 'string' && pageId.length <= 64) {
          pages.set(pageId, Date.now()); seenPage = true;
          // Only an actual frame reclaims a recovering source; a page heartbeat does not prove it is still capturing.
        }
        if (req.method === 'POST' && url.pathname === '/api/bye') {
          const departed = url.searchParams.get('page') ?? '';
          pages.delete(departed);
          const departedSources = appStore.openRecordings().filter(s => s.pageId === departed);
          await capture.abandonPage(departed);
          for (const session of departedSources) recording.get(session.meetingId)?.delete(session.source);
          audioRetention.observe();
          res.writeHead(204).end(); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/setup') { send(res, 200, setupStatus()); return; }
        if (req.method === 'GET' && url.pathname === '/api/setup/ai/models') {
          const mode = url.searchParams.get('mode');
          if (mode !== null && mode !== 'local' && mode !== 'cloud' && mode !== 'off') throw new HttpError(400, 'Choose a valid AI mode.');
          if (cloud && mode === 'cloud') await loadCloudKeys();
          send(res, 200, { ...await ai.models(url.searchParams.get('refresh') === '1', mode ?? undefined), settings: { localMainModel: settings.localMainModel, localQuickModel: settings.localQuickModel, cloudMainModel: settings.cloudMainModel ?? settings.mainModel, cloudQuickModel: settings.cloudQuickModel ?? settings.quickModel }, recommended: RECOMMENDED_LOCAL_MODEL }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/setup/ai/notice') { await saveSettings({ cloudNotice: false }); send(res, 200, setupStatus()); return; }
        if (req.method === 'PUT' && url.pathname === '/api/setup/ai') { const value = await json(req); if (cloud && value?.mode === 'cloud') await loadCloudKeys(); await ai.use(value); send(res, 200, setupStatus()); return; }
        if (url.pathname === '/api/setup/ai/keys' || url.pathname.startsWith('/api/setup/ai/keys/')) {
          if (!cloud) throw new HttpError(409, 'AI is off for this start.');
          await loadCloudKeys();
          if (req.method === 'GET' && url.pathname === '/api/setup/ai/keys') { send(res, 200, { keys: await keys.list(url.searchParams.get('fresh') === '1') }); return; }
          const provider = decodeURIComponent(url.pathname.slice('/api/setup/ai/keys/'.length));
          if (!isKeyProvider(provider)) throw new HttpError(404, 'Not found.');
          let reset: string[] = [];
          if (req.method === 'PUT') {
            const value = await json(req);
            await keys.add(provider, value && typeof value === 'object' ? value.key : undefined);
          } else if (req.method === 'DELETE') {
            await keys.remove(provider);
            reset = await ai.resetProvider(provider);
          } else throw new HttpError(405, 'Use PUT or DELETE.');
          // The new list goes back at once, so the dialog can offer the new models (or stop offering the removed ones).
          const models = await ai.models(true, 'cloud');
          send(res, 200, { keys: await keys.list(), models, reset }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/setup/speech-models') { send(res, 200, speechSetup.models()); return; }
        if (req.method === 'POST' && url.pathname.startsWith('/api/setup/')) {
          const action = url.pathname.slice('/api/setup/'.length);
          if (action === 'speech/use') { const value = await json(req); if (!value || typeof value !== 'object') throw new HttpError(400, 'Give the id of a speech model.'); send(res, 200, await speechSetup.use(value.id)); return; }
          if (action === 'speech/choose-file') { send(res, 200, await speechSetup.chooseFile()); return; }
          if (action === 'speech/download') {
            const raw = await body(req, 16_384);
            let value;
            try { value = raw.length ? JSON.parse(raw.toString()) : {}; } catch { throw new HttpError(400, 'Provide valid JSON.'); }
            if (!value || typeof value !== 'object' || Array.isArray(value) || (value.use !== undefined && typeof value.use !== 'boolean')) throw new HttpError(400, 'use is true or false.');
            send(res, 200, await speechSetup.startDownload(value.use === true)); return;
          }
          if (action === 'speech/pause') { await speechSetup.download.pause(); send(res, 200, speechSetup.status()); return; }
          if (action === 'speech/cancel') { send(res, 200, await speechSetup.cancelDownload()); return; }
          if (action === 'recheck') { await Promise.all([speechSetup.recheck(), ai.recheck()]); send(res, 200, setupStatus()); return; }
          if (action === 'seen') { send(res, 200, await speechSetup.seen()); return; }
          throw new HttpError(404, 'Not found.');
        }
        if (url.pathname === '/api/settings') {
          if (req.method === 'PUT') {
            const value = await json(req);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Give the settings to change.');
            // One setting or both; the others stay as they are.
            const change: Partial<typeof settings> = {};
            if (value.boardModel !== undefined) {
              if (!isBoardModel(value.boardModel)) throw new HttpError(400, 'boardModel is quick or main.');
              change.boardModel = value.boardModel;
            }
            if (value.miniOpensItself !== undefined) {
              if (typeof value.miniOpensItself !== 'boolean') throw new HttpError(400, 'miniOpensItself is true or false.');
              change.miniOpensItself = value.miniOpensItself;
            }
            if (value.audioRetention !== undefined) {
              if (!isAudioRetention(value.audioRetention)) throw new HttpError(400, 'audioRetention is day, week, month or always.');
              change.audioRetention = value.audioRetention;
            }
            if ('mainModel' in value || 'quickModel' in value) throw new HttpError(400, 'Choose AI models through setup, not settings.');
            if ('speechModelPath' in value) throw new HttpError(400, 'Choose a speech model through setup, not settings.');
            if (value.setupSeen !== undefined) {
              if (typeof value.setupSeen !== 'boolean') throw new HttpError(400, 'setupSeen is true or false.');
              change.setupSeen = value.setupSeen;
            }
            if (!Object.keys(change).length) throw new HttpError(400, 'Give boardModel, miniOpensItself, audioRetention or setupSeen.');
            // Saved one at a time, and applied only once saved: a failed save keeps the previous choice. Each change applies to
            // the settings as the save before it left them, so two changes made together both stay.
            await saveSettings(change);
            void audioRetention.run();
          } else if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
          send(res, 200, { ...settings, boardModels: (['quick', 'main'] as const).map(id => ({ id, model: ai.current(id) })), aiMode: ai.mode(), aiForcedOff: !cloud, boardEnabled: ai.mode() === 'cloud' && (boardGates || options.board != null) }); return;
        }
        if (url.pathname === '/api/audio-retention') {
          if (req.method === 'POST') {
            const value = await json(req);
            if (value.answer !== 'remove' && value.answer !== 'keep') throw new HttpError(400, 'Answer remove or keep.');
            audioRetention.answer(value.answer);
          } else if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
          send(res, 200, { notice: audioRetention.notice }); return;
        }
        if (url.pathname === '/api/live' && req.method === 'GET') { send(res, 200, await liveModel(url.searchParams.get('have'))); return; }
        if (url.pathname === '/api/live/window' && req.method === 'GET') {
          // The helper, twice a second: whether its window should show.
          liveView.helperSeen();
          const now = recordingNow();
          send(res, 200, { show: Boolean(now) && liveView.miniState() === 'open', meetingId: now?.meetingId ?? null, session: now ? liveView.sessionId() : null }); return;
        }
        if (url.pathname.startsWith('/api/live/') && req.method === 'POST') {
          const value = await json(req);
          const now = recordingNow();
          const action = url.pathname.slice('/api/live/'.length);
          // Only for the recording now: a request about an earlier one, which may arrive late, does nothing.
          const current = Boolean(now) && liveView.current(value);
          if (action === 'stop') { if (current) liveView.stop(now!.sources.map(s => s.source)); send(res, 200, { stopping: current }); return; }
          if (action === 'reveal') {
            if (typeof value.meetingId !== 'string' || typeof value.cardId !== 'string') throw new HttpError(400, 'Give meetingId and cardId.');
            liveView.reveal(value.meetingId, value.cardId); send(res, 200, { revealed: true }); return;
          }
          if (action === 'mini') {
            if (!['away', 'open', 'closed'].includes(value.action)) throw new HttpError(400, 'action is away, open or closed.');
            // Leaving the app opens the window by itself only when the user turned that on in Settings; by default only the
            // app's Mini view button opens it.
            if (current && (value.action !== 'away' || settings.miniOpensItself)) liveView.mini(value.action as MiniAction);
            send(res, 200, { state: liveView.miniState() }); return;
          }
          throw new HttpError(404, 'Not found.');
        }
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          if (!canRestart) { send(res, 409, { error: 'Restart from Terminal' }); return; }
          if (working()) { send(res, 409, { error: 'Busy' }); return; }
          restarting = true; // Before 202 and before the response is flushed: another page cannot start new work.
          res.once('finish', () => { void app.shutdown().then(() => (options.exit ?? process.exit)(0)); });
          send(res, 202, { restarting: true }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const ready = fingerprint.ready();
          send(res, 200, { update: { ready, canRestart }, working: working(), config: speechSetup.runningConfig, meetings: appStore.meetings(), recording: capture.recording(), recordingAnywhere: recordingAnywhere(), shuttingDown, audioRetentionNotice: audioRetention.notice,
            queued: appStore.queuedCount(), transcriptionStorageError: appJobs.storageError, sttBackend: switchable ? switchable.backend : modelAvailable() ? 'test adapter' : 'unavailable',
            ai: ai.status(),
            capabilities: { microphone: true, systemAudio: false, cloudModels: ai.mode() !== 'off' && Boolean(quick), mainModel: ai.current('main'), correctionModel: quick ? ai.currentCorrection() : null, notesModel: notesRunner ? ai.current('main') : null, actionModel: actionRunner ? ai.current('main') : null, quickModel: quick ? ai.current('quick') : null, heavyModel: heavy ? ai.current('main') : null, participationScheduler: false, pdfExtraction: false },
          }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/meetings') {
          const value = await json(req);
          const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 120) : 'Untitled meeting';
          const projectId = typeof value.projectId === 'string' ? value.projectId : null;
          if (projectId) projects.get(projectId);
          const created = appStore.createMeeting(title);
          if (projectId) {
            projects.move(created.id, projectId, []);
            // A new meeting of the project: look for work finished in the repo since the last check (waits for an OK).
            if (projects.get(projectId).repoPath && tellRunner) files.finishedWork(projectId).then(() => changed(projectId), error => console.warn(`Repo check: ${(error as Error).message}`));
          }
          send(res, 201, { ...appStore.meeting(created.id) }); return;
        }
        if (url.pathname === '/api/projects') {
          if (req.method === 'GET') { send(res, 200, { projects: projects.list() }); return; }
          if (req.method === 'POST') {
            const value = await json(req);
            const repoPath = typeof value.repoPath === 'string' && value.repoPath.trim() ? value.repoPath.trim() : null;
            if (typeof value.fromMeetingId === 'string') {
              try { appStore.meeting(value.fromMeetingId); } catch { throw new HttpError(404, 'Meeting not found.'); }
              send(res, 201, await projects.createFromMeeting(value.fromMeetingId, value.name, repoPath, () => busy(value.fromMeetingId))); return;
            }
            send(res, 201, await projects.create(value.name, repoPath)); return;
          }
          throw new HttpError(405, 'Method not allowed.');
        }
        const memoryRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/(memory|memory\/undo|brief|tell|tell\/apply|files\/sync|repo\/check|captures\/[a-f0-9-]{36}\/dismiss|proposals|commits|proposals\/(?:accept-all|reject-all)|proposals\/([a-f0-9-]{36})\/(accept|reject|reopen)|memory\/items\/([TDQ]-\d+)|inbox\/([a-f0-9]{64})\/(retry|dismiss))$/);
        if (memoryRoute) {
          const [, projectId, part, proposalId, verb, itemId, inboxHash, inboxVerb] = memoryRoute;
          projects.get(projectId);
          if (req.method === 'GET' && part === 'memory') {
            // Opening the Project tab reads outside edits and agents' notes, at most every 30 s (the file watcher covers the rest).
            if (clock() - (lastOpened.get(projectId) ?? 0) > 30_000) { lastOpened.set(projectId, clock()); files.touch(projectId, 0); }
            // Per item, for the Project tab: the meetings it came from, its unconfirmed "raised again" links, and the batch that made it (Undo).
            const info: Record<string, { meetings: string[]; unconfirmed: { event: string; batch: string; at: number; meetingId: string | null }[]; created: string | null; createdIn: string | null; createdUndone: boolean }> = {};
            for (const e of memory.events(projectId)) {
              const entry = info[e.item] ??= { meetings: [], unconfirmed: [], created: null, createdIn: null, createdUndone: false };
              if (e.source?.kind === 'meeting' && !e.undone && !entry.meetings.includes(e.source.meetingId)) entry.meetings.push(e.source.meetingId);
              if (e.op === 'create') { entry.created = e.batch; entry.createdIn = e.source?.kind === 'meeting' ? e.source.meetingId : null; entry.createdUndone = e.undone; }
              if (e.op === 'addSource' && !e.confirmed && !e.undone) entry.unconfirmed.push({ event: e.id, batch: e.batch, at: e.at, meetingId: e.source?.kind === 'meeting' ? e.source.meetingId : null });
              if (e.op === 'confirm' && e.ref) entry.unconfirmed = entry.unconfirmed.filter(u => u.event !== e.ref);
            }
            // The user's own changes of the last 15 s (not Accepts, which have their row's Undo), so a reload keeps their Undo.
            const accepted = new Set((appStore.db.prepare("SELECT batch FROM memory_proposals WHERE project=? AND batch IS NOT NULL").all(projectId) as { batch: string }[]).map(r => r.batch));
            send(res, 200, { items: memory.items(projectId), info, brief: memory.brief(projectId), proposals: proposals.list(projectId), files: files.state(projectId),
              captures: files.pendingCaptures(projectId), inbox: files.inboxNotices(projectId), stamp: memoryStamp(projectId),
              recent: memory.recentUserChanges(projectId, clock() - 15_000, accepted) }); return;
          }
          if (req.method === 'POST' && part === 'files/sync') { send(res, 200, await files.sync(projectId)); return; }
          if (req.method === 'POST' && part === 'repo/check') { const result = await files.finishedWork(projectId); changed(projectId); send(res, 200, result); return; }
          if (req.method === 'POST' && part.startsWith('captures/')) { files.dismissCapture(projectId, part.split('/')[1]); changed(projectId); send(res, 200, { dismissed: true }); return; }
          if (req.method === 'POST' && inboxHash) {
            if (inboxVerb === 'dismiss') files.dismissInbox(projectId, inboxHash); else { files.retryInbox(projectId, inboxHash); await files.sync(projectId); }
            send(res, 200, { inbox: files.inboxNotices(projectId) }); return;
          }
          if (req.method === 'GET' && itemId) {
            const item = memory.item(projectId, itemId);
            if (!item) throw new HttpError(404, 'No such item.');
            send(res, 200, { item, timeline: memory.timeline(projectId, itemId) }); return;
          }
          // The user's own changes in the app: recorded as the user's, confirmed, with the version check and a request id.
          if (req.method === 'POST' && part === 'memory') {
            const value = await json(req);
            if (!Array.isArray(value.changes)) throw new HttpError(400, 'Give a list of changes.');
            const changes = (value.changes as Change[]).map(c => c.op === 'confirm' ? c : { ...c, source: { kind: 'app' as const } }) as Change[];
            const result = memory.apply(projectId, { requestId: String(value.requestId ?? ''), actor: 'user', changes, expect: value.expect });
            changed(projectId);
            send(res, 200, result); return;
          }
          if (req.method === 'POST' && part === 'memory/undo') {
            const value = await json(req);
            // One transaction: an accepted proposal that is undone waits for an OK again.
            const result = transaction(appStore.db, () => {
              const undone = memory.undo(projectId, String(value.batch ?? ''), String(value.requestId ?? ''));
              return { ...undone, ...proposals.undone(projectId, String(value.batch)) };
            });
            changed(projectId);
            send(res, 200, result); return;
          }
          // The repo's recent commits, for "Source" on changes that came without one (read-only git log).
          if (req.method === 'GET' && part === 'commits') {
            const repo = projects.get(projectId).repoPath;
            send(res, 200, { commits: repo ? (await recentCommits(repo, 20).catch(() => [])).map(c => ({ hash: c.hash, subject: c.subject, at: c.at })) : [] }); return;
          }
          if (req.method === 'GET' && part === 'proposals') { send(res, 200, { proposals: proposals.list(projectId) }); return; }
          if (req.method === 'POST' && part === 'proposals/accept-all') {
            const value = await json(req);
            if (!Array.isArray(value.items) || !value.items.length) throw new HttpError(400, 'Give the proposals to accept.');
            const items = [];
            for (const i of value.items) items.push({ id: String(i.id), expect: i.expect, source: await acceptSource(projectId, i.source) });
            const batches = proposals.acceptAll(projectId, items, String(value.requestId ?? ''));
            changed(projectId);
            send(res, 200, { batches }); return;
          }
          if (req.method === 'POST' && part === 'proposals/reject-all') {
            const value = await json(req);
            if (!Array.isArray(value.ids) || !value.ids.length) throw new HttpError(400, 'Give the proposals to reject.');
            proposals.rejectAll(projectId, value.ids.map(String));
            changed(projectId);
            send(res, 200, { rejected: value.ids.length }); return;
          }
          if (req.method === 'POST' && proposalId) {
            const value = await json(req);
            if (verb === 'accept') {
              const result = proposals.accept(projectId, proposalId, { requestId: String(value.requestId ?? ''), changes: value.changes, expect: value.expect, source: await acceptSource(projectId, value.source) });
              changed(projectId);
              send(res, 200, result); return;
            }
            if (verb === 'reject') proposals.reject(projectId, proposalId); else proposals.reopen(projectId, proposalId);
            changed(projectId);
            send(res, 200, { proposal: proposals.get(projectId, proposalId) }); return;
          }
          if (req.method === 'POST' && part === 'tell') {
            if (!tellRunner) throw new HttpError(400, 'AI models are disabled (MEETING_CLOUD=0).');
            const value = await json(req);
            send(res, 200, await proposals.interpret(projectId, value.text, tellRunner)); return;
          }
          // Applying "Tell the project…": the user's own words, recorded as theirs with the sentence as the source.
          if (req.method === 'POST' && part === 'tell/apply') {
            const value = await json(req);
            const text = String(value.text ?? '').trim().slice(0, 1000);
            if (!text || !Array.isArray(value.changes)) throw new HttpError(400, 'Give the sentence and the changes to apply.');
            const changes = (value.changes as Change[]).map(c => c.op === 'confirm' ? c : { ...c, ...(c.op === 'create' || c.op === 'addSource' ? { confirmed: true } : {}), source: { kind: 'chat' as const, text } }) as Change[];
            const result = memory.apply(projectId, { requestId: String(value.requestId ?? ''), actor: 'user', changes, expect: value.expect });
            changed(projectId);
            send(res, 200, result); return;
          }
          if (req.method === 'GET' && part === 'brief') { send(res, 200, { brief: memory.brief(projectId), versions: memory.briefVersions(projectId) }); return; }
          if (req.method === 'PUT' && part === 'brief') {
            const value = await json(req);
            // Undo and "Use this one" bring back an earlier version as it was, with its own author (an AI text stays labelled AI).
            const brief = typeof value.restore === 'number' ? memory.restoreBrief(projectId, value.restore, value.basedOn ?? null)
              : memory.saveBrief(projectId, String(value.text ?? ''), 'user', { kind: 'app' }, value.basedOn ?? null);
            changed(projectId);
            send(res, 200, brief); return;
          }
          throw new HttpError(405, 'Method not allowed.');
        }
        const projectRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})$/);
        if (projectRoute && req.method === 'PATCH') {
          const value = await json(req);
          const project = await projects.update(projectRoute[1], { name: value.name, repoPath: value.repoPath === undefined ? undefined : value.repoPath || null, planAfterNotes: value.planAfterNotes });
          // Turning "Plan after the notes" off cancels only the waiting automatic runs; a running one and the user's own go on.
          if (value.planAfterNotes === false) await planJobs.settingOff(project.id);
          send(res, 200, project); return;
        }
        const match = url.pathname.match(/^\/api\/meetings\/([a-f0-9-]{36})(?:\/(.+))?$/);
        if (!match) throw new HttpError(404, 'Not found.');
        const [, meetingId, action] = match;
        try { appStore.meeting(meetingId); } catch { throw new HttpError(404, 'Meeting not found.'); }
        if (req.method === 'GET' && action === 'audio') {
          await serveMeetingAudio(req, res, appStore, meetingId, url.searchParams.get('metadata') === '1', recordingAnywhere()); return;
        }
        if (req.method === 'GET' && !action) {
          const chunks = appStore.chunks(meetingId).map(({ path: _path, hash: _hash, ...chunk }) => chunk);
          const projectId = projects.projectOf(meetingId);
          send(res, 200, { meeting: appStore.meeting(meetingId), chunks, audioEndMs: appStore.audioEndMs(meetingId), sourceSettings: appStore.sourceSettings(meetingId),
            project: projectId ? projects.get(projectId) : null, materials: rootsFor(meetingId),
            // Changes whenever the project's memory or what waits for an OK does, so the badge and pills update without the tab open.
            memoryStamp: projectId ? `${memoryStamp(projectId)}:${proposals.run(meetingId)?.id ?? ''}:${proposals.run(meetingId)?.state ?? ''}` : null }); return;
        }
        if (req.method === 'POST' && action === 'memory/update') { send(res, 202, await proposals.start(meetingId)); return; }
        if (req.method === 'GET' && action === 'memory/run') { send(res, 200, { run: proposals.run(meetingId), enabled: proposals.enabled }); return; }
        if (req.method === 'POST' && action === 'project') {
          const value = await json(req);
          const projectId = value.projectId === null ? null : typeof value.projectId === 'string' ? value.projectId : undefined;
          if (projectId === undefined) throw new HttpError(400, 'Give a projectId, or null for no project.');
          projects.move(meetingId, projectId, busy(meetingId), { useMeetingGlossary: value.useMeetingGlossary === true, also: () => proposals.withdrawMeeting(meetingId) });
          if (projectId) files.touch(projectId);
          send(res, 200, { project: projectId ? projects.get(projectId) : null }); return;
        }
        if (req.method === 'PATCH' && !action) {
          const value = await json(req);
          // A rename: { title } alone.
          if (value.title !== undefined && value.mode === undefined) {
            const title = typeof value.title === 'string' ? value.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) : '';
            if (!title) throw new HttpError(400, 'A meeting needs a name.');
            appStore.rename(meetingId, title);
            send(res, 200, appStore.meeting(meetingId)); return;
          }
          if (!['periodic', 'manual', 'questions'].includes(value.mode)) throw new HttpError(400, 'Unknown participation mode.');
          const interval = numberInRange(value.intervalSeconds, 15, 600, 'Interval');
          appStore.updateMode(meetingId, value.mode as Mode, Math.round(interval));
          send(res, 200, appStore.meeting(meetingId)); return;
        }
        if (req.method === 'GET' && (action === 'transcript.md' || action === 'transcript.txt')) {
          const plain = action === 'transcript.txt';
          const raw = !plain && url.searchParams.get('mode') === 'raw';
          const suffix = plain ? 'transcript.txt' : raw ? 'transcript (raw).md' : 'transcript.md';
          res.writeHead(200, { 'Content-Type': `${plain ? 'text/plain' : 'text/markdown'}; charset=utf-8`,
            'Content-Disposition': downloadDisposition(appStore.meeting(meetingId).title, suffix) });
          let locale: string | undefined;
          try { locale = Intl.getCanonicalLocales(req.headers['accept-language']?.split(',')[0].split(';')[0] ?? [])[0]; } catch { /* use the Mac's locale */ }
          res.end(plain ? appStore.plainText(meetingId) : appStore.markdown(meetingId, raw ? 'raw' : 'corrected', locale)); return;
        }
        if (req.method === 'GET' && action === 'segments') {
          // Only the transcript list is a delta; all live state still travels on every poll.
          const { labelled, visible, speaker } = labelledLines(meetingId);
          const segments = visible.map(s => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text, originalText: s.originalText, edits: JSON.parse(s.edits),
            revision: s.revision, timing: s.timing, ...(labelled ? { source: s.source, speaker: speaker(s.source, s.startMs, s.endMs) } : {}) }));
          const delta = segmentsTag.delta(meetingId, segments, url.searchParams.get('have'));
          const replay = appStore.replay(meetingId);
          const now = clock();
          const glossary = projects.glossaryFor(meetingId);
          // Preserve the base segments wire response; the current UI translates its legacy disabled-runner hint to AI.
          const canBuild = options.heavy === undefined && ai.mode() === 'off' ? 'AI is off. Change it in AI settings.' : !heavy ? 'Needs cloud models (they are off).' : !rootsFor(meetingId).length ? 'Attach materials first.' : null;
          send(res, 200, {
            meetingId,
            captureGaps: appStore.captureGaps(meetingId),
            replay: replay ? { speed: replay.speed, positionMs: appStore.replayPositionMs(replay, now), durationMs: replay.durationMs, baseMs: replay.baseMs } : null,
            // Active recognizers and sealed display previews have separate lifetimes.
            ...displayPreviews(meetingId, visible, speaker),
            draftsAvailable: drafts?.available() ?? false,
            // Sources recording now, and whether each has been quiet for a minute (problem notices in the app and the mini view).
            sources: capture.liveSources(meetingId),
            // A quit has begun (the launcher's Quit, or SIGTERM): a recording page stops as if Stop were clicked.
            shuttingDown,
            // The mini view's state, the recording's problems (for the live chip) and a card asked for from the mini view.
            ...(() => {
              const now = recordingNow();
              const mine = now?.meetingId === meetingId;
              return { notices: mine ? liveView.notices(now.sources) : [], stopSources: mine ? liveView.stopped() : [],
                mini: { native: liveView.native(), state: liveView.miniState(), session: mine ? liveView.sessionId() : null, opensItself: settings.miniOpensItself },
                reveal: liveView.revealFor(meetingId) };
            })(),
            // Online meetings: speaker per line ("Me"/"Them", or null for unlabelled audio) and per draft source, in one fixed order.
            labelled,
            ...delta,
            correction: { enabled: Boolean(corrector) && (options.quick !== undefined || ai.mode() !== 'off'), canBuild, glossary: glossary ? { version: glossary.version, origin: glossary.origin, terms: glossary.terms.length } : null,
              building: building.get(projects.scope(meetingId).glossaryScope) ?? null, state: corrector?.state(meetingId) ?? null },
          }); return;
        }
        if (req.method === 'POST' && action === 'notes') {
          if (options.notes === undefined && ai.mode() === 'off') throw new HttpError(409, 'AI is off. Change it in AI settings.');
          try { await notesJobs.start(meetingId); }
          catch (error) { throw new HttpError((error as { status?: number }).status ?? 500, (error as Error).message); }
          send(res, 202, { started: true }); return;
        }
        if (req.method === 'POST' && action === 'notes/cancel') {
          const value = await json(req);
          send(res, 200, await notesJobs.cancel(meetingId, value?.jobId)); return;
        }
        if (req.method === 'GET' && action === 'notes') {
          send(res, 200, { ...(await notesJobs.status(meetingId)), enabled: notesJobs.enabled && (options.notes !== undefined || ai.mode() !== 'off') }); return;
        }
        if (req.method === 'GET' && action === 'notes.md') {
          const status = await notesJobs.status(meetingId);
          if (!status.notes) throw new HttpError(404, 'No notes yet.');
          // The UI asks for the version it shows, so an export never silently carries different notes.
          const version = url.searchParams.get('version');
          if (version !== null && Number(version) !== status.notes.version) throw new HttpError(409, `These notes changed (now v${status.notes.version}); reload the Notes tab.`);
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': downloadDisposition(appStore.meeting(meetingId).title, 'notes.md') });
          res.end(notesMarkdown(status.notes, status.stale, status.coverage)); return;
        }
        if (req.method === 'GET' && action === 'actions') {
          send(res, 200, { jobs: actionJobs.list(meetingId), enabled: actionJobs.enabled && (options.actions !== undefined || ai.mode() !== 'off'), pausedUntil: actionJobs.paused(), web: ai.web,
            materials: rootsFor(meetingId).length > 0 }); return;
        }
        if (req.method === 'POST' && action === 'actions') {
          if (options.actions === undefined && ai.mode() === 'off') throw new HttpError(409, 'AI is off. Change it in AI settings.');
          const value = await json(req);
          // "Ask about this" / "Look into it" on a board card bind the job to that card (M4 decision 7).
          const bound = typeof value.cardId === 'string' && await boards.hasCard(meetingId, value.cardId) ? { origin: 'card' as const, cardId: value.cardId } : { origin: 'user' as const, cardId: undefined };
          try {
            // Card-bound selection actions cannot bypass the Board's revision guard (including Ask about this / Look into it).
            const selection = bound.cardId && !value.parentId && !value.retryOf ? await boards.selection(meetingId, bound.cardId) : value.selection;
            const { job, merged } = await actionJobs.submit(meetingId, { ...value, ...bound, selection }); send(res, merged ? 200 : 202, { job, merged });
          }
          catch (error) { throw new HttpError((error as { status?: number }).status ?? 500, (error as Error).message); }
          return;
        }
        const actionRoute = action?.match(/^actions\/([a-f0-9-]{36})\/(cancel|retry)$/);
        if (req.method === 'POST' && actionRoute) {
          try {
            if (actionRoute[2] === 'cancel') send(res, 200, { job: await actionJobs.cancel(meetingId, actionRoute[1]) });
            else { const { job } = await actionJobs.submit(meetingId, { retryOf: actionRoute[1] }); send(res, 202, { job }); }
          } catch (error) { throw new HttpError((error as { status?: number }).status ?? 500, (error as Error).message); }
          return;
        }
        // Plans (M7b): the page's view, Plan / Plan again, Cancel, Add to to-dos and its Undo, and Explore further.
        if (req.method === 'GET' && action === 'plans') { const page = await planJobs.page(meetingId); send(res, 200, { ...page, enabled: page.enabled && (options.plans !== undefined || ai.mode() !== 'off') }); return; }
        if (req.method === 'GET' && action === 'plans/runs') { send(res, 200, planJobs.submission(meetingId, url.searchParams.get('opId'))); return; }
        if (req.method === 'POST' && action === 'plans/runs') {
          if (options.plans === undefined && ai.mode() === 'off') throw new HttpError(409, 'AI is off. Change it in AI settings.');
          const started = await planJobs.start(meetingId, await json(req));
          send(res, started.replayed ? 200 : 202, started); return;
        }
        const planRunRoute = action?.match(/^plans\/runs\/([a-f0-9-]{36})\/cancel$/);
        if (req.method === 'POST' && planRunRoute) { send(res, 200, await planJobs.cancel(meetingId, planRunRoute[1])); return; }
        const planRoute = action?.match(/^plans\/(\d{1,6})\/(?:steps\/(p\d{1,2}\.s\d{1,2})\/(todo|undo)|plans\/(p\d{1,2})\/explore)$/);
        if (req.method === 'POST' && planRoute) {
          const [, version, step, verb, plan] = planRoute;
          const value = await json(req);
          if (plan) { const started = await planJobs.explore(meetingId, Number(version), plan, value); send(res, started.replayed ? 200 : 202, started); return; }
          send(res, 200, verb === 'todo' ? await planJobs.add(meetingId, Number(version), step, value) : await planJobs.undo(meetingId, Number(version), step, value)); return;
        }
        if (req.method === 'GET' && action === 'board') { const board = await boards.status(meetingId); send(res, 200, { ...board, enabled: board.enabled && (options.board !== undefined || ai.mode() !== 'off') }); return; }
        if (req.method === 'POST' && action === 'board/scan') {
          if (options.board === undefined && ai.mode() === 'off') throw new HttpError(409, 'AI is off. Change it in AI settings.');
          if (!boards.enabled) throw new HttpError(400, 'AI models are disabled (MEETING_CLOUD=0).');
          if (ai.mode() === 'local' && recordingAnywhere()) throw new HttpError(409, 'The local Board waits until recording stops.');
          try { await boards.scanAll(meetingId); }
          catch (error) { throw new HttpError((error as { status?: number }).status ?? 500, (error as Error).message); }
          boardActive.add(meetingId); // keeps scanning until the backlog is covered
          send(res, 202, { started: true }); return;
        }
        if (req.method === 'PUT' && action === 'board/preset') {
          const value = await json(req);
          if (value.preset !== 'discussion' && value.preset !== 'lecture') throw new HttpError(400, 'Preset is discussion or lecture.');
          send(res, 200, { preset: await boards.setPreset(meetingId, value.preset) }); return;
        }
        const cardRoute = action?.match(/^board\/cards\/([a-f0-9-]{36})\/(investigate|dismiss|restore)$/);
        if (req.method === 'POST' && cardRoute) {
          try {
            if (cardRoute[2] === 'investigate') send(res, 202, { job: await boards.investigate(meetingId, cardRoute[1]) });
            else send(res, 200, { card: await boards.setDismissed(meetingId, cardRoute[1], cardRoute[2] === 'dismiss') });
          } catch (error) { throw new HttpError((error as { status?: number }).status ?? 500, (error as Error).message); }
          return;
        }
        if (req.method === 'GET' && action === 'materials/preview') {
          const p = url.searchParams;
          try { send(res, 200, await actionJobs.preview(meetingId, p.get('rootId') ?? '', p.get('path') ?? '', Number(p.get('from')), Number(p.get('to')))); }
          catch (error) { throw new HttpError((error as { status?: number }).status ?? 404, (error as Error).message); }
          return;
        }
        if (req.method === 'POST' && action === 'replay') {
          const value = await json(req);
          const speed = numberInRange(value.speed ?? 1, 1, 16, 'Speed');
          const sources = [...new Set(appStore.chunks(meetingId).map(c => c.source))];
          if (sources.length !== 1 || !sources[0].startsWith('file:')) throw new HttpError(400, 'Replay needs a meeting with exactly one imported file.');
          boardActive.add(meetingId);
          send(res, 200, appStore.startReplay(meetingId, sources[0], speed, clock())); return;
        }
        if (req.method === 'GET' && action === 'glossary') {
          const scope = projects.scope(meetingId).glossaryScope;
          send(res, 200, { glossary: projects.glossary(scope), scope: scope.startsWith('project:') ? 'project' : 'meeting', building: building.get(scope) ?? null }); return;
        }
        if (req.method === 'PUT' && action === 'glossary') {
          const value = await json(req);
          send(res, 200, projects.saveGlossary(projects.scope(meetingId).glossaryScope, cleanGlossary(value), 'user')); return;
        }
        if (req.method === 'POST' && action === 'glossary/build') {
          if (options.heavy === undefined && ai.mode() === 'off') throw new HttpError(409, 'AI is off. Change it in AI settings.');
          if (!heavy) throw new HttpError(400, 'AI models are disabled (MEETING_CLOUD=0).');
          if (!rootsFor(meetingId).length) throw new HttpError(400, 'Attach materials before building a glossary.');
          const scope = projects.scope(meetingId).glossaryScope;
          if (building.get(scope) && !building.get(scope)!.error) throw new HttpError(409, 'A glossary build is already running.');
          building.set(scope, { startedAt: clock() });
          const controller = new AbortController();
          const done = buildGlossary(meetingId, scope, controller.signal)
            .then(() => { building.delete(scope); }, error => { building.set(scope, { startedAt: clock(), error: (error as Error).message }); })
            .finally(() => { builds.delete(scope); });
          builds.set(scope, { controller, done });
          send(res, 202, { building: true }); return;
        }
        if (req.method === 'GET' && action === 'search') {
          const query = (url.searchParams.get('q') ?? '').trim();
          if (query.length < 2 || query.length > 200) throw new HttpError(400, 'Search needs 2–200 characters.');
          send(res, 200, await searchRoots(rootsFor(meetingId), query, pdfText)); return;
        }
        if (req.method === 'POST' && action === 'materials') {
          const value = await json(req);
          if (typeof value.path !== 'string' || !value.path.trim()) throw new HttpError(400, 'Provide a file/folder path.');
          // "This project" materials by default when the meeting has a project; "This meeting" adds the meeting's own.
          const projectId = projects.projectOf(meetingId);
          const scope = value.scope === 'meeting' || !projectId ? meetingScope(meetingId) : projectScope(projectId);
          if (value.scope === 'project' && !projectId) throw new HttpError(400, 'This meeting is not in a project.');
          const root = await projects.addRoot(scope, value.path.trim());
          pdfText.warm([root]);
          send(res, 201, root); return;
        }
        if (req.method === 'DELETE' && action?.startsWith('materials/')) {
          projects.removeRoot(meetingId, action.slice('materials/'.length)); send(res, 200, { removed: true }); return;
        }
        if (req.method === 'POST' && action === 'retry') {
          appStore.assertAudioAvailable(meetingId);
          if (!modelAvailable()) throw new HttpError(400, 'No local model is available.');
          for (const chunk of appStore.chunks(meetingId)) if (chunk.status === 'failed') appStore.retryChunk(chunk.id);
          appJobs.kick(); send(res, 200, { queued: appStore.queuedCount() }); return;
        }
        if (req.method === 'POST' && action === 'pcm') {
          if (!modelAvailable()) throw new HttpError(400, 'No local model is available.');
          if (appStore.queuedCount() >= 1000) throw new HttpError(429, 'The transcription queue is full. Stop recording and wait for processing.');
          const source = String(req.headers['x-audio-source'] ?? '');
          if (!/^(mic|tab):[a-f0-9-]{36}$/.test(source)) throw new HttpError(400, 'Invalid audio source ID.');
          const sequence = numberInRange(req.headers['x-sequence'], 0, 1_000_000, 'Sequence');
          const sampleRate = numberInRange(req.headers['x-sample-rate'], 8000, 96000, 'Sample rate');
          const startMs = numberInRange(req.headers['x-start-ms'], 0, 8 * 3600 * 1000, 'Audio start');
          if (!Number.isInteger(sequence) || !Number.isInteger(sampleRate)) throw new HttpError(400, 'Sequence and sample rate must be integers.');
          if (sampleRate !== 16000) throw new HttpError(400, 'Live audio must be 16 kHz mono.');
          // Protect in-flight bodies without reopening a source or clearing completion before validation/admission.
          receivingPcm.set(meetingId, (receivingPcm.get(meetingId) ?? 0) + 1);
          releasePcm = () => {
            const remaining = (receivingPcm.get(meetingId) ?? 1) - 1;
            if (remaining) receivingPcm.set(meetingId, remaining); else receivingPcm.delete(meetingId);
          };
          if (ai.mode() === 'local') { if (quick instanceof ModelRpc) quick.interrupt(); gate?.interrupt(); }
          const pcm = await body(req, 4 * 16000);
          if (!pcm.length || pcm.length % 4) throw new HttpError(400, 'A live frame holds at most 1 second of float32 audio.');
          for (let index = 0; index < pcm.length; index += 4) {
            const sample = pcm.readFloatLE(index);
            if (!Number.isFinite(sample) || Math.abs(sample) > 10) throw new HttpError(400, 'Invalid PCM sample.');
          }
          // A frame may update how the source is captured (for example, echo cancellation after adding a tab).
          const declared = String(req.headers['x-capture-settings'] ?? '');
          if (declared) {
            let parsed: unknown;
            try { parsed = JSON.parse(declared); } catch { throw new HttpError(400, 'Capture settings must be JSON.'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || declared.length > 600) throw new HttpError(400, 'Capture settings must be a small object.');
            const clean = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([k, v]) => /^[a-zA-Z]{1,40}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v]));
            try { appStore.setSourceSettings(meetingId, source, clean); }
            catch (error) { throw new HttpError(503, (error as Error).message); }
          }
          // Optional metadata only: old pages still send exactly the same PCM body and need no capture clock.
          const captureWallMs = Number(req.headers['x-capture-wall-ms']);
          const fromWallMs = Number(req.headers['x-suspension-from']), toWallMs = Number(req.headers['x-suspension-to']);
          let discontinuities: unknown;
          const declaredDiscontinuities = String(req.headers['x-capture-discontinuities'] ?? '');
          try { if (declaredDiscontinuities.length <= 12000) discontinuities = JSON.parse(declaredDiscontinuities); } catch { /* optional metadata only */ }
          const timing = Number.isFinite(captureWallMs) && captureWallMs > 0 && captureWallMs < 8.64e15 ? { captureWallMs, discontinuities: captureDiscontinuities(discontinuities, pcm.length / 4),
            ...(Number.isFinite(fromWallMs) && Number.isFinite(toWallMs) && toWallMs >= fromWallMs
              ? { suspension: { fromWallMs, toWallMs } } : {}) } : undefined;
          let frame;
          try { frame = await capture.accept(meetingId, source, sequence, startMs, pcm, typeof pageId === 'string' && pageId.length <= 64 ? pageId : null, timing); }
          catch (error) { throw new HttpError(error instanceof CaptureConflict ? 409 : 503, (error as Error).message); }
          lastPcmAt.set(meetingId, clock());
          recording.set(meetingId, (recording.get(meetingId) ?? new Set()).add(source));
          boardActive.add(meetingId);
          const pending = Number(req.headers['x-pending']);
          const clockStart = Number(req.headers['x-clock-start']);
          const named = String(req.headers['x-recording'] ?? '');
          liveView.frame(source, /^[a-f0-9-]{36}$/.test(named) ? named : null, req.headers['x-pending'] !== undefined && Number.isInteger(pending) && pending >= 0 ? pending : null,
            req.headers['x-clock-start'] !== undefined && Number.isFinite(clockStart) ? clockStart : null);
          // A Stop asked from the mini view, and a quit, reach the page here: frames keep coming while a hidden page's timers are slowed.
          send(res, 201, { id: frame.id, sequence: frame.sequence, stop: liveView.stopFor(source), quit: shuttingDown }); return;
        }
        if (req.method === 'POST' && action === 'pcm/end') {
          const value = await json(req);
          const source = String(value.source ?? '');
          if (!/^(mic|tab):[a-f0-9-]{36}$/.test(source)) throw new HttpError(400, 'Invalid audio source ID.');
          const lastSequence = value.lastSequence === null ? null : numberInRange(value.lastSequence, 0, 1_000_000, 'Last sequence');
          let result;
          try { result = await capture.end(meetingId, source, lastSequence); }
          catch (error) { throw new HttpError(error instanceof CaptureConflict ? 409 : 503, (error as Error).message); }
          recording.get(meetingId)?.delete(source);
          if (!appStore.recordingUnended(meetingId)) appStore.recordingEnded(meetingId, clock());
          audioRetention.observe();
          liveView.ended(source, value.stopping === true);
          send(res, 200, result); return;
        }
        if (req.method === 'POST' && action === 'upload') {
          if (!speechSetup.ffmpeg.found) throw new HttpError(400, 'Importing audio/video files needs FFmpeg. Open Settings › This Mac › Setup to check FFmpeg. Recording and transcription do not need it.');
          if (!modelAvailable()) throw new HttpError(400, 'No local model is available.');
          if (uploading) throw new HttpError(409, 'Another audio file is uploading.');
          importing.add(meetingId);
          appStore.recordingStarted(meetingId);
          uploading = true;
          const path = join(directory, 'imports', `${randomUUID()}.media`);
          let accepted = false;
          try {
            await mkdir(dirname(path), { recursive: true });
            const file = await open(path, 'wx', 0o600);
            let bytes = 0;
            try {
              for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 256 * 1024 * 1024) throw new HttpError(413, 'Audio imports are limited to 256 MiB.');
                await file.writeFile(chunk);
              }
              await file.sync();
            } finally { await file.close(); }
            const duration = await probeDuration(path);
            if (appStore.queuedCount() + Math.ceil(duration / CHUNK_SECONDS) > 1000) throw new HttpError(429, 'Too much audio is queued; retry after processing.');
            const source = appStore.addMedia(meetingId, path, duration);
            accepted = true;
            appJobs.kick(); send(res, 201, { source, duration, chunkSeconds: CHUNK_SECONDS });
          } finally { uploading = false; importing.delete(meetingId); appStore.recordingEnded(meetingId, clock()); if (!accepted) await rm(path, { force: true }); }
          return;
        }
        throw new HttpError(404, 'Not found.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Module errors may carry an HTTP status (e.g. 409 from projects); anything else is a bad request.
        const status = error instanceof HttpError ? error.status : typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 400;
        // A refusal the page can act on also says which (`code`), and a generation conflict what the page should show now (`current`).
        // Only the app's own errors (they carry a status) say this; a system error's code stays out of it.
        const { code, current, status: own } = (error ?? {}) as { code?: unknown; current?: unknown; status?: unknown };
        const detail = typeof own === 'number' ? { ...(typeof code === 'string' ? { code } : {}), ...(current !== undefined ? { current } : {}) } : {};
        const plansError = /^\/api\/meetings\/[^/]+\/plans(?:\/|$)/.test(req.url ?? '');
        if (!res.headersSent && !res.destroyed) send(res, status, { error: message, ...detail,
          ...(plansError ? { status, code: typeof detail.code === 'string' ? detail.code : status === 404 ? 'not found' : status === 409 ? 'conflict' : 'bad request' } : {}) });
        else if (!res.destroyed) res.end();
      } finally { releasePcm?.(); if (admitted) admissions--; }
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? Number(process.env.PORT ?? 4318), '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Cannot determine the local server address.');
    origin = `http://127.0.0.1:${address.port}`;
    const app = {
      url: origin, directory, store: appStore, jobs: appJobs, audioRetention, capture,
      /** The explorations' runtime and the shared quota cooldown, and the plans made with them (tests). */
      explorations, cooldowns, plans: planJobs,
      /** What is running for a meeting, in words (a move waits for all of it). */
      busy,
      /**
       * A graceful quit: pages see `shuttingDown` and stop their recordings (uploads drain, sources end); after that, or after
       * `waitMs`, the server closes. A second call stops the waiting; the cleanup always completes.
       */
      async shutdown(waitMs = 20_000) {
        // A second request stops the waiting, never the cleanup: it gets the same close, which seals audio and ends workers.
        if (shuttingDown) { hurry = true; return app.close(); }
        shuttingDown = true;
        const until = Date.now() + waitMs;
        // A page polls about once a second; give it time to see the flag, then wait for its sources' ends (or the deadline).
        await new Promise(resolve => setTimeout(resolve, 2500));
        while (!hurry && capture.recording() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250));
        await app.close();
      },
      /** One close, whoever asks and however often: every caller waits for the same complete cleanup. */
      close() {
        closed ??= closeOnce();
        return closed;
      },
    };
    let hurry = false;
    let closed: Promise<void> | undefined;
    async function closeOnce() {
      closing = true;
      // Local scans/corrections waiting behind another job must defer before shutdown waits for their callers.
      const localRpcClosing = ai.mode() === 'local' ? Promise.all([quick instanceof ModelRpc ? quick.close() : undefined, gate?.close()]) : undefined;
      localRpcClosing?.catch(() => {}); // Observe now; propagate below after the Board's callers have stopped.
      if (localRpcClosing) { if (correctionLoop) clearInterval(correctionLoop); clearInterval(boardLoop); }
      keys.seal(); // A key request still arriving is refused; the keys leave the Pi environment once admitted ones have finished.
      const aiClosing = ai.close(); // Abort probes before waiting for HTTP handlers that may be awaiting those probes.
      speechSetup.stopSwitches();
      await speechSetup.download.close().catch(error => console.warn(`Could not close speech download: ${(error as Error).message}`));
      audioRetention.close();
      clearInterval(retentionLoop);
      clearInterval(idleLoop);
      // Requests in progress get 5 s to finish (an upload being saved); then their connections are closed.
      await new Promise<void>(resolve => {
        const force = setTimeout(() => server.closeAllConnections(), 5000);
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections();
      });
      for (const build of builds.values()) build.controller.abort();
      await Promise.allSettled([...builds.values()].map(build => build.done));
      if (correctionLoop) clearInterval(correctionLoop);
      clearInterval(sweep);
      // First, so that no waiting run is admitted as the jobs it waits for close; a running one is stopped (its process
      // groups ended) and keeps what it saved.
      await explorations.close();
      await capture.close(); // waits for saves and seals in progress, before the store closes
      // Unended recordings stay durable and get the reconnect/abandonment protocol on the next start.
      recording.clear();
      audioRetention.observe(true);
      await drafts?.close();
      await notesJobs.close();
      await proposals.close();
      await files.close();
      clearInterval(boardLoop);
      await boards.close();
      await localRpcClosing;
      await gate?.close();
      await aiClosing;
      await keys.close(); // after the HTTP drain: an admitted key request has finished (a later one was refused)
      await pdfText.close(); // waits for an extraction being stopped
      await actionJobs.close();
      await quick?.close?.();
      await appJobs?.close();
      // Restore process-global decoder settings only after the existing audio work has stopped.
      await speechSetup.close().catch(error => console.warn(`Could not close speech setup: ${(error as Error).message}`));
      await settingsWrite.catch(error => console.warn(`Could not save settings: ${(error as Error).message}`));
      audioRetention.observe(true); // persist completed meetings' stop time, without scheduling any deletion
      appStore.close();
      releasePiAdmission?.();
      await release();
    }
    void audioRetention.run();
    return app;
  } catch (error) {
    setup?.stopSwitches();
    await aiSetup?.close();
    await apiKeys?.close();
    await setup?.download.close().catch(error => console.warn(`Could not close speech download: ${(error as Error).message}`));
    retention?.close();
    clearInterval(retentionLoop);
    clearInterval(sweep);
    await live?.close();
    await drafts?.close();
    await jobs?.close();
    await setup?.close().catch(error => console.warn(`Could not close speech setup: ${(error as Error).message}`));
    store?.close();
    releasePiAdmission?.();
    await release();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Started by the installed app's helper: stop once its window has been gone for MEETING_IDLE_EXIT_S seconds and nothing runs.
  const idleSeconds = Number(process.env.MEETING_IDLE_EXIT_S ?? 0);
  const app = await startServer(idleSeconds > 0 ? { idleMs: idleSeconds * 1000, onIdle: () => { console.log('No window open and nothing running: stopping.'); void app.shutdown().then(() => process.exit(0)); } } : {}).catch(error => {
    if ((error as Error).message !== LEGACY_DATA_NOTICE) throw error;
    console.error(LEGACY_DATA_NOTICE);
    process.exit(1);
  });
  console.log(`HearAlong: ${app.url}\nData: ${app.directory}\nNo recording starts until you click Start microphone. No cloud model is connected.`);
  if (process.env.MEETING_OPEN_BROWSER === '1') {
    spawn('open', ['-a', 'Google Chrome', app.url], { stdio: 'ignore' }).on('error', error => console.warn(`Open ${app.url} manually: ${error.message}`));
  }
  // A quit lets a recording page stop first (up to 20 s); a second signal closes at once.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.shutdown().then(() => process.exit(0)); });
}
