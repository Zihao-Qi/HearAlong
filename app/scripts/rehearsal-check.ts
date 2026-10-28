// Retained real-audio integration check (not part of the fast npm test suite).
// node --experimental-strip-types scripts/rehearsal-check.ts <mic.wav> [them.wav]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Source archives have no Git worktree metadata; the ordinary app store is the protected folder.
const protectedFolders = [join(appRoot, 'data')];
async function snapshot() {
  const entries: [string, number, number, number][] = [];
  const walk = async (path: string) => {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    entries.push([path, info.mtimeMs, info.size, info.ino]);
    if (info.isDirectory()) for (const child of (await readdir(path)).sort()) await walk(join(path, child));
  };
  for (const path of protectedFolders) await walk(path);
  return entries;
}
const ps = () => execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n').map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)!;
  return { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const [mic, them = mic] = process.argv.slice(2).map(path => resolve(path));
if (!mic) throw new Error('Usage: rehearsal-check.ts <mic.wav> [them.wav]');

for (const seconds of [60, 30]) {
  const before = await snapshot();
  const args = ['run', 'rehearse', '--', mic, '--from', '10:00', '--minutes', String(seconds / 60), '--headless', ...(seconds === 30 ? ['--them', them] : [])];
  const child = spawn('npm', args, { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  const observed = new Set<number>([child.pid!]);
  const commands = new Map<number, string>();
  let output = '', stderr = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { stderr += part; });
  const poll = setInterval(() => {
    const processes = ps();
    let added = true;
    while (added) {
      added = false;
      for (const p of processes) if (observed.has(p.parent) && !observed.has(p.pid)) { observed.add(p.pid); commands.set(p.pid, p.command); added = true; }
    }
  }, 200);
  const deadline = setTimeout(() => { child.kill('SIGTERM'); }, 240_000);
  let code: number | null;
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearInterval(poll); clearTimeout(deadline); }
  assert.equal(code, 0, `${output}\n${stderr}`);
  const directory = /Run data: (.*?) — reopen:/.exec(output)?.[1];
  assert.ok(directory, output);
  const report = JSON.parse(await readFile(join(directory, 'rehearsal.json'), 'utf8'));
  assert.equal(report.reason, 'audio ended');
  assert.equal(report.seconds, seconds);
  assert.notEqual(new URL(report.url).port, '4318');
  assert.ok(report.finalsWhileRecording > 0, 'finals must arrive before Stop');
  assert.ok(report.visibleFinalsWhileRecording > 0, 'finals must appear in the browser before Stop');
  assert.ok(report.finals > 0, 'final transcript must persist');
  assert.deepEqual(report.errors, []);
  assert.ok(Math.abs((report.stoppedAt - report.startedAt) / 1000 - seconds) < 3, 'Stop at EOF, in wall-clock time');
  const sources = [...new Set<string>(report.frames.map((frame: { source: string }) => frame.source))];
  assert.equal(sources.length, seconds === 30 ? 2 : 1);
  const rates: { source: string; frames: number; meanIntervalMs: number; audioSeconds: number }[] = [];
  for (const source of sources) {
    const frames = report.frames.filter((frame: { source: string }) => frame.source === source);
    const full = frames.filter((frame: { samples: number }) => frame.samples === 16000);
    const interval = (full.at(-1).at - full[0].at) / (full.length - 1);
    assert.ok(full.length >= seconds - 2 && full.length <= seconds + 1, `${source}: ${full.length} full frames`);
    assert.ok(interval > 900 && interval < 1100, `${source}: ${interval} ms/frame`);
    assert.ok(report.ends.some((end: { source: string }) => end.source === source), `${source}: Stop ends source`);
    const audioSeconds = frames.reduce((sum: number, frame: { samples: number }) => sum + frame.samples / 16000, 0);
    assert.ok(Math.abs(audioSeconds - seconds) < 2, `${source}: ${audioSeconds} s captured`);
    rates.push({ source, frames: frames.length, meanIntervalMs: interval, audioSeconds });
  }
  const db = new DatabaseSync(join(directory, 'meetings.sqlite'), { readOnly: true });
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id=?').get(report.meetingId);
    assert.ok(meeting);
    assert.equal(meeting.title, 'Rehearsal: ' + mic.split('/').at(-1) + ' from 10:00');
    const persisted = db.prepare('SELECT source,state FROM recording_sources WHERE meetingId=?').all(report.meetingId);
    assert.equal(persisted.length, sources.length);
    assert.ok(persisted.every(row => row.state === 'ended'), JSON.stringify(persisted));
    assert.ok((db.prepare('SELECT COUNT(*) AS n FROM segments WHERE meetingId=?').get(report.meetingId)!.n as number) > 0);
    if (seconds === 30) assert.ok(db.prepare("SELECT 1 FROM segments WHERE meetingId=? AND source LIKE 'tab:%'").get(report.meetingId), 'Them finals persist');
  } finally { db.close(); }
  assert.equal(await stat(report.temporary).then(() => true, () => false), false, 'profile and trimmed WAVs removed');
  // Include any detached Chrome helper still using this disposable profile, not only sampled descendants.
  for (const p of ps()) if (p.command.includes(report.temporary)) observed.add(p.pid);
  for (let i = 0; i < 50 && [...observed].some(alive); i++) await sleep(100);
  const remaining = [...observed].filter(alive);
  assert.deepEqual(remaining.map(pid => ({ pid, command: commands.get(pid) })), [], 'no launcher, Chrome, STT, or server processes remain');
  const after = await snapshot();
  assert.deepEqual(after, before, 'ordinary app data mtimes, sizes, inodes unchanged');
  const evidence = { seconds, directory, finalsWhileRecording: report.finalsWhileRecording, visibleFinalsWhileRecording: report.visibleFinalsWhileRecording, finals: report.finals,
    elapsedSeconds: (report.stoppedAt - report.startedAt) / 1000, rates, stoppedSources: report.ends.length,
    observedProcesses: observed.size, remainingProcesses: remaining, protectedFolders,
    protectedEntries: before.length, protectedSnapshotSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
    profileRemoved: true, dataUnchanged: true, cloudModels: false };
  await writeFile(join(directory, 'check-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${seconds}s ${seconds === 30 ? 'mic + Them' : 'mic'}: ${report.finalsWhileRecording} live finals; ${rates.map(r => `${r.meanIntervalMs.toFixed(1)} ms/frame`).join(', ')}; Stop at EOF; ${observed.size} processes exited; data unchanged.\n${directory}`);
}

// Regression: Playwright's default SIGINT handler exits before application cleanup. The launcher must own the signal.
const beforeSignal = await snapshot();
const { runRehearsal } = await import('./rehearse.ts');
const interruptedDirectory = await runRehearsal([mic, '--from', '10:00', '--minutes', '1', '--headless'], async page => {
  await page.waitForTimeout(2500);
  process.emit('SIGINT');
});
const interrupted = JSON.parse(await readFile(join(interruptedDirectory, 'rehearsal.json'), 'utf8'));
assert.equal(interrupted.reason, 'interrupted');
assert.ok(interrupted.ends.length > 0, 'Ctrl+C flushes and ends the recording');
assert.equal(await stat(interrupted.temporary).then(() => true, () => false), false);
assert.equal(await stat(join(interruptedDirectory, 'server.lock')).then(() => true, () => false), false);
assert.deepEqual(await snapshot(), beforeSignal);
assert.deepEqual(ps().filter(p => p.command.includes(interrupted.temporary) || (p.parent === process.pid && !p.command.startsWith('ps '))), []);
await writeFile(join(interruptedDirectory, 'signal-check-evidence.json'), JSON.stringify({ ctrlC: true, sourceEnded: true, profileRemoved: true, serverClosed: true, dataUnchanged: true, noProcesses: true }, null, 2));
console.log('PASS Ctrl+C: recording ended, profile removed, server closed, no processes, data unchanged.');
