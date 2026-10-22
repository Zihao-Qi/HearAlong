import { execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePi } from '../pi-command.ts';

export type PiModel = { id: string; provider: string; model: string; context: string; maxOut: string; thinking: boolean; images: boolean };
export type ModelList = { state: 'ok' | 'signed-out' | 'unreadable' | 'not-installed'; models: PiModel[]; count: number; providers: string[] };
export type Readiness = { state: 'ready' | 'not_ready' | 'unknown'; detail?: string };
export const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, 500);
const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const empty = (state: ModelList['state']): ModelList => ({ state, models: [], count: 0, providers: [] });
export function parseModels(stdout: string): ModelList {
  const lines = plain(stdout).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (/^No models available\./.test(lines[0] ?? '')) return empty('signed-out');
  if (lines.shift()?.split(/\s+/).join(' ') !== 'provider model context max-out thinking images') return empty('unreadable');
  const models: PiModel[] = [];
  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 6 || !fields.slice(4).every(v => v === 'yes' || v === 'no') || !fields.slice(2, 4).every(v => /^\d+(?:\.\d+)?[KMB]?$/.test(v))) return empty('unreadable');
    const [provider, model, context, maxOut, thinking, images] = fields;
    models.push({ id: `${provider}/${model}`, provider, model, context, maxOut, thinking: thinking === 'yes', images: images === 'yes' });
  }
  return models.length ? { state: 'ok', models, count: models.length, providers: [...new Set(models.map(m => m.provider))] } : empty('unreadable');
}
export function hasWebPackage(stdout: string): boolean {
  return /^ {2}npm:pi-web-access(?:@[^\s]+)?(?: \(filtered\))?\r?\n {4}\S[^\r\n]*$/m.test(plain(stdout));
}

export type PiModelsOptions = { cwd: string; env?: NodeJS.ProcessEnv; root?: string; clock?: () => number; timeoutMs?: number };
export class PiModels {
  last: ModelList | null = null;
  private readAt = -Infinity;
  private pending?: Promise<ModelList>;
  private children = new Set<ChildProcess>();
  private closed = false;
  readonly options: PiModelsOptions;
  constructor(options: PiModelsOptions) { this.options = options; }
  private execute(args: string[]): Promise<{ code: number | null; stdout: string; missing?: boolean; failed: boolean }> {
    if (this.closed) return Promise.resolve({ code: null, stdout: '', failed: true });
    const env = this.options.env ?? process.env;
    const command = resolvePi({ env, root: this.options.root });
    if (!command) return Promise.resolve({ code: null, stdout: '', missing: true, failed: true });
    return new Promise(resolve => {
      const child = execFile(command, args, { cwd: this.options.cwd, env, timeout: this.options.timeoutMs ?? 10_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        const code = !error ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, missing: error?.code === 'ENOENT', failed: Boolean(error) });
      });
      this.children.add(child);
      child.once('close', () => this.children.delete(child));
    });
  }
  /** Runner-only retry policy. UI reads still never cache a non-ok result. */
  staleForRunner(): boolean {
    return !this.last || (this.options.clock ?? Date.now)() - this.readAt >= (this.last.state === 'ok' ? 5 * 60_000 : 30_000);
  }
  read(refresh = false): Promise<ModelList> {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve(this.last ?? empty('unreadable'));
    const clock = this.options.clock ?? Date.now;
    if (!refresh && this.last?.state === 'ok' && clock() - this.readAt < 5 * 60_000) return Promise.resolve(this.last);
    this.pending = this.execute(['--no-context-files', '--list-models']).then(result => {
      this.last = result.missing ? empty('not-installed') : result.failed ? empty('unreadable') : parseModels(result.stdout);
      this.readAt = clock();
      return this.last;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async auth(id: string): Promise<Readiness> {
    const result = await this.execute(['auth', 'check', '--model', id, '--json', '--no-refresh']);
    try {
      const value = JSON.parse(result.stdout);
      if (result.code === 0 && value?.status === 'ready') return { state: 'ready' };
      if ((result.code === 0 || result.code === 1) && value?.status === 'not_ready' && typeof value.reason === 'string' && oneLine(value.reason)) return { state: 'not_ready', detail: oneLine(value.reason) };
    } catch { /* Unknown output, timeout and spawn errors are not proof of access. */ }
    return { state: 'unknown', detail: "Couldn't check Pi's access." };
  }
  async web(): Promise<boolean> {
    const result = await this.execute(['list']);
    if (result.failed || !hasWebPackage(result.stdout)) return false;
    const env = this.options.env ?? process.env;
    try {
      const settings = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'settings.json'), 'utf8'));
      const packages: unknown[] = Array.isArray(settings?.packages) ? settings.packages : [];
      const declaration = packages.find((item: any) => /^npm:pi-web-access(?:@[^\s]+)?$/.test(typeof item === 'string' ? item : item?.source ?? '')) as { extensions?: unknown } | undefined;
      if (Array.isArray(declaration?.extensions) && declaration.extensions.length === 0) return false;
      // Partial filters use package-relative globs and can target dynamically registered extensions. We cannot
      // reliably identify the web_search registrar from the declaration alone; count nonempty filters as present.
      // An absent/unreadable user declaration may also mean installation came from project settings.
    } catch { /* Installation is known; retain it when the declaration cannot be determined. */ }
    return true;
  }
  /** Own every probe, including foreground reads: kill and join pipes/exit before releasing shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.children].map(child => new Promise<void>(resolve => {
      child.once('close', resolve);
      child.kill('SIGKILL');
    })));
  }
}
