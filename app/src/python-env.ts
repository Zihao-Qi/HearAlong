// Compute's pinned Python environment, prepared once per process (M3 design, decision 1): the first calculation must not
// spend its 120 s limit downloading packages, and a failed preparation is reported instead of surfacing as a timeout.
import { spawn, type ChildProcess } from 'node:child_process';
import { UV_ARGS } from '../pi-extensions/python-env.ts';

export type PythonState = { state: 'idle' | 'preparing' | 'ready' | 'failed'; error: string };
const status: PythonState = { state: 'idle', error: '' };
let ready: Promise<void> | null = null;
let child: ChildProcess | null = null;

export function pythonStatus(): PythonState { return { ...status }; }
/** Starts (once) and returns the preparation; bounded to 10 minutes. */
export function ensurePython(timeoutMs = 600_000): Promise<void> {
  ready ??= new Promise<void>((resolve, reject) => {
    status.state = 'preparing';
    child = spawn('uv', [...UV_ARGS, 'python', '-c', 'import numpy, scipy, sympy'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child?.kill('SIGKILL'); }, timeoutMs);
    child.stderr!.on('data', part => { err = (err + part).slice(-500); });
    const done = (error: string | null) => {
      clearTimeout(timer);
      child = null;
      if (error === null) { status.state = 'ready'; status.error = ''; resolve(); }
      else { status.state = 'failed'; status.error = error; ready = null; reject(new Error(`The Python environment for calculations could not be prepared: ${error}`)); }
    };
    child.on('error', error => done(error.message));
    child.on('close', code => done(code === 0 ? null : err.trim() || `exit ${code}`));
  });
  return ready;
}
/** Stops a preparation still running (server shutdown). */
export function stopPython() { child?.kill('SIGKILL'); }
