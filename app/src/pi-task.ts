import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { explicitTools, READ_SCOPE_ENV, readRoots } from '../pi-extensions/read-scope.ts';
import { BUNDLED_PI, isLocalModel, piCommand, piLaunch, watchPiRun, type AiMode } from './pi-command.ts';
import { localFailure, localLengthMessage } from './local-ai.ts';
import { inLocalPiLane } from './local-pi-lane.ts';
import { endRecorded, signalGroup, spawnGated, type ProcessRecord } from '../pi-extensions/process-groups.ts';

export type TaskModel = string | (() => string | Promise<string>);
export const taskModel = (model: TaskModel): string | Promise<string> => typeof model === 'function' ? model() : model;

export type PiTaskResult = {
  text: string; provider?: string; model?: string; usage?: unknown; ms: number;
  tools: { name: string; args: unknown; isError?: boolean }[]; aborted: boolean; stopReason?: string;
  /** The provider's error text when the final message stopped with an error (rate limits show here). */
  errorMessage?: string;
  /** How the process ended, and whether Pi reported the run as settled; callers that need a complete run check these. */
  exitCode: number | null; exitSignal: NodeJS.Signals | null; settled: boolean;
  /** Every tool event seen (start or end), including any without arguments. */
  toolEvents: number;
  /** Finished tool calls with their arguments and result text, paired by call ID (the evidence for web citations). */
  toolResults: ToolResult[];
  /** With a process folder: why its processes could not be confirmed ended (their records are kept for the next start). */
  cleanupError?: string;
};
export type ToolResult = {
  id: string; name: string; args: unknown; text: string; isError: boolean;
  /** The tool's structured data (e.g. per-page web results) and details, kept for code checks; never shown to the model. */
  structured?: unknown; details?: unknown;
};
/** Pairs a tool_execution_end event with its start arguments. Exported so callers that stream events can keep results live. */
export function toolResultOf(event: any, args: unknown): ToolResult {
  const text = (event.result?.content ?? []).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
  return { id: String(event.toolCallId), name: event.toolName, args, text, isError: Boolean(event.isError), structured: event.result?.structuredContent, details: event.result?.details };
}
export type PiTaskOptions = {
  model: string;
  aiMode?: AiMode;
  /** Scratch folder for the task; never the user's materials. */
  cwd: string;
  /** Where Pi writes its session log: the provenance record for this task. */
  sessionDir?: string;
  /** Continue this session file in place (takes precedence over sessionDir). */
  session?: string;
  /** Explicit plain-name allowlist. Null, omission, patterns or default-set modifiers disable tools and skills. */
  tools?: string | null;
  /** Attached material/snapshot paths, captured with realpath at launch; cwd is added. Missing: no tools. */
  readRoots?: string[];
  /** Files whose contents Pi puts into the first message (`@path`), so large inputs stay off the command line. */
  files?: string[];
  /** Extension files loaded for this task only (`-e path`), e.g. the Compute action's calculate tool. */
  extensions?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  command?: string;
  /** Preassembled CLI arguments, or an explicit command's subprocess fixture arguments. */
  args?: string[];
  onEvent?: (event: any) => void;
  /** Local lane admission time (also reported if cancelled in the queue); zero for cloud tasks. */
  onLocalWait?: (ms: number) => void;
  /** Thinking level for this task only (`--thinking low`); omitted: Pi's own setting. */
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Notes-only Ollama opt-in; independent of Pi's capability-clamped thinking level. */
  localNotesThinking?: boolean;
  /** `false` turns the user's skills off for this task (`--no-skills`); omitted: Pi's default, skills on. */
  skills?: boolean;
  /** Environment for this task's Pi on top of the server's (e.g. CALCULATE_MAX_RUNS for its calculate tool). */
  env?: NodeJS.ProcessEnv;
  /**
   * Process ownership (M7b §4): Pi runs as the leader of a process group of its own, recorded in this folder before it
   * starts, and calculate records each script's group here too (MEETING_PROCESS_DIR). The time limit, Cancel and Pi's exit
   * end Pi's group and every group recorded; the folder is removed once that is confirmed. A server start ends what a crash
   * (or a cleanup that could not be confirmed) left here. Omitted: Pi is an ordinary child process, as before.
   */
  processDir?: string;
  /** With `processDir`: called with Pi's record before Pi starts, which waits for it (a job saves its worker first). */
  onStart?: (worker: ProcessRecord) => void | Promise<void>;
};
/** Why a task was stopped: `cancelled` (the signal) or `timeout` (its time limit). Other failures have no reason. */
export type PiTaskError = Error & { reason?: 'cancelled' | 'timeout'; cleanupError?: string };
const stopped = (message: string, reason: 'cancelled' | 'timeout'): PiTaskError => Object.assign(new Error(message), { reason });
/** With a process folder: how long Pi's pipes may stay open after it exits (something else inherited them) before they are closed. */
export const PI_TASK_LIMITS = { drainMs: 2000, cleanupTries: 3, cleanupRetryMs: 300 };

