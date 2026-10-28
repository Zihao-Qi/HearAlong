import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PI_TASK_LIMITS, piTaskArgs, runPiTask, type PiTaskError } from '../src/pi-task.ts';
import { endGroup, endLeftoverProcesses, endRecorded, processStart, spawnGated, type ProcessRecord } from '../pi-extensions/process-groups.ts';
import { Cooldowns } from '../src/quota.ts';
import { EXPLORATION_LIMITS, Explorations, STREAM_LIMITS, StreamLog, type ExplorationJob } from '../src/explorations.ts';
import { ActionJobs } from '../src/actions.ts';
import { NotesJobs } from '../src/notes.ts';
import { startServer } from '../src/server.ts';

// The runtime of the plan pass and Explore further (M7b §4), with fake Pi processes and fake scripts only: no model is called.
EXPLORATION_LIMITS.pollMs = 20;
EXPLORATION_LIMITS.stopGraceMs = 500;
PI_TASK_LIMITS.drainMs = 500;
PI_TASK_LIMITS.cleanupRetryMs = 50;
const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-task-pi.ts', import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-explore-server.ts', import.meta.url));
const NODE_TS = ['--experimental-strip-types', '--no-warnings'];
const fakePi = (mode: string, out = '') => ({ model: 'fake', command: process.execPath, args: [...NODE_TS, FAKE_PI, mode, out] });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, what = 'the condition', ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await sleep(20); }
}
/** A live process; a zombie (ended, not yet reaped) counts as gone. */
async function alive(pid: number) {
  try { process.kill(pid, 0); } catch { return false; }
  const stat = await new Promise<string>(resolve => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (error, out) => resolve(error ? '' : out.trim())));
  return stat !== '' && !stat.startsWith('Z');
}
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
type Pids = { pi: number; python: number; helper: number; recorded: boolean };
const gone = async (pids: Pids) => !(await alive(pids.pi)) && !(await alive(pids.python)) && !(await alive(pids.helper));
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-explore-'));
  return { directory, out: join(directory, 'out.json'), close: () => rm(directory, { recursive: true, force: true }) };
}
function gate() {
  let open!: (value?: unknown) => void;
  const opened = new Promise(resolve => { open = resolve; });
  return { opened, open };
}

test('a Pi task with a process folder: Pi is recorded before it starts and waits for its job to save it; the folder goes after', async () => {
  const s = await scratch();
  try {
    const processDir = join(s.directory, 'processes', 'task-1');
    const seen: ProcessRecord[] = [];
    const result = await runPiTask('x', { ...fakePi('answer', s.out), cwd: s.directory, processDir, onStart: async record => {
      seen.push(record);
      assert.ok(existsSync(join(processDir, `pi-${record.pid}.json`)), 'the record is on disk');
      await sleep(150);
      assert.equal(existsSync(s.out), false, 'Pi has not started while its job saves it');
    } });
    assert.equal(result.text, 'answer recorded=true', 'Pi found its own record when it started');
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].kind, seen[0].pgid], ['pi', seen[0].pid], 'the leader of a group of its own');
    assert.equal((await readJson(s.out)).pi, seen[0].pid, 'the recorded pid is Pi itself');
    assert.equal(existsSync(processDir), false);
  } finally { await s.close(); }
});

test('Cancel and the time limit end Pi\'s whole group and every recorded script group', async t => {
  for (const how of ['cancel', 'timeout'] as const) {
    const s = await scratch();
    const controller = new AbortController();
    let task: ReturnType<typeof runPiTask> | undefined;
    let expire: (() => void) | undefined;
    const realTimeout = globalThis.setTimeout;
    const timerMock = how === 'timeout' ? t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if (ms === 3000 && !expire) {
        expire = () => callback(...args);
        return realTimeout(callback, 60_000, ...args);
      }
      return realTimeout(callback, ms, ...args);
    }) : undefined;
    try {
      const processDir = join(s.directory, 'processes', 'task');
      task = runPiTask('x', { ...fakePi('python', s.out), cwd: s.directory, processDir, signal: controller.signal, timeoutMs: how === 'timeout' ? 3000 : 60_000 });
      await until(() => existsSync(s.out), 'the fake Pi to start its script', 30_000);
      const pids = await readJson(s.out) as Pids;
      for (const pid of [pids.pi, pids.python, pids.helper]) assert.ok(await alive(pid));
      assert.ok(existsSync(join(processDir, `python-${pids.python}.json`)), 'the script was recorded');
      if (how === 'cancel') controller.abort();
      else { assert.ok(expire); expire(); } // Expire only after all three processes are demonstrably alive.
      const error = await task.then(() => null, e => e as PiTaskError);
      assert.equal(error?.reason, how === 'cancel' ? 'cancelled' : 'timeout');
      await until(() => gone(pids), `${how}: Pi, its helper and its script to end`);
      assert.equal(existsSync(processDir), false);
    } finally {
      controller.abort(); await task?.catch(() => {});
      timerMock?.mock.restore(); await s.close();
    }
  }
});

