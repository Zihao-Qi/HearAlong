/** Small JavaScript calculations, in fresh permission-restricted Node processes under Seatbelt. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnGated, type Gated } from './process-groups.ts';
import { calculationEnv, sandboxed } from './tool-sandbox.ts';

const MAX_BYTES = 20_000;
const HEAP_MB = 256, FOOTPRINT_MB = 512, MEMORY_POLL_MS = 100, MEMORY_CHECK_MS = 250, MEMORY_PROBE_MS = 5000;
const RUNNER = realpathSync(fileURLToPath(new URL('./calculate-runner.cjs', import.meta.url)));

/** Only the library and its dependency closure, never all of node_modules or the application. */
export function libraryRoots(from = RUNNER): { roots: string[]; entry: string } {
  const roots = new Set<string>();
  let mathEntry = '';
  const visit = (name: string, from: string) => {
    const require = createRequire(from);
    let location: string;
    // Some dependencies (e.g. @babel/runtime) export subpaths but no root entry.
    try { location = require.resolve(`${name}/package.json`); }
    catch {
      try { location = require.resolve(name); }
      catch (error) { if (name === 'mathjs' && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return; throw error; }
    }
    if (name === 'mathjs') mathEntry = realpathSync(require.resolve(name));
    let root = dirname(realpathSync(location));
    for (;;) {
      try {
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        if (manifest.name === name) {
          if (roots.has(root)) return;
          roots.add(root);
          for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, join(root, 'package.json'));
          return;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(root);
      if (parent === root) throw new Error(`Cannot locate bundled library ${name}.`);
      root = parent;
    }
  };
  visit('mathjs', from);
  return { roots: [...roots], entry: mathEntry };
}

/** `top` MEM is macOS physical footprint (including compressed pages), not RSS. */
export function physicalFootprintBytes(output: string, pid: number): number | null {
  const row = output.split('\n').map(line => line.trim().split(/\s+/)).find(fields => fields[0] === String(pid));
  const match = row?.length === 2 && row[1].match(/^(\d+(?:\.\d+)?)([BKMGT])[+-]?$/);
  if (!match) return null;
  const bytes = Number(match[1]) * 1024 ** 'BKMGT'.indexOf(match[2]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

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

export default function calculate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const runMs = Number(process.env.CALCULATE_MS ?? 120_000), maxRuns = Number(process.env.CALCULATE_MAX_RUNS ?? 6);
  const processDir = process.env.MEETING_PROCESS_DIR;
  let runs = Math.max(0, Number(process.env.CALCULATE_USED ?? 0) || 0);
  const readOnly = process.env.CALCULATE_USED !== undefined;
  const groups = new Set<number>();
  const killGroup = (pid: number) => {
    let killed = false;
    try { process.kill(-pid, 'SIGKILL'); killed = true; } catch { /* already gone */ }
    groups.delete(pid); return killed;
  };
  process.once('exit', () => { for (const pid of groups) killGroup(pid); });
  pi.registerTool({
    name: 'calculate', label: 'Calculate', executionMode: 'sequential',
    description: `Run a short JavaScript snippet on HearAlong's bundled Node with bundled mathjs as global math. Only console.log/console.error output is returned; final expressions are not printed automatically. Numbers are IEEE doubles unless you use math.bignumber or math.fraction. Fresh process, ${runMs / 1000} s limit, at most ${maxRuns} runs per task. No lexical require. Seatbelt denies task-file access, file writes (except /dev/null), networking and signals to other processes; Node 22 permissions do not control networking. Node permissions additionally deny starting programs, workers, addons, WASI and inspector access. Memory: ${HEAP_MB} MB V8 old space and a ${FOOTPRINT_MB} MB sampled physical-footprint watchdog (including compressed memory, not a hard quota). Code waits for the first memory check; the process group pauses when a check is overdue (${MEMORY_CHECK_MS} ms run window) and resumes only after a valid sample under the limit. Failed checks are retried; paused time counts toward the time limit. Read materials with Pi's file tools. Nothing is installed or downloaded.`,
    promptSnippet: 'Calculate using JavaScript and bundled mathjs; console.log the results',
    promptGuidelines: [
      'Use calculate only for small calculations, checks and tables, never experiment suites, benchmarks or large simulations.',
      'Materials may be read with read/grep, not calculation code. If a question needs a bigger run, say so as an open point.',
    ],
    parameters: Type.Object({ code: Type.String({ description: 'JavaScript snippet; console.log the results you need. math is mathjs.' }) }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('Cancelled before running.');
      if (readOnly || runs >= maxRuns) throw new Error(`calculate limit reached (${maxRuns} runs in this task).`);
      const runNumber = ++runs, script = `run-${runNumber}.js`;
      await writeFile(join(cwd, script), params.code, { mode: 0o600 });
      if (signal?.aborted) throw new Error('Cancelled before running.');
      const env = calculationEnv(process.env), { roots: libraries, entry } = libraryRoots();
      const nodeArgs = ['--permission', '--no-addons', '--disable-sigusr1', `--max-old-space-size=${HEAP_MB}`, `--allow-fs-read=${RUNNER}`,
        ...libraries.map(root => `--allow-fs-read=${root}`), RUNNER, entry];
      // Policy construction uses trusted parent paths, but none of that environment reaches the child.
      const [command, args] = sandboxed(process.execPath, nodeArgs, cwd, process.env, [RUNNER, ...libraries], 'calculation');
      const stdout = capped(), stderr = capped();
      type Outcome = { code: number | null; signal: string | null; timedOut: boolean; error?: string };
      let gated: Gated | null = null, unrecorded: Outcome | null = null;
      if (processDir) {
        try { gated = await spawnGated(command, args, { dir: processDir, kind: 'calc', cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (error) { unrecorded = { code: null, signal: null, timedOut: false, error: (error as Error).message }; }
      }
      const result = unrecorded ?? await new Promise<Outcome>(resolve => {
        const child = gated?.child ?? spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let timedOut = false, finished = false, memoryExceeded = false, stopping = false;
        let paused = false, codeSent = false, killedByGuard = false, lastMemorySample: number | undefined;
        let memoryError: string | undefined, memorySignalError: string | undefined;
        let memoryTimer: NodeJS.Timeout | undefined, checkTimer: NodeJS.Timeout | undefined;
        let memoryProbe: ReturnType<typeof execFile> | undefined;
        if (child.pid) groups.add(child.pid);
        // SIGKILL also ends stopped members, including the recording gate and its sentinel.
        const stop = () => { if (stopping) return; stopping = true; if (child.pid) killedByGuard = killGroup(child.pid); };
        const pause = () => {
          if (stopping || !child.pid || paused) return;
          try { process.kill(-child.pid, 'SIGSTOP'); paused = true; }
          catch { memorySignalError = 'could not pause calculation for memory check'; stop(); }
        };
        // Buffer/ArrayBuffer storage is outside V8's heap. RSS misses compressed pages on macOS.
        // Stock macOS top's MEM is physical footprint, as in Activity Monitor. Sample from the trusted parent.
        // -F/-R avoid framework/map walks. Probes may take 5 s, but never extend the 250 ms run window.
        // Measured top latency was 58–839 ms: slow samples pause work rather than killing it or leaving it unchecked.
        const sampleMemory = () => {
          if (finished || stopping || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
          memoryProbe = execFile('/usr/bin/top', ['-l', '1', '-F', '-R', '-stats', 'pid,mem', '-pid', String(child.pid)], { env: { LC_ALL: 'C' }, timeout: MEMORY_PROBE_MS }, (error, output) => {
            memoryProbe = undefined;
            if (finished || stopping || child.exitCode !== null || child.signalCode !== null) return;
            const bytes = physicalFootprintBytes(String(output), child.pid!);
            if (error || bytes === null) {
              pause();
              memoryTimer = setTimeout(sampleMemory, MEMORY_POLL_MS); return;
            }
            if (bytes > FOOTPRINT_MB * 1024 * 1024) { memoryExceeded = true; stop(); return; }
            lastMemorySample = performance.now();
            clearTimeout(checkTimer);
            if (paused) {
              try { process.kill(-child.pid!, 'SIGCONT'); paused = false; }
              catch { memorySignalError = 'could not resume calculation after memory check'; stop(); return; }
            }
            checkTimer = setTimeout(pause, MEMORY_CHECK_MS);
            // Neither the recording gate nor sandbox-exec can evaluate a snippet before stdin is sent.
            if (!codeSent) { codeSent = true; child.stdin!.end(params.code); }
            memoryTimer = setTimeout(sampleMemory, MEMORY_POLL_MS);
          });
        };
        const timer = setTimeout(() => {
          timedOut = true;
          if (!codeSent || lastMemorySample === undefined || performance.now() - lastMemorySample >= MEMORY_PROBE_MS) memoryError = 'timed out: calculation memory could not be checked';
          stop();
        }, runMs);
        const finish = (value: Outcome) => {
          if (finished) return;
          finished = true; clearTimeout(timer); clearTimeout(memoryTimer); clearTimeout(checkTimer); memoryProbe?.kill();
          signal?.removeEventListener('abort', stop); stop();
          // macOS can reject STOP/CONT on an unreaped zombie. Kill immediately, but use the reaped outcome:
          // the permission-restricted unrecorded child cannot leave descendants. If no KILL was delivered and its exit
          // is confirmed, nothing live remains. Recorded groups may still have a live sentinel: retain their errors.
          if (memorySignalError && (gated || killedByGuard || (value.code === null && value.signal === null))) memoryError ??= memorySignalError;
          resolve(memoryExceeded ? { ...value, error: `memory limit exceeded (${FOOTPRINT_MB} MB physical footprint)` }
            : memoryError ? { ...value, error: memoryError } : value);
        };
        signal?.addEventListener('abort', stop, { once: true });
        child.stdout!.on('data', stdout.take); child.stderr!.on('data', stderr.take);
        child.stdin!.on('error', () => {}); // cancellation can close the pipe before the snippet has been sent
        child.on('error', error => finish({ code: null, signal: null, timedOut: false, error: error.message }));
        child.on('exit', stop); // also ends the recording gate's sentinel
        child.on('close', (code, sig) => finish({ code, signal: sig, timedOut }));
        if (signal?.aborted) stop();
        else { pause(); gated?.release(); sampleMemory(); }
      });
      if (gated) await rm(gated.path, { force: true }).catch(() => {});
      const out = stdout.text(), err = stderr.text();
      const memoryExceeded = Boolean(result.error?.startsWith('memory limit exceeded')) || (result.code !== 0 && /FATAL ERROR:.*(?:heap|Allocation failed)/i.test(err));
      const status = memoryExceeded ? result.error ?? `memory limit exceeded (${HEAP_MB} MB V8 old space)`
        : result.error ? `calculation failed: ${result.error}` : result.timedOut ? `timed out after ${runMs / 1000} s`
        : result.code === 0 ? 'exit 0' : `exit ${result.code ?? result.signal}`;
      const details = { runNumber, script, language: 'javascript', status, exitCode: result.code, signal: result.signal, timedOut: result.timedOut, memoryExceeded, oldSpaceLimitMb: HEAP_MB, physicalFootprintLimitMb: FOOTPRINT_MB, packages: ['mathjs'], stdout: out, stderr: err };
      const output = `${out || '(no output)'}${err ? `\n--- stderr ---\n${err}` : ''}`;
      const text = `${status}\n${output}`;
      return result.code === 0 && !result.error && !result.timedOut && !signal?.aborted ? { content: [{ type: 'text', text: output }], details }
        : { content: [{ type: 'text', text }], details, isError: true };
    },
  });
}