export const READ_SCOPE_EXTENSION = fileURLToPath(new URL('../pi-extensions/read-scope.ts', import.meta.url));

export function piTaskArgs(prompt: string, options: PiTaskOptions): string[] {
  const scoped = explicitTools(options.tools) && options.readRoots !== undefined;
  const tools = scoped ? options.tools : null;
  return piLaunch([
    '--mode', 'json', '--model', options.model, '--no-context-files',
    ...(options.thinking ? ['--thinking', options.thinking] : []),
    ...(scoped ? [...(options.extensions ?? []), READ_SCOPE_EXTENSION] : []).flatMap(path => ['-e', path]),
    ...(tools === null ? ['--no-tools', '--no-skills'] : tools ? ['--tools', tools] : []),
    ...(options.skills === false && tools !== null ? ['--no-skills'] : []),
    ...(options.session ? ['--session', options.session] : options.sessionDir ? ['--session-dir', options.sessionDir] : ['--no-session']),
    '--', ...(options.files ?? []).map(file => `@${file}`), prompt,
  ], { mode: options.aiMode, model: options.model, cwd: options.cwd, env: { ...process.env, ...options.env } }).args;
}

/**
 * Ends what is recorded in a task's process folder and removes the folder once that is confirmed. If it cannot be (the
 * processes cannot be listed, or a group is still seen), it tries again, then keeps the records for the next server start.
 * Returns the problem, if any.
 */
async function cleanUp(dir: string): Promise<string | undefined> {
  let problem = '';
  for (let attempt = 0; attempt < PI_TASK_LIMITS.cleanupTries; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, PI_TASK_LIMITS.cleanupRetryMs));
    try {
      // A group this task may just have signalled is never written off as "not ours": its record stays until it is gone.
      const { kept } = await endRecorded(dir, undefined, { keepUnverified: true });
      if (!kept) { await rm(dir, { recursive: true, force: true }); return undefined; }
      problem = `${kept} process group(s) still running and not confirmed ended`;
    } catch (error) { problem = (error as Error).message; }
  }
  console.warn(`A Pi task could not confirm that its processes ended (${problem}); their records stay in ${dir} for the next start.`);
  return problem;
}

/** The heavy lane: one `pi --mode json` process per task, with a wall-clock limit. */
export async function runPiTask(prompt: string, options: PiTaskOptions): Promise<PiTaskResult> {
  const queued = performance.now();
  let admitted = false;
  const report = () => options.onLocalWait?.(isLocalModel(options.model) ? performance.now() - queued : 0);
  try {
    return await inLocalPiLane(options.model, () => {
      admitted = true; report();
      return runPiTaskOnce(prompt, options);
    }, options.signal);
  } finally { if (!admitted) report(); }
}

/** Preassembled Pi CLI arguments must not bypass the scope applied by piTaskArgs. */
function scopedArgs(args: string[], options: PiTaskOptions): string[] {
  const mode = args.indexOf('--mode');
  if (mode < 0) {
    if (!options.command) throw new Error('Custom Pi arguments must declare --mode.');
    return args; // An explicitly supplied subprocess fixture, not a Pi CLI launch.
  }
  const delimiter = args.indexOf('--', mode);
  const end = delimiter < 0 ? args.length : delimiter;
  let header = args.slice(mode, end);
  if (explicitTools(options.tools) && options.readRoots !== undefined) {
    if (!header.some((arg, index) => ['-e', '--extension'].includes(arg) && header[index + 1] === READ_SCOPE_EXTENSION)) header.push('-e', READ_SCOPE_EXTENSION);
  } else {
    header = header.filter((arg, index, all) => !['--tools', '-e', '--extension'].includes(arg) && !['--tools', '-e', '--extension'].includes(all[index - 1]));
    if (!header.includes('--no-tools')) header.push('--no-tools');
    if (!header.includes('--no-skills')) header.push('--no-skills');
  }
  return [...args.slice(0, mode), ...header, ...args.slice(end)];
}

