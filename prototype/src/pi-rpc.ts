import { spawn, type ChildProcess } from 'node:child_process';
import { piCommand, piEnv, piKeysVersion } from './pi-command.ts';

export type PiAnswer = {
  text: string; provider?: string; model?: string; usage?: unknown; ms: number; attempts: number;
  /** How the final message ended, whether Pi reported the run aborted, and the provider error text if any. */
  stopReason?: string; aborted: boolean; errorMessage?: string;
  /** Usage of every attempt (a retried empty answer still costs quota). */
  usages: unknown[];
};
export type PiRpcOptions = {
  /** Model as Pi names it, e.g. openai-codex/gpt-6-luna. */
  model: string;
  cwd: string;
  command?: string;
  /** Extra CLI arguments before the defaults are applied (tests use this for a fake child). */
  args?: string[];
  timeoutMs?: number;
  /** Deadline for Pi to acknowledge a command (tests shorten it). */
  ackMs?: number;
  log?: (message: string) => void;
  /** Replaces Pi's default coding-assistant system prompt (about 400 tokens on every request) for tasks that do not need it. */
  systemPrompt?: string;
};

/** Select at admission, not after earlier requests finish. Retired processes drain accepted work before closing. */
export class ModelRpc {
  private current?: PiRpc;
  private keys = piKeysVersion();
  private retiring = new Set<Promise<void>>();
  private closed = false;
  private model: () => Promise<string>;
  private options: Omit<PiRpcOptions, 'model'>;
  constructor(model: () => Promise<string>, options: Omit<PiRpcOptions, 'model'>) { this.model = model; this.options = options; }
  async ask(message: string): Promise<PiAnswer> {
    const model = await this.model();
    if (this.closed) throw new Error('Pi quick lane has stopped.');
    // A changed saved key also needs a new process: Pi reads its environment once, at start.
    if (this.current?.options.model !== model || this.keys !== piKeysVersion()) {
      this.keys = piKeysVersion();
      const old = this.current;
      this.current = new PiRpc({ ...this.options, model });
      if (old) {
        const retiring = old.drain().then(() => old.close()).finally(() => this.retiring.delete(retiring));
        this.retiring.add(retiring);
      }
    }
    return this.current.ask(message);
  }
  async close() {
    this.closed = true;
    await this.current?.drain();
    await this.current?.close();
    await Promise.allSettled([...this.retiring]);
  }
}

type Pending = { resolve: (response: any) => void; reject: (error: Error) => void };
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const ACK_MS = 10_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_QUEUED = 20;

/**
 * The quick lane: one warm `pi --mode rpc` process, one request at a time, and a fresh
 * session after every request so prompts never see each other's context.
 */
