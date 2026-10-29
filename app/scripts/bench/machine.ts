// Machine metadata stored beside every measurement. Called only when a runner actually starts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineInfo, ModelIdentity } from './results.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type RunCommand = (command: string, args: string[]) => string;
const runCommand: RunCommand = (command, args) => execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' });

export function sourceInfo(allowDirty = false, run: RunCommand = runCommand) {
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const dirty = Boolean(run('git', ['status', '--porcelain', '--untracked-files=normal']).trim());
  if (dirty && !allowDirty) throw new Error('Benchmark source is dirty. Commit or stash changes, or pass --allow-dirty (recorded in results).');
  return { commit, dirty, nodeVersion: process.version };
}

/** Stream/hash the selected file once per run, before any transcription. Never rediscover between sessions. */
export async function modelIdentity(path: string): Promise<ModelIdentity> {
  const before = await stat(path);
  if (!before.isFile()) throw new Error('Selected model is not a file.');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Model changed while hashing.');
  return { basename: basename(path), sha256: hash.digest('hex'), bytes: before.size };
}

export function machineInfo(allowDirty = false): MachineInfo {
  return {
    ...sourceInfo(allowDirty),
    macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    chip: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
    ramBytes: Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim()),
    logicalCores: Number(execFileSync('sysctl', ['-n', 'hw.logicalcpu'], { encoding: 'utf8' }).trim()),
  };
}
