// Compute's pinned Python environment, prepared once per process (M3 design, decision 1): the first calculation must not
// spend its 120 s limit downloading packages, and a failed preparation is reported instead of surfacing as a timeout.
import { spawn, type ChildProcess } from 'node:child_process';
import { pythonEnv, savePreparedPython, UV_ARGS } from '../pi-extensions/python-env.ts';

export type PythonState = { state: 'idle' | 'preparing' | 'ready' | 'failed'; error: string };
const status: PythonState = { state: 'idle', error: '' };
let ready: Promise<void> | null = null;
let child: ChildProcess | null = null;

export function pythonStatus(): PythonState { return { ...status }; }
/** Starts (once) and returns the preparation; bounded to 10 minutes. */
export function ensurePython(directory: string, timeoutMs = 600_000): Promise<void> {
  ready ??= new Promise<void>((resolve, reject) => {
    status.state = 'preparing';
    const env = pythonEnv({ ...process.env, MEETING_DATA_DIR: directory });
    // uv may run in a disposable overlay: record the package venv, not that temporary sys.prefix.
    child = spawn('uv', [...UV_ARGS, 'python', '-c', 'import json, sys, pathlib, numpy, scipy, sympy; roots = (p for p in pathlib.Path(numpy.__file__).resolve().parents if (p / "pyvenv.cfg").is_file()); print(json.dumps({"environment": str(next(roots, pathlib.Path(sys.prefix)))}))'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', output = '', finished = false;
    const timer = setTimeout(() => { child?.kill('SIGKILL'); }, timeoutMs);
    child.stderr!.on('data', part => { err = (err + part).slice(-500); });
    child.stdout!.on('data', part => { output = (output + part).slice(-16_000); });
    const done = (error: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child = null;
      const fail = (message: string) => { status.state = 'failed'; status.error = message; ready = null; reject(new Error(`The Python environment for calculations could not be prepared: ${message}`)); };
      if (error !== null) { fail(error); return; }
      // Calculations must reuse this already-synced environment: creating another one inside Seatbelt would need forbidden links.
      void (async () => {
        try {
          const value = JSON.parse(output.trim().split('\n').at(-1) ?? 'null');
          await savePreparedPython(value?.environment, env);
          status.state = 'ready'; status.error = ''; resolve();
        } catch (problem) { fail((problem as Error).message); }
      })();
    };
    child.on('error', error => done(error.message));
    child.on('close', code => done(code === 0 ? null : err.trim() || `exit ${code}`));
  });
  return ready;
}
/** Stops a preparation still running (server shutdown). */
export function stopPython() { child?.kill('SIGKILL'); }
