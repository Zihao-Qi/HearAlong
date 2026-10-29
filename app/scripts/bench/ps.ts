// Parse `ps` and split the server process from its speech workers. The browser is a descendant too; it is not a worker.
import { execFileSync } from 'node:child_process';

export type PsProcess = {
  pid: number;
  ppid: number;
  /** Instantaneous CPU percent, as `ps` prints it (not a fraction). */
  cpu: number;
  /** Resident set, in kilobytes, as macOS `ps` prints `rss`. */
  rssKb: number;
  command: string;
};

export type RoleUsage = { cpu: number; rssBytes: number; pids: number[] };

/** One sample of `ps -axo pid=,ppid=,pcpu=,rss=,command=`. Lines that are not that shape are skipped. */
export function parsePs(text: string): PsProcess[] {
  const rows: PsProcess[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rssKb: Number(match[4]), command: match[5] });
  }
  return rows;
}

function childrenOf(rows: PsProcess[]): Map<number, PsProcess[]> {
  const byParent = new Map<number, PsProcess[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  return byParent;
}

function isSpeechWorker(command: string): boolean {
  return /(?:^|[\s/])stt-stream-worker\.ts(?:\s|$)|(?:^|[\s/])stt-worker\.ts(?:\s|$)/.test(command);
}

/**
 * CPU% and RSS of every speech worker under `serverPid`, plus processes those workers spawned (ffmpeg during decode).
 * Chrome and other descendants of the server are not included. RSS is bytes (macOS `ps` reports kilobytes).
 * Several workers in one sample are summed: the final-text worker and the live-preview worker are one role.
 */
export function speechWorkerUsage(rows: PsProcess[], serverPid: number): RoleUsage {
  const byParent = childrenOf(rows);
  const roots: number[] = [];
  const find = (pid: number) => {
    for (const child of byParent.get(pid) ?? []) {
      if (isSpeechWorker(child.command)) roots.push(child.pid);
      find(child.pid);
    }
  };
  find(serverPid);
  const seen = new Set<number>();
  const pids: number[] = [];
  let cpu = 0;
  let rssKb = 0;
  const take = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    pids.push(pid);
    const row = rows.find(item => item.pid === pid);
    if (row) { cpu += row.cpu; rssKb += row.rssKb; }
    for (const child of byParent.get(pid) ?? []) take(child.pid);
  };
  for (const pid of roots) take(pid);
  return { cpu, rssBytes: rssKb * 1024, pids };
}

/** The server process itself, or null when that pid is not in the sample. */
export function serverUsage(rows: PsProcess[], serverPid: number): { cpu: number; rssBytes: number } | null {
  const row = rows.find(item => item.pid === serverPid);
  return row ? { cpu: row.cpu, rssBytes: row.rssKb * 1024 } : null;
}

/** One `ps` sample of this machine. `ps` is a macOS builtin; this does not spawn a shell. */
export function readPs(): PsProcess[] {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return parsePs(text);
}
