/**
 * Process groups that must not outlive their job (M7b §4). A worker (Pi, or a run_python script) is started as the leader of a
 * group of its own and recorded in its task's process folder before it starts: a shell holds it until the record is on disk.
 * Whoever finds a record later (the task's own cleanup, or a server start after a crash) ends that whole group, so cleanup never
 * relies on Pi's exit handler, which a SIGKILL never runs.
 *
 * Identity. A record names the group and its leader's start time; while the leader lives, that start time must match, so a pid
 * the system has given to another process since is never killed. Each group also holds a sentinel: a small shell started by the
 * gate, whose command line names the task's folder, and which lives for a day unless the group is ended. The system never reuses
 * a group's id while any member of it lives, so a group whose leader has gone is ours exactly when our sentinel is still in it.
 * A leaderless group without it cannot be verified and is left alone (and logged). Shared by runPiTask (src/pi-task.ts) and
 * run_python.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

export type ProcessRecord = {
  /** What runs: 'pi' or 'python'. */
  kind: string;
  pid: number; pgid: number;
  /** The leader's start time as `ps` gives it ("Fri Oct 16 10:00:00 2026"): with the pid, the group's identity. */
  started: string;
  /** The task's process folder, which the group's sentinel names. */
  dir: string;
  recordedAt: number;
};
type Listed = { pid: number; pgid: number; zombie: boolean; started: string; command: string };

const SENTINEL = 'meeting-process-sentinel';
/**
 * Run as `sh -c GATE meeting-process-sentinel <dir> <command> <args…>`. Waits for one line on fd 3 (the record is saved), then
 * starts the sentinel (a subshell keeping this command line's folder; no inherited pipes) and becomes the worker.
 * If fd 3 closes first it ends without starting either. The sentinel ignores the group-wide SIGTERM of a stop (and HUP,
 * INT), so it is still there to show the group is ours when the checked SIGKILL comes for whatever ignored the SIGTERM too.
 */
const GATE = 'shift; IFS= read -r go <&3 || exit 125; exec 3<&-; '
  + "( trap '' TERM HUP INT; n=0; while [ $n -lt 24 ]; do sleep 3600; n=$((n+1)); done ) </dev/null >/dev/null 2>&1 & "
  + 'exec "$@"';

function ps(args: string[]): Promise<string | null> {
  return new Promise(resolve => execFile('ps', args, { env: { ...process.env, LC_ALL: 'C' }, timeout: 10_000, maxBuffer: 16_000_000 }, (error, stdout) => resolve(error ? null : stdout)));
}
/** The start time of a running process, or null when there is none with this pid. */
export async function processStart(pid: number): Promise<string | null> {
  return (await ps(['-o', 'lstart=', '-p', String(pid)]))?.trim() || null;
}
async function listProcesses(): Promise<Listed[]> {
  const out = await ps(['-A', '-ww', '-o', 'pid=,pgid=,stat=,lstart=,command=']);
  if (out === null) throw new Error('Could not list processes (ps failed).');
  return out.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), zombie: match[3].startsWith('Z'), started: match[4], command: match[5] }] : [];
  });
}
type Verdict = 'ours' | 'gone' | 'other' | 'unverified';
/** Whether a recorded group still exists and is the one recorded (see the identity rule above). Zombies count as gone. */
function verdict(record: ProcessRecord, processes: Listed[]): Verdict {
  const members = processes.filter(p => p.pgid === record.pgid && !p.zombie);
  if (!members.length) return 'gone';
  const leader = members.find(p => p.pid === record.pgid);
  if (leader) return leader.started === record.started ? 'ours' : 'other';
  return members.some(p => p.command.includes(`${SENTINEL} ${record.dir}`)) ? 'ours' : 'unverified';
}
export function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try { process.kill(-pgid, signal); } catch { /* already gone */ }
}
async function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

export type Gated = { child: ChildProcess; record: ProcessRecord; path: string; release(): void };
/**
 * Starts `command` as the leader of a new process group and saves its record in `dir` before the command runs. The caller
 * attaches its listeners, then calls `release()` to let it start. On any failure before that, the group is ended.
 */