function runPiTaskOnce(prompt: string, options: PiTaskOptions): Promise<PiTaskResult> {
  let args: string[];
  let scope: string | undefined;
  try {
    if (explicitTools(options.tools) && options.readRoots !== undefined) scope = JSON.stringify(readRoots([...options.readRoots, options.cwd]));
    const launch = piLaunch(options.args ? scopedArgs(options.args, options) : [], { mode: options.aiMode, model: options.model, cwd: options.cwd, env: { ...process.env, ...options.env } });
    args = options.args ? launch.args : piTaskArgs(prompt, options);
  } catch (error) { return Promise.reject(error); }
  const started = performance.now();
  const limitMs = options.timeoutMs ?? 300_000;
  // Cancelled before it started: never spawn a (cloud-calling) process.
  if (options.signal?.aborted) return Promise.reject(stopped('Pi task was cancelled.', 'cancelled'));
  let command: string;
  try { command = options.command ?? (scope ? BUNDLED_PI : piCommand(undefined, { ...process.env, ...options.env })); }
  catch (error) { return Promise.reject(error); }
  const processDir = options.processDir;
  const env = piLaunch([], { mode: options.aiMode, model: options.model, cwd: options.cwd, env: { ...process.env, ...options.env, ...(processDir ? { MEETING_PROCESS_DIR: processDir } : {}) } }).env;
  // Never inherit another task's roots, including through an options.env overlay.
  delete env[READ_SCOPE_ENV];
  delete env.RIPGREP_CONFIG_PATH;
  if (scope) env[READ_SCOPE_ENV] = scope;
  if (options.localNotesThinking && options.model.startsWith('ollama/')) env.MEETING_LOCAL_NOTES_THINKING = '1';
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    // With a process folder: Pi's own group, known once its record is saved.
    let group: number | undefined;
    let startError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // Set when Pi's process has exited. From then on nothing is released, and its group id is never signalled directly:
    // only while Pi is our live, unreaped child is that id certainly still its own (cleanup goes through the checked records).
    let exited = false;
    const live = () => Boolean(child) && !exited && child!.exitCode === null && child!.signalCode === null;
    let buffer = '';
    let stderr = '';
    let final: any;
    let settled: any;
    const tools: PiTaskResult['tools'] = [];
    let toolEvents = 0;
    const toolStarts: Map<string, { name: string; args: unknown }> = new Map();
    const toolResults: ToolResult[] = [];
    let timedOut = false;
    let cancelled = false;
    const stop = () => {
      if (!processDir) { child!.kill('SIGTERM'); setTimeout(() => child!.kill('SIGKILL'), 3000).unref(); return; }
      if (group === undefined || !live()) return; // not recorded yet (stopped as soon as it is), or already ended
      // Pi gets a moment to stop; its calculations do not need one.
      signalGroup(group, 'SIGTERM');
      void endRecorded(processDir, record => record.kind !== 'pi', { keepUnverified: true }).catch(() => {});
      const pgid = group;
      killTimer ??= setTimeout(() => { if (live()) signalGroup(pgid, 'SIGKILL'); }, 3000);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, limitMs);
    const abort = () => { cancelled = true; stop(); };
    const settle = (code: number | null, exitSignal: NodeJS.Signals | null, cleanupError?: string) => {
      const failed = (error: Error) => reject(cleanupError ? Object.assign(error, { cleanupError }) : error);
      if (startError) return failed(startError);
      if (cancelled) return failed(stopped('Pi task was cancelled.', 'cancelled'));
      if (timedOut) return failed(stopped(`Pi task exceeded ${Math.round(limitMs / 1000)} s.`, 'timeout'));
      if (code !== 0 && !final) return failed(new Error(`Pi task failed (exit ${code}): ${localFailure(options.model, stderr.trim().slice(-500))}`));
      const text = (final?.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
      if (final?.stopReason === 'length' && isLocalModel(options.model)) return failed(new Error(localLengthMessage(options.model)));
      if (final?.stopReason === 'error' && !text) return failed(new Error(`Pi task error: ${localFailure(options.model, final.errorMessage ?? 'unknown')}`));
      resolve({ text, provider: final?.provider, model: final?.model, usage: final?.usage, ms: performance.now() - started,
        tools: tools.filter(t => t.args !== undefined), aborted: Boolean(settled?.aborted), stopReason: final?.stopReason, errorMessage: final?.errorMessage ? localFailure(options.model, final.errorMessage) : undefined,
        exitCode: code, exitSignal, settled: Boolean(settled), toolEvents, toolResults, ...(cleanupError ? { cleanupError } : {}) });
    };
    const attach = (child: ChildProcess) => {
      const unwatch = watchPiRun(abort);
      child.once('close', unwatch);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (part: string) => {
        buffer += part;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          options.onEvent?.(event);
          if (typeof event.type === 'string' && event.type.startsWith('tool_execution')) toolEvents++;
          if (event.type === 'message_end' && event.message?.role === 'assistant') final = event.message;
          else if (event.type === 'tool_execution_end') {
            tools.push({ name: event.toolName, args: undefined, isError: event.isError });
            toolResults.push(toolResultOf(event, toolStarts.get(event.toolCallId)?.args));
          } else if (event.type === 'tool_execution_start') {
            tools.push({ name: event.toolName, args: event.args });
            toolStarts.set(event.toolCallId, { name: event.toolName, args: event.args });
          }
          else if (event.type === 'agent_settled') settled = event;
        }
      });
      child.stderr!.on('data', part => { stderr = (stderr + part.toString()).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(error); });
      if (!processDir) {
        child.on('close', (code, exitSignal) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); settle(code, exitSignal); });
        return;
      }
      // With a process folder the end is Pi's exit, not its pipes' close: whatever is left of its group (or recorded) is ended at
      // once, since a helper that inherited the pipes would hold them open. Then the pipes get a moment to drain.
      let closed = false;
      let onClosed = () => {};
      child.on('close', () => { closed = true; onClosed(); });
      child.on('exit', (code, exitSignal) => {
        exited = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
        cleanUp(processDir).then(async cleanupError => {
          if (!closed) await new Promise<void>(resolve => { onClosed = resolve; setTimeout(resolve, PI_TASK_LIMITS.drainMs).unref(); });
          if (!closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
          settle(code, exitSignal, cleanupError);
        }).catch(reject);
      });
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (!processDir) {
      child = spawn(command, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      attach(child);
      if (options.signal?.aborted) abort();
      return;
    }
    // Pi is recorded (and the caller has saved its worker) before it starts; until then it waits in a shell of its own group.
    (async () => {
      let gated;
      try { gated = await spawnGated(command, args, { dir: processDir, kind: 'pi', cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        await rm(processDir, { recursive: true, force: true }).catch(() => {});
        return reject(error);
      }
      child = gated.child;
      group = gated.record.pgid;
      attach(child);
      if (timedOut || cancelled) return stop();
      try { await options.onStart?.(gated.record); }
      catch (error) { startError = error as Error; if (live()) signalGroup(group, 'SIGKILL'); return; }
      // Stopped while its job saved it: a stop signalled it while it lived; an ended one is never released or signalled again.
      if (!live()) return;
      if (timedOut || cancelled) return stop();
      try { piLaunch([], { mode: options.aiMode, model: options.model, cwd: options.cwd, env: { ...process.env, ...options.env } }); }
      catch (error) { startError = error as Error; if (live()) signalGroup(group, 'SIGKILL'); return; }
      gated.release();
    })().catch(error => {
      if (child) {
        startError = error as Error;
        if (group !== undefined && live()) signalGroup(group, 'SIGKILL');
        return; // The exit path settles only after process-group cleanup.
      }
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/** A run counts only when complete: clean exit, Pi settled and not aborted, a normal stop and a non-empty answer. */
export function checkCompleted(result: PiTaskResult, what = 'The task'): PiTaskResult {
  const model = result.provider && result.model ? `${result.provider}/${result.model}` : result.model ?? '';
  if (result.stopReason === 'length' && isLocalModel(model)) throw new Error(localLengthMessage(model));
  if (result.exitCode !== 0 || result.exitSignal || !result.settled || result.aborted || result.stopReason !== 'stop' || !result.text.trim()) {
    throw new Error(`${what} did not finish normally (exit ${result.exitSignal ?? result.exitCode}, ${result.settled ? 'settled' : 'not settled'}, ${result.stopReason ?? 'no answer'})${result.errorMessage ? `: ${result.errorMessage}` : ''}.`);
  }
  return result;
}

/** Models often wrap JSON in prose or a code fence; take the outermost object. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in the model answer.');
  return JSON.parse(body.slice(start, end + 1));
}
