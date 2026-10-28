// Offline only. Use the store's shared read-only path repair rules, without transcription recovery writes.
// Previously committed deletions are ALWAYS finished, even during a dry run of additional meetings.
import { DatabaseSync } from 'node:sqlite';
import { createServer, createConnection } from 'node:net';
import { lstatSync, realpathSync, readFileSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteMeeting, inspectMeetingDeletion, ownedPath, finishPendingMeetingDeletions, unreferencedImports, type MeetingDeletion } from '../src/delete-meeting.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseDeleteArguments(args: string[]) {
  let directory = process.env.MEETING_DATA_DIR ?? join(ROOT, 'data'), yes = false;
  const ids: string[] = [], keep: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes') yes = true;
    else if (arg === '--data' || arg === '--keep') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value.`);
      if (arg === '--data') directory = value; else keep.push(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (keep.length) keep.push(arg);
    else ids.push(arg);
  }
  if ((!ids.length && !keep.length) || (ids.length && keep.length)) throw new Error('Usage: npm run delete-meetings -- [--data <dir>] [--yes] <meetingId>... OR --keep <meetingId> [--keep <meetingId> ...]');
  return { directory: resolve(directory), yes, ids: [...new Set(ids)], keep: [...new Set(keep)] };
}
function regular(directory: string, name: string, required = false) {
  try {
    const s = lstatSync(ownedPath(directory, name));
    if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Not a regular data file: ${name}`);
  } catch (error) { if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
/** Same ownership token as the server: holding it prevents a server starting during the offline operation. */
function lock(directory: string) {
  const path = ownedPath(directory, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      regular(directory, 'server.lock', true);
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid server.lock; inspect it before removing it.');
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; }
        throw error;
      }
      throw new Error(`The data folder is in use by process ${pid} (server.lock). Stop the HearAlong server first.`);
    }
  }
  throw new Error('Could not acquire server.lock.');
}
async function reservePort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535 (default 4318).');
  const listeners: ReturnType<typeof createServer>[] = [];
  const close = () => Promise.all(listeners.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  try {
    // Probe AND reserve each loopback endpoint. On macOS SO_REUSEADDR permits overlapping wildcard/specific binds.
    for (const host of ['127.0.0.1', '::1']) {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ port, host });
        const occupied = () => { socket.destroy(); reject(new Error(`Configured port ${port} is in use or unavailable (${host}); stop the HearAlong server first.`)); };
        socket.once('connect', occupied);
        socket.setTimeout(1000, occupied);
        socket.once('error', error => { socket.destroy(); if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(); else reject(error); });
      });
      const server = createServer(socket => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once('error', error => reject(new Error(`Configured port ${port} is in use or unavailable; stop the HearAlong server first (${error.message}).`)));
        server.listen({ port, host, ipv6Only: host === '::1', exclusive: true }, resolve);
      });
      listeners.push(server);
    }
  } catch (error) { await close(); throw error; }
  return close;
}
function printMeeting(m: MeetingDeletion) {
  console.log(`\n${m.id} — ${m.title} — ${new Date(m.createdAt).toISOString()}${m.pending ? ' (pending file cleanup; meeting already deleted)' : ''}`);
  for (const [table, count] of Object.entries(m.rows)) console.log(`  ${table}: ${m.pending ? 0 : count} rows`);
  console.log(`  Files: ${m.fileBytes} bytes; ${m.imports.length} unshared import(s)`);
  console.log(`  Saved past-notes copies in other meetings: ${m.evidenceCopiesElsewhere} (count only; kept)`);
  if (m.legacy.length) console.log(`  Legacy shared materials records to redact: ${m.legacy.join(', ')}`);
}
export async function main(args = process.argv.slice(2)) {
  const options = parseDeleteArguments(args), directory = realpathSync(options.directory);
  const releasePort = await reservePort(Number(process.env.PORT ?? 4318));
  let unlock: (() => void) | undefined, db: DatabaseSync | undefined;
  try {
    unlock = lock(directory);
    regular(directory, 'meetings.sqlite', true);
    for (const tail of ['-wal', '-shm', '-journal']) regular(directory, `meetings.sqlite${tail}`);
    db = new DatabaseSync(join(directory, 'meetings.sqlite'), { readOnly: false });
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; ROLLBACK;');
    const store = { db, directory };
    const all = new Set((db.prepare('SELECT id FROM meetings').all() as { id: string }[]).map(r => r.id));
    const completed = new Set(finishPendingMeetingDeletions(store, message => console.log(message)));
    for (const id of options.keep) if (!all.has(id)) throw new Error(`Unknown meeting: ${id}; --keep requires a live meeting.`);
    for (const id of options.ids) if (!all.has(id) && !completed.has(id)) throw new Error(`Unknown meeting: ${id}`);
    const ids = options.keep.length ? [...all].filter(id => !options.keep.includes(id)) : options.ids.filter(id => !completed.has(id));
    // Preflight the ENTIRE selection before performing any deletion.
    const preceding = new Set<string>(), deleting = new Set(ids);
    const meetings = ids.map(id => { const m = inspectMeetingDeletion(store, id, Date.now(), preceding, deleting); preceding.add(id); return m; });
    console.log(options.yes ? 'DELETE (permanent meeting workflows; project memory and batch Undo stay)' : 'DRY RUN — no additional meeting rows or files will be removed; committed pending deletions are always finished');
    console.log('Offline checks: TCP probes + reserved configured loopback port (IPv4/IPv6), shared server.lock protocol, writable SQLite BEGIN IMMEDIATE. Shared read-only path repair rules; no transcription recovery is run.');
    console.log('Shared PDF cache, app logs, transcripts/ separate databases, and other meetings\' evidence stay.');
    for (const m of meetings) printMeeting(m);
    console.log('\nUnreferenced imports (not deleted):');
    const orphans = unreferencedImports(store);
    for (const orphan of orphans) console.log(`  ${orphan.path}: ${orphan.bytes} bytes`);
    if (!orphans.length) console.log('  none');
    // The dry run models this order: an import shared within the selection is counted at its last owner.
    console.log(`\nTotal: ${meetings.length} meeting(s), ${meetings.reduce((n, m) => n + (m.pending ? 0 : Object.values(m.rows).reduce((a, b) => a + b, 0)), 0)} rows, ${meetings.reduce((n, m) => n + m.fileBytes, 0)} file bytes.`);
    if (options.yes) for (const id of ids) { deleteMeeting(store, id); console.log(`Deleted ${id}`); }
  } finally {
    try { db?.close(); } finally { try { unlock?.(); } finally { await releasePort(); } }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