test('Pi killed during a Python call: the script\'s group is ended once Pi\'s exit is seen', async () => {
  const s = await scratch();
  try {
    const processDir = join(s.directory, 'processes', 'task');
    const task = runPiTask('x', { ...fakePi('python', s.out), cwd: s.directory, processDir, timeoutMs: 60_000 });
    await until(() => existsSync(s.out), 'the fake Pi to start its script');
    const pids = await readJson(s.out) as Pids;
    process.kill(pids.pi, 'SIGKILL'); // no exit handler runs
    await assert.rejects(task, /failed/);
    await until(() => gone(pids), 'the script and the helper to end');
  } finally { await s.close(); }
});

test('a Pi task that cannot be recorded never starts', async () => {
  const s = await scratch();
  try {
    const processDir = join(s.directory, 'processes', 'task');
    await assert.rejects(runPiTask('x', { ...fakePi('answer', s.out), cwd: s.directory, processDir, onStart: () => { throw new Error('disk full'); } }), /disk full/);
    await sleep(300);
    assert.equal(existsSync(s.out), false, 'the fake Pi never ran');
    assert.equal(existsSync(processDir), false);
  } finally { await s.close(); }
});

test('a recorded group is ended only while it is still the process recorded (a reused pid is never killed)', async () => {
  const s = await scratch();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  try {
    await once(other, 'spawn');
    const pid = other.pid!;
    const started = await processStart(pid);
    assert.ok(started);
    const folder = join(s.directory, 'processes', 'old-task');
    await mkdir(folder, { recursive: true });
    // A record from an earlier run whose pid the system has since given to this unrelated process.
    await writeFile(join(folder, `python-${pid}.json`), JSON.stringify({ kind: 'python', pid, pgid: pid, started: 'Thu Jan  1 00:00:00 2026', recordedAt: 0 }));
    await writeFile(join(folder, 'broken.json'), '{');
    assert.equal(await endLeftoverProcesses(join(s.directory, 'processes')), 0);
    assert.ok(await alive(pid), 'not the recorded process: left alone');
    assert.equal(existsSync(folder), false, 'the leftover folder is cleared');
    assert.equal(await endGroup({ kind: 'python', pid, pgid: pid, started: started!, dir: folder, recordedAt: 0 }), true);
    await until(async () => !(await alive(pid)), 'the recorded process to end');
  } finally { try { process.kill(-other.pid!, 'SIGKILL'); } catch { /* ended */ } await s.close(); }
});

test('thinking level and skills are set per task; other tasks keep Pi\'s defaults', () => {
  const base = { model: 'm', cwd: '/tmp', tools: 'read' };
  assert.deepEqual(piTaskArgs('p', base), ['--mode', 'json', '--model', 'm', '--no-context-files', '--tools', 'read', '--no-session', '--', 'p']);
  const plan = piTaskArgs('p', { ...base, thinking: 'low', skills: false });
  assert.deepEqual(plan.slice(plan.indexOf('--thinking'), plan.indexOf('--thinking') + 2), ['--thinking', 'low']);
  assert.equal(plan.filter(a => a === '--no-skills').length, 1);
  assert.equal(piTaskArgs('p', { ...base, tools: null, skills: false }).filter(a => a === '--no-skills').length, 1, 'no tools already means no skills');
  assert.equal(piTaskArgs('p', { ...base, skills: true }).includes('--no-skills'), false);
});

test('the stream log: text and tool results saved in order as they arrive, bounded, read back, and marked at the end', async () => {
  const s = await scratch();
  try {
    const folder = join(s.directory, 'run');
    const log = new StreamLog(folder);
    await log.open();
    log.piEvent({ type: 'message_start', message: { role: 'assistant' } });
    log.piEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } });
    log.piEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } });
    log.piEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'fetch_content', args: { url: 'https://x.example' } });
    log.piEvent({ type: 'message_start', message: { role: 'assistant' } }); // a message with a tool call only: no blank line yet
    const tool = log.piEvent({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'fetch_content', isError: false,
      result: { content: [{ type: 'text', text: 'page text' }], structuredContent: { urls: [{ url: 'https://x.example', content: 'page text' }] } } });
    assert.equal(tool?.name, 'fetch_content');
    log.piEvent({ type: 'message_start', message: { role: 'assistant' } });
    log.piEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Second' } });
    for (let i = 0; i < 20; i++) log.appendEvent({ type: 'note', n: i });
    let saved = await log.read();
    assert.equal(saved.text, 'Hello world\n\nSecond');
    assert.deepEqual(saved.events.map(e => e.seq), Array.from({ length: 21 }, (_, i) => i + 1), 'in order');
    assert.deepEqual([saved.events[0].type, saved.events[0].name, saved.events[0].args, saved.events[0].text], ['tool', 'fetch_content', { url: 'https://x.example' }, 'page text']);
    assert.ok(saved.events[0].structured, 'the fetched page is kept for the checks');
    assert.equal(saved.state.state, 'streaming');

    log.appendText('é'.repeat(150_000)); // 300 KB
    log.appendEvent({ type: 'tool', name: 'fetch_content', text: 'y'.repeat(900_000), structured: { big: 'z'.repeat(900_000) }, details: { more: 1 } });
    saved = await log.read();
    assert.ok(Buffer.byteLength(saved.text) <= STREAM_LIMITS.textBytes && Buffer.byteLength(saved.text) > STREAM_LIMITS.textBytes - 2, 'text stops at 200 KB, on a whole character');
    assert.equal(log.state.textCut, true);
    const big = saved.events.at(-1)!;
    assert.equal(big.cut, true);
    assert.ok(Buffer.byteLength(JSON.stringify(big)) <= STREAM_LIMITS.eventBytes, 'one event stays within its bound');
    await log.stop('time limit');
    log.appendText('after the end');
    saved = await StreamLog.read(folder);
    assert.deepEqual([saved.state.state, saved.state.reason], ['stopped', 'time limit']);
    assert.equal(saved.text.endsWith('after the end'), false);

    // A crash: no final state, and a torn last line.
    const crashed = join(s.directory, 'crashed');
    await mkdir(crashed);
    await writeFile(join(crashed, 'text.md'), 'partial');
    await writeFile(join(crashed, 'events.jsonl'), '{"seq":1,"at":0,"type":"tool"}\n{"seq":2,"at"');
    const left = await StreamLog.read(crashed);
    assert.deepEqual([left.text, left.events.length, left.state.state, left.state.reason], ['partial', 1, 'stopped', 'crash']);
  } finally { await s.close(); }
});

