/**
 * run_python: the Compute action's only way to execute code (M3 design, decision 1).
 * Loaded per task with `pi -e <this file>`; the task's cwd is the job's scratch folder.
 *
 * Bounds: scratch folder only, 120 s per run (RUN_PYTHON_MS), at most 6 runs per task (RUN_PYTHON_MAX_RUNS), 20 KB each of stdout and stderr, one thread per
 * math library, and the owner cleans attributed descendants on timeout, cancel, the script's end or Pi's exit. Native code
 * can disclaim responsibility (see python-owner.c); this is not complete hostile-process containment. `uv` supplies pinned
 * packages, offline (prepared by the server beforehand); the script runs in tool-sandbox.ts's sandbox without credentials.
 *
 * With a process folder (MEETING_PROCESS_DIR, set by runPiTask's `processDir`), each script's group is recorded there before the
 * script starts and removed after it ends, so the server can end it even when Pi was killed and its exit handler never ran.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGES, pythonEnv, UV_ARGS } from './python-env.ts';
import { spawnGated, type Gated } from './process-groups.ts';
import { pythonOwner, sweepPython } from './python-owner.ts';
import { sandboxed, toolEnv } from './tool-sandbox.ts';

const RUN_MS = Number(process.env.RUN_PYTHON_MS ?? 120_000);
const MAX_RUNS = Number(process.env.RUN_PYTHON_MAX_RUNS ?? 6); // the plan pass sets fewer (M7b)
const MAX_BYTES = 20_000;
const PROCESS_DIR = process.env.MEETING_PROCESS_DIR;

/** Collects at most MAX_BYTES of a stream, counting bytes, and remembers whether anything was cut. */
function capped() {
  const parts: Buffer[] = [];
  let bytes = 0, truncated = false;
  return {
    take(part: Buffer) {
      if (bytes >= MAX_BYTES) { truncated = true; return; }
      const room = MAX_BYTES - bytes;
      parts.push(part.length > room ? part.subarray(0, room) : part);
      if (part.length > room) truncated = true;
      bytes += Math.min(part.length, room);
    },
    text() { return Buffer.concat(parts).toString('utf8') + (truncated ? `\n[truncated at ${MAX_BYTES} bytes]` : ''); },
  };
}

export default function runPython(pi: ExtensionAPI) {
  const cwd = process.cwd();
  // Continuations retain the original numbering and tool definition, but cannot start more checks.
  let runs = Math.max(0, Number(process.env.RUN_PYTHON_USED ?? 0) || 0);
  const readOnly = process.env.RUN_PYTHON_USED !== undefined;
  const groups = new Set<number>();
  const killGroup = (pid: number) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } groups.delete(pid); };
  // If Pi exits (cancel, timeout, shutdown) while a script runs, its process group goes with it.
  process.once('exit', () => { for (const pid of groups) killGroup(pid); });
  pi.registerTool({
    name: 'run_python',
    label: 'Run Python',
    executionMode: 'sequential',
    description: `Run a short Python 3.12 script for a calculation (numpy, scipy, sympy available). The script runs in a scratch folder with a ${RUN_MS / 1000} s limit; at most ${MAX_RUNS} runs per task. Print the results you need.`,
    promptSnippet: 'Run a short Python calculation (numpy, scipy, sympy) and read its printed output',
    promptGuidelines: [
      'Use run_python only for small calculations, checks and tables. Never run experiment suites, benchmarks or large simulations, and never write outside the current folder.',
      'Materials may be read with read/grep, not modified. If a question needs a bigger run, say so as an open point instead of running it.',
    ],
    parameters: Type.Object({ code: Type.String({ description: 'Complete Python script; print what you need' }) }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('Cancelled before running.');
      if (readOnly || runs >= MAX_RUNS) throw new Error(`run_python limit reached (${MAX_RUNS} runs in this task).`);
      const runNumber = ++runs;
      const script = `run-${runNumber}.py`;
      await writeFile(join(cwd, script), params.code, { mode: 0o600 });
      if (signal?.aborted) throw new Error('Cancelled before running.');
      const temporary = join(cwd, '.tmp');
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      const env = { ...pythonEnv(toolEnv(process.env)), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' };
      const [program, argv] = sandboxed('uv', [...UV_ARGS, '--offline', 'python', script], cwd, env);
      const command = await pythonOwner(cwd, env), args = [program, ...argv];
      const stdout = capped(), stderr = capped();
      type Outcome = { code: number | null; signal: string | null; timedOut: boolean; error?: string };
      // Recorded before it starts (when the task has a process folder); a script that cannot be recorded does not run.
      let gated: Gated | null = null;
      let unrecorded: Outcome | null = null;
      if (PROCESS_DIR) {
        try { gated = await spawnGated(command, args, { dir: PROCESS_DIR, kind: 'python', cwd, env, stdio: ['ignore', 'pipe', 'pipe'], lifetime: true }); }
        catch (error) { unrecorded = { code: null, signal: null, timedOut: false, error: (error as Error).message }; }
      }
      const result = unrecorded ?? await new Promise<Outcome>(resolve => {
        const child = gated?.child ?? spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
        let timedOut = false, finished = false;
        let exited: Outcome | null = null;
        let drain: NodeJS.Timeout | undefined;
        if (child.pid) groups.add(child.pid);
        // Closing the lifeline asks the isolated owner to kill attributed descendants, including escaped sessions.
        const stop = () => { child.stdio[4]?.destroy(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, RUN_MS);
        const finish = (value: Outcome) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearTimeout(drain);
          signal?.removeEventListener('abort', stop);
          // The native owner has cleaned its attributed descendants before normal completion; end the gate/sentinel too.
          child.stdio[4]?.destroy();
          if (child.pid) killGroup(child.pid);
          resolve(value);
        };
        signal?.addEventListener('abort', stop, { once: true });
        child.stdout!.on('data', stdout.take);
        child.stderr!.on('data', stderr.take);
        child.on('error', error => finish({ code: null, signal: null, timedOut: false, error: error.message }));
        child.on('exit', (code, sig) => {
          // The leader's limit ends at exit, not when descendants eventually close inherited pipes.
          clearTimeout(timer);
          exited = { code, signal: sig, timedOut };
          stop();
          drain = setTimeout(() => {
            child.stdout?.destroy(); child.stderr?.destroy();
            finish(exited!);
          }, 1000);
        });
        child.on('close', (code, sig) => finish(exited ?? { code, signal: sig, timedOut }));
        if (signal?.aborted) stop();
        else gated?.release();
      });
      if (gated) await rm(gated.path, { force: true }).catch(() => {});
      try { await sweepPython(cwd, env, command); }
      catch { console.warn('Best-effort Python leftover cleanup was unavailable; the calculation result is unchanged.'); }
      const status = result.error ? `could not start: ${result.error}` : result.timedOut ? `timed out after ${RUN_MS / 1000} s`
        : result.code === 0 ? 'exit 0' : `exit ${result.code ?? result.signal}`;
      const out = stdout.text(), err = stderr.text();
      const details = { runNumber, script, status, exitCode: result.code, signal: result.signal, timedOut: result.timedOut, packages: PACKAGES, stdout: out, stderr: err };
      const text = `${status}\n${out || '(no output)'}${err ? `\n--- stderr ---\n${err}` : ''}`;
      return result.code === 0 && !result.timedOut ? { content: [{ type: 'text', text: out || '(no output)' }], details } : { content: [{ type: 'text', text }], details, isError: true };
    },
  });
}
