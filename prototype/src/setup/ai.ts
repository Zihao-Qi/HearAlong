import { checkCompleted, runPiTask, type PiTaskOptions, type PiTaskResult } from '../pi-task.ts';
import { PiModels, oneLine, type ModelList, type PiModelsOptions } from './pi-models.ts';

export type AiSettings = { mainModel: string | null; quickModel: string | null };
export type ModelChoice = { id: string; source: 'env' | 'saved' | 'default' };
export type AiRole = 'main' | 'quick';
export const CHOOSE_AI = 'Choose AI models in setup.';
export function modelChoices(settings: AiSettings, list: ModelList | null, env: NodeJS.ProcessEnv) {
  const choose = (role: AiRole): { choice: ModelChoice | null; missing: boolean } => {
    const override = role === 'main' ? env.MEETING_HEAVY_MODEL : env.MEETING_QUICK_MODEL;
    if (override !== undefined) return { choice: { id: override, source: 'env' }, missing: false };
    const saved = role === 'main' ? settings.mainModel : settings.quickModel;
    if (saved !== null) return { choice: { id: saved, source: 'saved' }, missing: list?.state === 'ok' && !list.models.some(m => m.id === saved) };
    const name = role === 'main' ? 'gpt-6.1-sol' : 'gpt-6-luna';
    const matches = list?.state === 'ok' ? list.models.filter(m => m.model === name) : [];
    const model = matches.find(m => m.provider === 'openai-codex') ?? matches[0];
    return { choice: model ? { id: model.id, source: 'default' } : null, missing: false };
  };
  return { main: choose('main'), quick: choose('quick') };
}
export class AiSetup {
  readonly reader: PiModels;
  web = false;
  private version = 0;
  private webVersion = 0;
  private access: { key: string; state: 'checking' | 'ready' | 'no-access'; detail?: string } | null = null;
  private tasks = new Set<Promise<void>>();
  private saveCheck?: { controller: AbortController; pending: boolean };
  private runnerRefresh?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private closed = false;
  readonly settings: () => AiSettings;
  readonly save: (change: AiSettings) => Promise<void>;
  readonly options: PiModelsOptions & { cloud: boolean; tiny?: (prompt: string, options: PiTaskOptions) => Promise<PiTaskResult>;
    /** Saved API keys still being read from the Keychain: Pi's list waits for them, or it would lack their models. */
    keysReady?: () => Promise<void> };
  constructor(settings: () => AiSettings, save: (change: AiSettings) => Promise<void>, options: AiSetup['options']) {
    this.settings = settings; this.save = save; this.options = options; this.reader = new PiModels(options);
  }
  private get env() { return this.options.env ?? process.env; }
  private choices() { return modelChoices(this.settings(), this.reader.last, this.env); }
  current(role: AiRole): string | null {
    if (!this.options.cloud) return null;
    const selected = this.choices()[role];
    return selected.missing ? null : selected.choice?.id ?? null;
  }
  private unavailable(role?: AiRole): string {
    const state = this.reader.last?.state;
    if (state === 'signed-out') return "Pi isn't signed in. Run pi, then /login.";
    if (state === 'unreadable') return "Couldn't read Pi's models.";
    if (state === 'not-installed') return 'Pi is not installed. Run npm ci.';
    const choices = this.choices();
    const missing = role ? choices[role] : [choices.main, choices.quick].find(choice => choice.missing);
    return missing?.missing ? `${oneLine(missing.choice!.id)} is no longer listed by Pi. ${CHOOSE_AI}` : CHOOSE_AI;
  }
  /** Only the first catalog read may block a runner. Later reads use stale state and one bounded background retry. */
  private async runnerCatalog(): Promise<void> {
    if (!this.reader.last) { await this.models(); return; }
    if (this.reader.staleForRunner() && !this.runnerRefresh) {
      const refresh = this.models(true).then(() => {}).finally(() => { this.runnerRefresh = undefined; });
      this.runnerRefresh = refresh;
      this.background(refresh);
    }
  }
  async require(role: AiRole): Promise<string> {
    if (!this.options.cloud || this.closed) throw new Error(CHOOSE_AI);
    await this.runnerCatalog();
    const model = this.current(role);
    if (!model) throw new Error(this.unavailable(role));
    return model;
  }
  currentCorrection(): string | null {
    return this.options.cloud ? this.env.MEETING_CORRECTION_MODEL ?? this.current('main') : null;
  }
  async correction(): Promise<string> {
    if (!this.options.cloud || this.closed) throw new Error(CHOOSE_AI);
    return this.env.MEETING_CORRECTION_MODEL ?? await this.require('main');
  }
  private key() { return JSON.stringify([this.current('main'), this.current('quick')]); }
  status() {
    const choices = this.choices(), list = this.reader.last;
    const main = choices.main.choice, quick = choices.quick.choice;
    let state: string, detail: string | undefined;
    // Precedence: off > pending Save check > catalog failure/reading > missing saved choice > unset role > access result.
    // Only a newer Save or close can supersede Save's pending auth/tiny obligation, not metadata refresh or recheck.
    // In particular an env id absent from an ok list cannot become ready, even if auth says ready.
    if (!this.options.cloud) state = 'off';
    else if (this.saveCheck?.pending) state = 'checking';
    else if (!list) state = 'reading';
    else if (list.state !== 'ok') {
      state = list.state;
      detail = this.unavailable();
    } else if (choices.main.missing || choices.quick.missing) { state = 'missing'; detail = this.unavailable(); }
    else if (!main || !quick) { state = 'choose'; detail = CHOOSE_AI; }
    else if (!list.models.some(m => m.id === main.id) || !list.models.some(m => m.id === quick.id)) { state = 'no-access'; detail = "Pi doesn't list a chosen model."; }
    else if (!this.access || this.access.key !== this.key()) state = 'checking';
    else { state = this.access.state; detail = this.access.detail; }
    return { id: 'ai', needed: false, state, main, quick, count: list?.count ?? 0, providers: list?.providers ?? [], web: this.web, ...(detail ? { detail } : {}) };
  }
  private background(task: Promise<void>) {
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
  }
  start() { if (this.options.cloud) this.background(this.recheck()); }
  async models(refresh = false) {
    if (!this.options.cloud || this.closed) return { state: 'off', models: [], count: 0, providers: [] };
    await this.options.keysReady?.();
    const save = this.saveCheck, pendingSave = save?.pending;
    const list = await this.reader.read(refresh);
    if (!this.closed && !pendingSave && save === this.saveCheck && this.access?.key !== this.key()) this.background(this.check(false));
    return list;
  }
  async recheck() {
    if (!this.options.cloud || this.closed) return;
    // Invalidate passive auth only. A saved pair's tiny check owns a separate generation.
    const version = ++this.version, webVersion = ++this.webVersion;
    const save = this.saveCheck, pendingSave = save?.pending;
    if (!pendingSave) this.access = null;
    await this.options.keysReady?.();
    const [, web] = await Promise.all([this.reader.read(true), this.reader.web()]);
    if (this.closed) return;
    if (webVersion === this.webVersion) this.web = web;
    // A recheck begun during Save shares its access obligation, even if metadata finishes after the tiny call.
    if (!pendingSave && save === this.saveCheck && version === this.version) await this.check(false);
  }
  private async check(tiny: boolean): Promise<void> {
    if (this.closed || (!tiny && this.saveCheck?.pending)) return;
    // Save checks snapshot the chosen ids, even if a concurrent list refresh temporarily omits one.
    const choices = this.choices();
    const main = tiny ? choices.main.choice?.id : this.current('main');
    const quick = tiny ? choices.quick.choice?.id : this.current('quick');
    const key = JSON.stringify([main ?? null, quick ?? null]), version = ++this.version;
    let save: typeof this.saveCheck;
    if (tiny) {
      this.saveCheck?.controller.abort();
      save = { controller: new AbortController(), pending: true };
      this.saveCheck = save;
    }
    const ownsResult = () => !this.closed && (tiny ? this.saveCheck === save : !this.saveCheck?.pending && version === this.version && key === this.key());
    this.access = { key, state: 'checking' };
    try {
      if (!main || !quick) return;
      const checks = await Promise.all([...new Set([main, quick])].map(id => this.reader.auth(id)));
      const failed = checks.find(check => check.state !== 'ready');
      if (failed) throw new Error(failed.detail ?? "Couldn't check Pi's access.");
      if (!ownsResult()) return;
      if (save) {
        const result = checkCompleted(await (this.options.tiny ?? runPiTask)('Reply with OK.', {
          model: quick, cwd: this.options.cwd, env: this.options.env, tools: null, thinking: 'low', timeoutMs: 60_000, signal: save.controller.signal,
        }), 'The AI check');
        if (result.toolEvents) throw new Error('The AI check tried to use tools.');
      }
      if (ownsResult()) this.access = { key, state: 'ready' };
    } catch (error) {
      if (ownsResult()) this.access = { key, state: 'no-access', detail: oneLine(error instanceof Error ? error.message : String(error)) };
    } finally {
      if (save) save.pending = false;
    }
  }
  async use(value: unknown) {
    const mutation = this.mutations.catch(() => {}).then(async () => {
      if (this.closed) throw new Error('AI setup has stopped.');
      if (!this.options.cloud) throw new Error('AI is off for this start.');
      if (this.env.MEETING_HEAVY_MODEL !== undefined || this.env.MEETING_QUICK_MODEL !== undefined) throw new Error('AI model choices are set by the environment.');
      const { main, quick } = (value && typeof value === 'object' ? value : {}) as { main?: unknown; quick?: unknown };
      const list = await this.reader.read();
      for (const id of [main, quick]) {
        if (typeof id !== 'string' || list.state !== 'ok' || !list.models.some(m => m.id === id)) throw new Error(`Pi doesn't list ${oneLine(String(id))}.`);
      }
      if (this.closed) throw new Error('AI setup has stopped.');
      await this.save({ mainModel: main as string, quickModel: quick as string });
      this.background(this.check(true)); // check sets checking synchronously; the response never waits for auth or inference.
    });
    this.mutations = mutation;
    await mutation;
  }
  /** A removed provider's chosen models go back to the defaults; returns the roles that changed. */
  async resetProvider(provider: string): Promise<AiRole[]> {
    const mutation = this.mutations.catch(() => {}).then(async () => {
      const settings = this.settings(), reset: AiRole[] = [];
      for (const role of ['main', 'quick'] as const) {
        const override = role === 'main' ? this.env.MEETING_HEAVY_MODEL : this.env.MEETING_QUICK_MODEL;
        if (override === undefined && settings[`${role}Model`]?.startsWith(`${provider}/`)) reset.push(role);
      }
      if (reset.length && !this.closed) await this.save({ mainModel: reset.includes('main') ? null : settings.mainModel, quickModel: reset.includes('quick') ? null : settings.quickModel });
      return reset;
    });
    this.mutations = mutation;
    return mutation;
  }
  async close() {
    this.closed = true; ++this.version; this.saveCheck?.controller.abort();
    await this.reader.close(); // Includes foreground models/recheck/validation probes, not just tasks in this set.
    await this.mutations.catch(() => {});
    await Promise.allSettled([...this.tasks]);
  }
}