test('the stream log after a failed write: the error is kept and nothing later is written, so what was saved stays in order', async () => {
  const s = await scratch();
  const folder = join(s.directory, 'run');
  try {
    const log = new StreamLog(folder);
    await log.open();
    await chmod(folder, 0o500);
    log.appendText('first');
    await log.flush();
    assert.match(log.state.error!, /Could not save the run's progress/);
    await chmod(folder, 0o700);
    log.appendText('second');
    log.appendEvent({ type: 'note' });
    await log.complete();
    const saved = await StreamLog.read(folder);
    assert.equal(saved.text, '', 'nothing after the failed write');
    assert.deepEqual(saved.events, []);
    assert.match(saved.state.error!, /progress/, 'the final state says so');
  } finally { await chmod(folder, 0o700).catch(() => {}); await s.close(); }
});

test('admission: one run at a time; it waits for a recording, the meeting\'s own work and the model\'s quota, and says so', async () => {
  const s = await scratch();
  let now = Date.now();
  const cooldowns = new Cooldowns(() => now);
  let recording: string | null = null;
  let own: string | null = null;
  const explorations = new Explorations({ directory: s.directory, clock: Date.now, cooldowns, recording: () => recording, meetingWork: () => own });
  try {
    const first = gate();
    const a = await explorations.submit('m1', { kind: 'plan', work: async () => { await first.opened; return { plans: 1 }; } });
    await until(() => explorations.get(a.id)!.state === 'running', 'the first run to start');
    const b = await explorations.submit('m2', { kind: 'plan', work: async () => 'second' });
    const reason = (job: ExplorationJob) => explorations.list(job.meetingId).find(j => j.id === job.id)!.waiting?.reason;
    assert.equal(reason(b), 'Waiting for another plan run to finish');
    assert.ok(explorations.busy('m2'), 'a waiting run counts as busy (a move waits for it)');
    await assert.rejects(explorations.submit('m1', { kind: 'plan', work: async () => null }), (e: Error & { status?: number }) => e.status === 409);
    first.open();
    await until(() => explorations.get(b.id)!.state === 'done', 'the second run, after the first');
    assert.deepEqual(explorations.get(a.id)!.result, { plans: 1 });
    assert.equal((await readJson(join(s.directory, 'explorations', 'm1', a.id, 'job.json'))).state, 'done', 'saved');

    recording = 'the recording to end';
    const c = await explorations.submit('m3', { kind: 'plan', work: async () => 'third' });
    assert.equal(reason(c), 'Waiting for the recording to end');
    recording = null;
    own = 'the notes';
    await sleep(60);
    assert.equal(reason(c), 'Waiting for the notes');
    own = null;
    cooldowns.hit('model', 'actions');
    await sleep(60);
    assert.match(reason(c)!, /^Waiting for the model's quota, until \d\d:\d\d$/);
    assert.equal(explorations.list('m3')[0].waiting?.until, cooldowns.pausedUntil('model'));
    assert.equal(explorations.get(c.id)!.state, 'waiting');
    now += 6 * 60_000;
    cooldowns.hit('web', 'actions'); // a search service's throttling does not hold the model's other users
    await until(() => explorations.get(c.id)!.state === 'done', 'the run after the cooldown');
  } finally { await explorations.close(); await s.close(); }
});

test('worker-release persistence failure preserves the Pi error or success', async () => {
  for (const fails of [true, false]) {
    const s = await scratch();
    const originalError = new Error('original provider failure');
    let releaseWrite = false, injected = 0;
    const explorations = new Explorations({ directory: s.directory, clock: Date.now, cooldowns: new Cooldowns(),
      runPi: async () => {
        releaseWrite = true;
        if (fails) throw originalError;
        return { text: 'finished', ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [] };
      } });
    const internal = explorations as unknown as { persist: (job: ExplorationJob) => Promise<void> };
    const persist = internal.persist.bind(explorations);
    internal.persist = async job => {
      if (releaseWrite) { releaseWrite = false; injected++; throw new Error('worker release disk failure'); }
      await persist(job);
    };
    try {
      let caught: unknown;
      const job = await explorations.submit('m1', { kind: 'plan', work: async ctx => {
        try { return (await ctx.pi('plan', { model: 'fiction/model' })).text; }
        catch (error) { caught = error; throw error; }
      } });
      await until(() => ['failed', 'done'].includes(explorations.get(job.id)!.state));
      assert.equal(injected, 1, 'failure was injected into the release write, not admission or terminal persistence');
      assert.equal(caught, fails ? originalError : undefined, 'finally must not replace the original outcome');
      const saved = await readJson(join(s.directory, 'explorations', 'm1', job.id, 'job.json'));
      assert.deepEqual([saved.state, saved.error, saved.result], fails ? ['failed', originalError.message, null] : ['done', null, 'finished']);
    } finally { await explorations.close(); await s.close(); }
  }
});

test('the cooldown is shared: a plan run\'s rate-limit error pauses the actions and the notes', async () => {
  const s = await scratch();
  const cooldowns = new Cooldowns();
  const explorations = new Explorations({ directory: s.directory, clock: Date.now, cooldowns });
  try {
    const actions = new ActionJobs({ store: null as never, directory: s.directory, runner: null, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [], cooldowns });
    const notes = new NotesJobs({ store: null as never, directory: s.directory, runner: async () => ({ text: '' }), clock: Date.now, glossaryFor: async () => null, cooldowns });
    const job = await explorations.submit('m1', { kind: 'plan', work: ctx => ctx.pi('plan', fakePi('ratelimit')) });
    await until(() => explorations.get(job.id)!.state === 'failed', 'the run to fail');
    assert.match(explorations.get(job.id)!.error!, /usage limit/);
    assert.ok(cooldowns.pausedUntil('model'));
    assert.equal(actions.paused(), cooldowns.pausedUntil('model'), 'actions wait for it');
    await assert.rejects(notes.start('m1'), (e: Error & { status?: number }) => e.status === 429, 'notes wait for it');
    const next = await explorations.submit('m1', { kind: 'plan', work: async () => null });
    assert.match(explorations.list('m1').find(j => j.id === next.id)!.waiting!.reason, /model's quota/);
  } finally { await explorations.close(); await s.close(); }
});

test('a running plan saves its worker before Pi starts; Cancel ends its groups and keeps what it streamed', async () => {
  const s = await scratch();
  const explorations = new Explorations({ directory: s.directory, clock: Date.now, cooldowns: new Cooldowns() });
  try {
    const job = await explorations.submit('m1', { kind: 'plan', work: ctx => ctx.pi('plan', { ...fakePi('python', s.out), thinking: 'low', skills: false }) });
    await until(() => existsSync(s.out), 'the fake Pi to start its script');
    const pids = await readJson(s.out) as Pids;
    assert.equal(pids.recorded, true);
    const record = await readJson(join(s.directory, 'explorations', 'm1', job.id, 'job.json')) as ExplorationJob;
    assert.deepEqual([record.state, record.worker?.pid, record.worker?.pgid], ['running', pids.pi, pids.pi], 'the job record names its worker');
    await until(async () => (await explorations.stream(job.id)).text.includes('and more'), 'the streamed text');
    await explorations.cancel('m1', job.id);
    await until(() => explorations.get(job.id)!.state === 'cancelled', 'the run to stop');
    await until(() => gone(pids), 'Pi, its helper and its script to end');
    const saved = await explorations.stream(job.id);
    assert.equal(saved.text, 'recorded=true\n\nand more');
    assert.deepEqual(saved.events.map(e => [e.type, e.name, e.text]), [['tool', 'web_search', 'found it']]);
    assert.deepEqual([saved.state.state, saved.state.reason], ['stopped', 'cancelled']);
    const final = await readJson(join(s.directory, 'explorations', 'm1', job.id, 'job.json')) as ExplorationJob;
    assert.deepEqual([final.state, final.stopped, final.worker, final.error], ['cancelled', 'cancelled', null, 'Cancelled.']);
    assert.equal(explorations.busy('m1'), false);
  } finally { await explorations.close(); await s.close(); }
});

test('the time limit stops a run; a sol rate limit during a recording stops it first; a quit interrupts it, keeping what was saved', async () => {
  const s = await scratch();
  let now = Date.now();
  const cooldowns = new Cooldowns(() => now);
  let recording: string | null = null;
  const explorations = new Explorations({ directory: s.directory, clock: Date.now, cooldowns, recording: () => recording });
  try {
    const timed = await explorations.submit('m1', { kind: 'plan', limitMs: 2500, work: ctx => ctx.pi('plan', fakePi('hang')) });
    await until(() => explorations.get(timed.id)!.state === 'stopped', 'the time limit', 15_000);
    assert.deepEqual([explorations.get(timed.id)!.stopped, explorations.get(timed.id)!.error], ['time limit', 'Stopped at the time limit (3 s).']);
    assert.equal((await explorations.stream(timed.id)).text, 'recorded=true\n\nand more', 'what streamed before the limit is kept');

    const out = join(s.directory, 'quota.json');
    const preempted = await explorations.submit('m2', { kind: 'explore', key: 'p1', work: ctx => ctx.pi('explore', fakePi('python', out)) });
    await until(() => existsSync(out), 'the second run to start its script');
    const pids = await readJson(out) as Pids;
    recording = 'the recording to end'; // a recording started meanwhile does not stop it...
    await sleep(100);
    assert.equal(explorations.get(preempted.id)!.state, 'running');
    cooldowns.hit('model', 'actions'); // ...but a rate limit of another sol job during it does
    await until(() => explorations.get(preempted.id)!.state === 'stopped', 'the run to give way');
    assert.equal(explorations.get(preempted.id)!.stopped, 'quota');
    await until(() => gone(pids), 'its processes to end');
    recording = null;

    const quitOut = join(s.directory, 'quit.json');
    const running = await explorations.submit('m3', { kind: 'plan', limitMs: 60_000, work: ctx => ctx.pi('plan', fakePi('python', quitOut)) });
    const waiting = await explorations.submit('m4', { kind: 'plan', work: async () => null });
    // The model's cooldown from above holds both; once it is over the first starts.
    assert.match(explorations.list('m3')[0].waiting!.reason, /quota/);
    now += 6 * 60_000;
    await until(() => existsSync(quitOut), 'the third run to start its script');
    const quitPids = await readJson(quitOut) as Pids;
    await explorations.close();
    assert.deepEqual([explorations.get(running.id)!.state, explorations.get(running.id)!.stopped], ['interrupted', 'quit']);
    assert.deepEqual([explorations.get(waiting.id)!.state, explorations.get(waiting.id)!.error], ['interrupted', 'The app closed before this run started.']);
    assert.ok(await gone(quitPids), 'a quit ends its processes before close resolves');
    const saved = await explorations.stream(running.id);
    assert.deepEqual([saved.text.length > 0, saved.state.state, saved.state.reason], [true, 'stopped', 'quit']);
    await assert.rejects(explorations.submit('m5', { kind: 'plan', work: async () => null }), /closing/);
  } finally { await explorations.close(); await s.close(); }
});

test('a server killed while Pi runs a Python script: the next server start ends both before anything else, and the run is interrupted', async () => {
  const s = await scratch();
  try {
    const server = spawn(process.execPath, [...NODE_TS, FAKE_SERVER, s.directory, s.out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    server.stderr!.on('data', part => { stderr += part; });
    await until(() => existsSync(s.out), `the fake server's Pi to start its script (${stderr})`, 20_000);
    const pids = await readJson(s.out) as Pids;
    const [meeting] = await readdir(join(s.directory, 'explorations'));
    const [run] = await readdir(join(s.directory, 'explorations', meeting));
    // The child's PID file precedes the parent's asynchronous stream writes. Crash only after
    // the text and tool event that recovery must preserve have actually reached disk.
    await until(async () => {
      const saved = await StreamLog.read(join(s.directory, 'explorations', meeting, run));
      return saved.text === 'recorded=true\n\nand more' && saved.events.length === 1;
    }, 'the pre-crash stream to be durable');
    server.kill('SIGKILL');
    await once(server, 'exit');
    assert.ok(await alive(pids.pi) && await alive(pids.python) && await alive(pids.helper), 'a crash leaves them running on their own');
    const app = await startServer({ directory: s.directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null });
    try {
      await until(() => gone(pids), 'Pi, its helper and its script to end');
      const [job] = app.explorations.list(meeting);
      assert.deepEqual([job.state, job.stopped, job.worker, job.error], ['interrupted', 'crash', null, 'The app stopped before this run finished.']);
      const saved = await app.explorations.stream(job.id);
      assert.deepEqual([saved.text, saved.state.state, saved.state.reason], ['recorded=true\n\nand more', 'stopped', 'crash'], 'what was saved before the crash stays');
      assert.equal(saved.events.length, 1);
      assert.equal(existsSync(join(s.directory, 'processes', job.id)), false);
    } finally { await app.close(); }
  } finally { await s.close(); }
});

test('the server: a plan run counts in busy() (a move waits), the idle stop waits for it, and a quit stops it keeping what was saved', async () => {
  const s = await scratch();
  let idleAt = 0;
  await writeFile(join(s.directory, 'settings.json'), JSON.stringify({ aiMode: 'cloud', cloudConsent: { providers: ['fake'], time: 1 } }));
  const app = await startServer({ directory: s.directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, idleMs: 300, onIdle: () => { idleAt = Date.now(); } });
  let closed = false;
  try {
    const meeting = app.store.createMeeting('Advisor meeting');
    const running = gate();
    const job = await app.explorations.submit(meeting.id, { kind: 'plan', work: async ctx => { ctx.log.appendText('half a plan'); await running.opened; return 'done'; } });
    await until(() => app.explorations.get(job.id)!.state === 'running', 'the run to start');
    assert.ok(app.busy(meeting.id).includes('the plans'));
    // A page came and went: only the run keeps the server up.
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    await fetch(`${app.url}/api/status`, { headers: { Cookie: cookie, Origin: app.url, 'X-Page': 'w1' } });
    await fetch(`${app.url}/api/bye?page=w1`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
    await sleep(1500);
    assert.equal(idleAt, 0, 'not idle while a plan run is in progress');
    running.open();
    await until(() => app.explorations.get(job.id)!.state === 'done', 'the run to end');
    assert.deepEqual(app.busy(meeting.id), []);
    await until(() => idleAt > 0, 'the idle stop once it ended', 5000);

    const out = join(s.directory, 'shutdown.json');
    const second = await app.explorations.submit(meeting.id, { kind: 'plan', work: ctx => ctx.pi('plan', fakePi('python', out)) });
    await until(() => existsSync(out), 'the run to start its script');
    const pids = await readJson(out) as Pids;
    await app.close();
    closed = true;
    assert.ok(await gone(pids), 'the quit ended its processes');
    const record = await readJson(join(s.directory, 'explorations', meeting.id, second.id, 'job.json')) as ExplorationJob;
    assert.deepEqual([record.state, record.stopped], ['interrupted', 'quit']);
    const saved = await StreamLog.read(join(s.directory, 'explorations', meeting.id, second.id));
    assert.deepEqual([saved.text, saved.state.reason], ['recorded=true\n\nand more', 'quit']);
  } finally { if (!closed) await app.close(); await s.close(); }
});

// Pi's review of this runtime: one test per finding.

test('a leaderless group is ended only when our sentinel shows it is ours; a reused group id is left alone (review 1)', async () => {
  const s = await scratch();
  const strays: number[] = [];
  try {
    // An unrelated group whose leader has exited, with the id an earlier run's record names: its member started after that
    // run's leader, yet it is not ours.
    const unrelated = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const pgid = unrelated.pid!;
    const member = Number(String((await once(unrelated.stdout!, 'data'))[0]).trim());
    strays.push(member);
    if (unrelated.exitCode === null) await once(unrelated, 'exit');
    const folder = join(s.directory, 'processes', 'old');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `pi-${pgid}.json`), JSON.stringify({ kind: 'pi', pid: pgid, pgid, started: 'Thu Jan  1 00:00:00 2026', dir: folder, recordedAt: 0 }));
    assert.deepEqual(await endRecorded(folder), { ended: 0, kept: 0 });
    await sleep(200);
    assert.ok(await alive(member), 'left alone');

    // Our own group whose leader has exited, leaving a helper: the gate's sentinel, which names our folder, is still in it.
    const ours = join(s.directory, 'processes', 'ours');
    const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => process.exit(0), 200);";
    const gated = await spawnGated(process.execPath, ['-e', script], { dir: ours, kind: 'pi', cwd: s.directory, stdio: ['ignore', 'pipe', 'ignore'] });
    gated.release();
    const helper = Number(String((await once(gated.child.stdout!, 'data'))[0]).trim());
    strays.push(helper);
    if (gated.child.exitCode === null) await once(gated.child, 'exit');
    assert.ok(await alive(helper));
    assert.deepEqual(await endRecorded(ours), { ended: 1, kept: 0 });
    await until(async () => !(await alive(helper)), 'our helper to end');
  } finally {
    for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
    await s.close();
  }
});

test('a task stopped while its job is still saving Pi never releases or signals that group afterwards (review 2)', async () => {
  const s = await scratch();
  const realKill = process.kill;
  const late: number[] = [];
  try {
    const processDir = join(s.directory, 'processes', 'task');
    const controller = new AbortController();
    const saving = gate();
    let pgid = 0;
    const task = runPiTask('x', { ...fakePi('answer', s.out), cwd: s.directory, processDir, signal: controller.signal,
      onStart: async record => { pgid = record.pgid; await saving.opened; } });
    await until(() => pgid > 0, 'Pi to be recorded');
    controller.abort();
    const error = await task.then(() => null, e => e as PiTaskError);
    assert.equal(error?.reason, 'cancelled', 'settled while its job was still saving it');
    process.kill = ((pid: number, signal?: string | number) => { if (pid === -pgid) late.push(pid); return realKill.call(process, pid, signal); }) as typeof process.kill;
    saving.open();
    await sleep(3300); // past the SIGKILL a stop would have scheduled
    assert.deepEqual(late, [], 'no signal to the old group id once the task has ended');
    assert.equal(existsSync(s.out), false, 'Pi was never released');
  } finally { process.kill = realKill; await s.close(); }
});

test('Cancel, a quit and the run\'s own limit bound the work even when it ignores the stop, and what it owns is ended (review 3)', async () => {
  const s = await scratch();
  // A Pi call that ignores Cancel (as stuck work might): the run must end its processes itself.
  const explorations = new Explorations({ directory: s.directory, clock: Date.now, cooldowns: new Cooldowns(),
    runPi: (prompt, options) => runPiTask(prompt, { ...options, signal: undefined }) });
  const never = () => new Promise<never>(() => {});
  const running = (id: string) => until(() => explorations.get(id)!.state === 'running', 'the run to start');
  try {
    const stuck = await explorations.submit('m1', { kind: 'plan', work: never });
    await running(stuck.id);
    let t0 = Date.now();
    await explorations.cancel('m1', stuck.id);
    await until(() => explorations.get(stuck.id)!.state === 'cancelled', 'a stuck run to end');
    assert.ok(Date.now() - t0 < 3000, 'within the grace, not never');

    const waiting = await explorations.submit('m2', { kind: 'plan', work: ctx => ctx.wait(never()) });
    await running(waiting.id);
    t0 = Date.now();
    await explorations.cancel('m2', waiting.id);
    await until(() => explorations.get(waiting.id)!.state === 'cancelled', 'an abortable wait to end');
    assert.ok(Date.now() - t0 < 400, 'ctx.wait ends at once');

    const late = await explorations.submit('m3', { kind: 'plan', runLimitMs: 1000, work: never });
    await until(() => explorations.get(late.id)!.state === 'stopped', "the run's own limit", 5000);
    assert.deepEqual([explorations.get(late.id)!.stopped, explorations.get(late.id)!.error], ['time limit', "Stopped at the run's time limit (1 s)."], 'no Pi call needed');

    const out = join(s.directory, 'owned.json');
    const owned = await explorations.submit('m4', { kind: 'plan', work: ctx => ctx.pi('plan', fakePi('python', out)) });
    await until(() => existsSync(out), 'the fake Pi to start its script');
    const pids = await readJson(out) as Pids;
    await explorations.cancel('m4', owned.id);
    await until(() => explorations.get(owned.id)!.state === 'cancelled', 'the run to end');
    await until(() => gone(pids), 'Pi, its helper and its script to end, though the Pi call ignored Cancel');

    const quitting = await explorations.submit('m5', { kind: 'plan', work: never });
    await running(quitting.id);
    t0 = Date.now();
    await explorations.close();
    assert.ok(Date.now() - t0 < 3000, 'a quit is bounded');
    assert.equal(explorations.get(quitting.id)!.state, 'interrupted');
  } finally { await explorations.close(); await s.close(); }
});

test('a helper that inherited Pi\'s pipes cannot hold a finished task: its group ends at Pi\'s exit, and the pipes drain within a bound (review 4)', async () => {
  for (const mode of ['leaky', 'leaky-detached'] as const) {
    const s = await scratch();
    let helper = 0;
    try {
      const t0 = Date.now();
      const result = await runPiTask('x', { ...fakePi(mode, s.out), cwd: s.directory, processDir: join(s.directory, 'processes', 'task'), timeoutMs: 20_000 });
      assert.equal(result.text, 'answer with a helper left');
      assert.ok(Date.now() - t0 < 5000, `${mode}: settled at once, not at the time limit`);
      helper = (await readJson(s.out) as Pids).helper;
      if (mode === 'leaky') await until(async () => !(await alive(helper)), "the helper in Pi's group to end");
      else assert.ok(await alive(helper), 'a helper in a group of its own, never recorded, is not ours to end');
    } finally {
      try { process.kill(-helper, 'SIGKILL'); } catch { /* ended */ }
      await s.close();
    }
  }
});

test('when the processes cannot be listed, cleanup keeps the records and says so; a later sweep ends them (review 5)', async () => {
  const s = await scratch();
  const path = process.env.PATH;
  try {
    const root = join(s.directory, 'processes');
    const processDir = join(root, 'task');
    const controller = new AbortController();
    const task = runPiTask('x', { ...fakePi('python', s.out), cwd: s.directory, processDir, signal: controller.signal, timeoutMs: 60_000 });
    await until(() => existsSync(s.out), 'the fake Pi to start its script');
    const pids = await readJson(s.out) as Pids;
    process.env.PATH = '/nonexistent'; // ps cannot run
    controller.abort();
    const error = await task.then(() => null, e => e as PiTaskError);
    process.env.PATH = path;
    assert.equal(error?.reason, 'cancelled');
    assert.match(error?.cleanupError ?? '', /ps failed/, 'reported');
    assert.ok(existsSync(join(processDir, `python-${pids.python}.json`)), "the script's record is kept");
    assert.ok(await alive(pids.python), 'nothing unverified was killed');
    assert.ok(await endLeftoverProcesses(root) >= 1);
    await until(async () => !(await alive(pids.python)), 'the script to end at the sweep');
    assert.equal(existsSync(processDir), false, 'removed once confirmed');
  } finally { process.env.PATH = path; await s.close(); }
});

test('a helper that ignores SIGTERM: Cancel ends it with the checked SIGKILL; if the group cannot be verified, its record is kept and reported', async () => {
  const groupMembers = (pgid: number) => new Promise<{ pid: number; command: string }[]>(resolve => execFile('ps', ['-A', '-ww', '-o', 'pid=,pgid=,command='], (error, out) =>
    resolve(error ? [] : out.split('\n').flatMap(line => { const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); return m && Number(m[2]) === pgid ? [{ pid: Number(m[1]), command: m[3] }] : []; }))));
  for (const sentinel of ['kept', 'killed first'] as const) {
    const s = await scratch();
    let helper = 0;
    try {
      const processDir = join(s.directory, 'processes', 'task');
      const controller = new AbortController();
      const task = runPiTask('x', { ...fakePi('stubborn', s.out), cwd: s.directory, processDir, signal: controller.signal, timeoutMs: 60_000 });
      await until(() => existsSync(s.out), 'the fake Pi to start its helper');
      const pids = await readJson(s.out) as Pids;
      helper = pids.helper;
      if (sentinel === 'killed first') {
        // Without its sentinel (and with its leader gone after the SIGTERM) the group can no longer be shown to be ours.
        const others = (await groupMembers(pids.pi)).filter(p => p.pid !== pids.pi && p.pid !== pids.helper);
        assert.ok(others.some(p => p.command.includes(`meeting-process-sentinel ${processDir}`)), 'the sentinel names the folder');
        for (const p of others) process.kill(p.pid, 'SIGKILL');
      }
      controller.abort();
      const error = await task.then(() => null, e => e as PiTaskError);
      assert.equal(error?.reason, 'cancelled');
      if (sentinel === 'kept') {
        await until(async () => !(await alive(helper)), 'the stubborn helper to end');
        assert.equal(error?.cleanupError, undefined);
        assert.equal(existsSync(processDir), false);
      } else {
        assert.ok(await alive(helper), 'not killed without proof');
        assert.match(error?.cleanupError ?? '', /not confirmed ended/, 'reported, not taken as success');
        assert.ok(existsSync(join(processDir, `pi-${pids.pi}.json`)), 'its record is kept');
      }
    } finally {
      try { process.kill(helper, 'SIGKILL'); } catch { /* ended */ }
      await s.close();
    }
  }
});

test('the final stream state is written after the queued appends, so a failed last append shows on disk (review 6)', async () => {
  const s = await scratch();
  try {
    const folder = join(s.directory, 'run');
    const log = new StreamLog(folder);
    await log.open();
    await mkdir(join(folder, 'text.md')); // the text cannot be appended
    log.appendText('last words');
    log.appendEvent({ type: 'note' });
    await log.complete(); // without flushing first
    const saved = await StreamLog.read(folder);
    assert.equal(saved.state.state, 'complete');
    assert.match(saved.state.error ?? '', /Could not save the run's progress/);
    assert.deepEqual([saved.state.textBytes, saved.state.events], [0, 0], 'counts are what was written');
  } finally { await s.close(); }
});

test('a recording counts for admission from its first frame\'s arrival, before the capture has saved it (review 7)', async () => {
  const s = await scratch();
  const app = await startServer({ directory: s.directory, port: 0, quick: null, heavy: null, drafts: null, recognizer: {
    async transcribe() { return { text: 'Test', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; },
    close() {},
  } });
  try {
    const meeting = app.store.createMeeting('Live meeting');
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    // A frame the capture does not save (out of order): the server has claimed the recording, the capture has not seen it.
    const frame = await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4),
      headers: { Cookie: cookie, Origin: app.url, 'X-Audio-Source': `mic:${randomUUID()}`, 'X-Sequence': '1', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0' } });
    assert.equal(frame.status, 409);
    assert.ok(app.busy(meeting.id).includes('the recording'));
    const other = app.store.createMeeting('Another meeting');
    const job = await app.explorations.submit(other.id, { kind: 'plan', work: async () => 'ran' });
    await sleep(150);
    assert.equal(app.explorations.get(job.id)!.state, 'waiting');
    assert.equal(app.explorations.list(other.id)[0].waiting?.reason, 'Waiting for the recording to end');
  } finally { await app.close(); await s.close(); }
});

test('one event stays within its bound as written, JSON escapes included (review 9)', async () => {
  const s = await scratch();
  try {
    const folder = join(s.directory, 'run');
    const log = new StreamLog(folder);
    await log.open();
    // 300,000 newlines and 100,000 control characters: 1.2 MB once escaped.
    log.appendEvent({ type: 'tool', id: 'c1', name: 'fetch_content', isError: false, text: '\n'.repeat(300_000) + '\u0001'.repeat(100_000), args: { note: '\n'.repeat(50_000) } });
    log.appendEvent({ type: 'tool', id: 'c2', name: 'web_search', isError: false, text: 'small' });
    await log.complete();
    const lines = (await readFile(join(folder, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(Buffer.byteLength(`${line}\n`) <= STREAM_LIMITS.eventBytes, 'within the bound');
    const first = JSON.parse(lines[0]);
    assert.deepEqual([first.cut, first.name, first.seq], [true, 'fetch_content', 1]);
    assert.ok(first.text.length >= 1000, 'as much text as fits is kept');
    assert.equal(JSON.parse(lines[1]).text, 'small');
  } finally { await s.close(); }
});