export async function spawnGated(command: string, args: string[], options: {
  dir: string; kind: string; cwd: string; env?: NodeJS.ProcessEnv; stdio: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe'];
}): Promise<Gated> {
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const child = spawn('/bin/sh', ['-c', GATE, SENTINEL, options.dir, command, ...args], { cwd: options.cwd, env: options.env, detached: true, stdio: [...options.stdio, 'pipe'] });
  const gate = child.stdio[3] as Writable;
  gate.on('error', () => {}); // the shell may be gone already
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const pid = child.pid!;
    const started = await processStart(pid);
    if (!started) throw new Error('The process ended before it could be recorded.');
    const record: ProcessRecord = { kind: options.kind, pid, pgid: pid, started, dir: options.dir, recordedAt: Date.now() };
    const path = join(options.dir, `${options.kind}-${pid}.json`);
    await writeAtomic(path, JSON.stringify(record));
    return { child, record, path, release: () => { gate.end('go\n'); } };
  } catch (error) {
    // Not yet released, so the shell is our live child: its group id is still its own.
    if (child.pid && child.exitCode === null && child.signalCode === null) signalGroup(child.pid, 'SIGKILL');
    throw error;
  }
}

/** Ends one recorded group if it is verifiably the one recorded; true when it was ended. A group that cannot be verified is logged. */
export async function endGroup(record: ProcessRecord, processes?: Listed[]): Promise<boolean> {
  const found = verdict(record, processes ?? await listProcesses());
  if (found === 'unverified') console.warn(`Left process group ${record.pgid} alone: its leader is gone and it cannot be shown to be ours.`);
  if (found !== 'ours') return false;
  signalGroup(record.pgid, 'SIGKILL');
  return true;
}
/** Reads the records in a process folder; a damaged one is skipped (and removed with the folder later). */
export async function readRecords(dir: string): Promise<{ path: string; record: ProcessRecord }[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
  const records: { path: string; record: ProcessRecord }[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as ProcessRecord;
      // The folder it was found in is the one its sentinel names (older records did not say).
      if (Number.isInteger(record.pgid) && record.pgid > 1 && typeof record.started === 'string') records.push({ path: join(dir, name), record: { ...record, dir: record.dir ?? dir } });
    } catch { /* damaged or being written */ }
  }
  return records;
}
/**
 * Ends every group recorded in a folder (those `which` accepts). A record is removed once its group is confirmed gone (or belongs
 * to another process now); one whose group is still seen after the kill is kept for a later try. A group that still exists but
 * cannot be verified is never killed; with `keepUnverified` (a task's own cleanup, which may just have signalled it) its record is
 * kept and counted, otherwise (a later server start) it is logged and dropped. Throws, keeping every record, when the processes
 * cannot be listed. Returns how many groups were ended, and how many records are kept.
 */
export async function endRecorded(dir: string, which: (record: ProcessRecord) => boolean = () => true, options: { keepUnverified?: boolean } = {}): Promise<{ ended: number; kept: number }> {
  const records = (await readRecords(dir)).filter(r => which(r.record));
  if (!records.length) return { ended: 0, kept: 0 };
  const processes = await listProcesses();
  const killed: typeof records = [];
  let unverified = 0;
  for (const entry of records) {
    if (await endGroup(entry.record, processes)) killed.push(entry);
    else if (options.keepUnverified && verdict(entry.record, processes) === 'unverified') unverified++;
    else await rm(entry.path, { force: true });
  }
  let left = killed;
  for (const deadline = Date.now() + 2000; left.length && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const now = await listProcesses();
    left = left.filter(({ record }) => now.some(p => p.pgid === record.pgid && !p.zombie));
  }
  for (const entry of killed) if (!left.includes(entry)) await rm(entry.path, { force: true });
  return { ended: killed.length, kept: left.length + unverified };
}
/**
 * At a server start: ends every group still recorded under `root` (one folder per task), and removes each folder once nothing
 * recorded in it is left. Nothing recorded there can still belong to a live task, since the server that ran those tasks is gone.
 */
export async function endLeftoverProcesses(root: string): Promise<number> {
  let ended = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const result = await endRecorded(join(root, name));
    ended += result.ended;
    if (!result.kept) await rm(join(root, name), { recursive: true, force: true });
  }
  return ended;
}
