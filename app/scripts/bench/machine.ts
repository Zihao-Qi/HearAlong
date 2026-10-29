// Machine metadata stored beside every measurement. Called only when a runner actually starts.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineInfo } from './results.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function machineInfo(): MachineInfo {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    chip: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
    ramBytes: Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim()),
  };
}