export class PiRpc {
  options: PiRpcOptions;
  private child?: ChildProcess;
  private buffer = '';
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: any) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private queued = 0;
  private notices = new Set<string>();
  constructor(options: PiRpcOptions) { this.options = options; }

  /** Serialized: a caller waits for earlier requests instead of interleaving events. */
  ask(message: string, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<PiAnswer> {
    if (this.queued >= MAX_QUEUED) return Promise.reject(new Error('Pi quick lane is overloaded; request dropped.'));
    this.queued++;
    const run = this.queue.catch(() => {}).then(() => this.askOnce(message, timeoutMs)).finally(() => { this.queued--; });
    this.queue = run;
    return run;
  }

  private async askOnce(message: string, timeoutMs: number): Promise<PiAnswer> {
    if (this.closing) throw new Error('Pi quick lane has stopped.');
    const started = performance.now();
    const usages: unknown[] = [];
    // An account failover can end a run with an empty answer; retry once on the next account.
    for (let attempt = 1; ; attempt++) {
      let final: any, aborted = false;
      try { ({ final, aborted } = await this.run(message, timeoutMs)); }
      catch (error) {
        // An abandoned run may still answer later; never let that answer reach the next request.
        this.restart();
        // Carry what this request already cost (earlier attempts), so quota accounting does not lose it.
        throw Object.assign(error as Error, { usages, attempts: attempt });
      }
      // Never serve the next request from a session that might still hold this one's context.
      const reset = await this.command({ type: 'new_session' }).catch((error: Error) => ({ success: false, error: error.message }));
      if (!reset.success) {
        this.restart();
        this.options.log?.(`Pi session reset failed (${reset.error ?? 'rejected'}); restarted the quick lane.`);
      }
      const text = (final?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
      if (final?.usage) usages.push(final.usage);
      if (text.trim() || attempt === 2) {
        if (final?.stopReason === 'error' && !text.trim()) throw Object.assign(new Error(`Pi answered with an error: ${final.errorMessage ?? 'unknown'}`), { usages, attempts: attempt });
        return { text, provider: final?.provider, model: final?.model, usage: final?.usage, ms: performance.now() - started, attempts: attempt,
          stopReason: final?.stopReason, aborted, errorMessage: final?.errorMessage, usages };
      }
      this.options.log?.('Pi returned an empty answer; retrying once.');
    }
  }

  private run(message: string, timeoutMs: number): Promise<{ final: any; aborted: boolean }> {
    this.ensureStarted();
    return new Promise((resolve, reject) => {
      let final: any, aborted = false;
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
        if (error) reject(error); else resolve({ final, aborted });
      };
      const onEvent = (event: any) => {
        if (event.type === 'message_end' && event.message?.role === 'assistant') final = event.message;
        else if (event.type === 'agent_settled') { aborted = Boolean(event.aborted); done(); }
        else if (event.type === 'exit') done(new Error('Pi exited during a request.'));
      };
      const timer = setTimeout(() => {
        done(new Error(`Pi did not answer within ${Math.round(timeoutMs / 1000)} s.`));
        this.restart(); // The abandoned run may still be streaming; start clean next time.
      }, timeoutMs);
      this.listeners.add(onEvent); // Subscribe before prompting so a fast completion is not missed.
      this.command({ type: 'prompt', message }).then(response => {
        if (!response.success) done(new Error(`Pi rejected the prompt: ${response.error}`));
        else if (response.data?.disposition === 'handled') done();
      }, done);
    });
  }

  private command(command: Record<string, unknown>): Promise<any> {
    const child = this.ensureStarted();
    const id = `c${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const ackMs = this.options.ackMs ?? ACK_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not acknowledge ${command.type} within ${ackMs / 1000} s.`));
      }, ackMs);
      this.pending.set(id, {
        resolve: response => { clearTimeout(timer); resolve(response); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private ensureStarted(): ChildProcess {
    if (this.child) return this.child;
    if (this.closing) throw new Error('Pi quick lane has stopped.');
    const args = this.options.args ?? ['--mode', 'rpc', '--no-session', '--no-tools', '--no-context-files', '--model', this.options.model, '--thinking', 'low',
      ...(this.options.systemPrompt ? ['--system-prompt', this.options.systemPrompt] : [])];
    const child = spawn(piCommand(this.options.command), args, { cwd: this.options.cwd, env: piEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    child.stdout!.setEncoding('utf8');
    // Output from a replaced (timed-out) process must never reach the current one's requests.
    child.stdout!.on('data', (part: string) => { if (this.child === child) this.onData(part); });
    child.stderr!.on('data', () => {}); // Diagnostics only; never protocol data.
    child.stdin!.on('error', () => {}); // Reported through exit.
    child.on('error', error => this.onExit(child, error));
    child.on('exit', code => this.onExit(child, new Error(`Pi exited (${code}).`)));
    return child;
  }

  private onData(part: string) {
    this.buffer += part;
    const oversized = () => {
      this.options.log?.('Pi produced an oversized record; restarting the quick lane.');
      this.restart();
    };
    // Split only on LF: U+2028/U+2029 are valid inside JSON strings (readline would break them).
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      if (index > MAX_BUFFER) return oversized();
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: any;
      try { record = JSON.parse(line); } catch { this.options.log?.(`Unparseable Pi output: ${line.slice(0, 120)}`); continue; }
      if (record.type === 'response' && record.id && this.pending.has(record.id)) {
        this.pending.get(record.id)!.resolve(record);
        this.pending.delete(record.id);
      } else if (record.type === 'extension_ui_request') {
        if (DIALOGS.has(record.method)) {
          // Nobody can answer a dialog here; an unanswered one would block the request.
          this.child?.stdin!.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true })}\n`);
          this.options.log?.(`Cancelled a Pi ${record.method} dialog: ${String(record.title ?? record.message ?? '').slice(0, 120)}`);
        } else if (record.method === 'notify') {
          // Extensions repeat startup notices on every new session; log each distinct notice once.
          const notice = String(record.message).slice(0, 200);
          if (!this.notices.has(notice)) { this.notices.add(notice); this.options.log?.(`Pi: ${notice}`); }
        }
      } else for (const listener of [...this.listeners]) listener(record);
    }
    if (this.buffer.length > MAX_BUFFER) oversized();
  }

  private onExit(child: ChildProcess, error: Error) {
    if (this.child !== child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of [...this.listeners]) listener({ type: 'exit' });
  }

  private restart() {
    const child = this.child;
    if (!child) return;
    this.onExit(child, new Error('Pi was restarted.'));
    child.kill('SIGKILL');
  }

  /** Resolves once every request already admitted has finished (used before retiring this process). */
  drain(): Promise<void> { return this.queue.then(() => {}, () => {}); }
  async close() {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin!.end(); // Closing stdin asks Pi for an orderly shutdown.
    });
  }
}
