import { checkCompleted, runPiTask, type PiTaskOptions, type PiTaskResult } from '../pi-task.ts';
import { PiModels, oneLine, type ModelList, type PiModelsOptions } from './pi-models.ts';

import { isLocalModel, type AiMode } from '../pi-command.ts';
import { consentCovers, migrateAi, type ModeSettings } from './ai-settings.ts';

export type AiSettings = { mainModel: string | null; quickModel: string | null } & ModeSettings;
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
  readonly localReader: PiModels;
  private initializing?: Promise<void>;
  web = false;
  private version = 0;
  private generation = 0;
  private metadataGuard(mode: AiMode = this.mode(), preview = false) {
    const generation = this.generation;
    return () => !this.closed && this.options.cloud && this.env.MEETING_CLOUD !== '0' && (preview || (this.generation === generation && this.mode() === mode));
  }
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
    this.settings = settings; this.save = save; this.options = options; this.reader = new PiModels({ ...options, mode: 'cloud' }); this.localReader = new PiModels({ ...options, mode: 'local' });
  }
  private get env() { return this.options.env ?? process.env; }
  mode(): AiMode { return !this.options.cloud || this.env.MEETING_CLOUD === '0' ? 'off' : this.settings().aiMode ?? 'cloud'; }
  private get catalog() { return this.mode() === 'local' ? this.localReader : this.reader; }
  private choices() {
    const settings = this.settings(), local = this.mode() === 'local';
    const list = this.catalog.last;
    const filtered = list && { ...list, models: list.models.filter(m => isLocalModel(m.id) === local) };
    const main = local ? settings.localMainModel : settings.cloudMainModel;
    const quick = local ? settings.localQuickModel : settings.cloudQuickModel;
    const chosen = modelChoices({ mainModel: main ?? (local ? filtered?.models[0]?.id ?? null : settings.mainModel), quickModel: quick ?? (local ? filtered?.models[0]?.id ?? null : settings.quickModel) }, filtered, this.env);
    return chosen;
  }
  current(role: AiRole): string | null {
    if (this.mode() === 'off') return null;
    const selected = this.choices()[role];
    return selected.missing ? null : selected.choice?.id ?? null;
  }
  private unavailable(role?: AiRole): string {
    const state = this.catalog.last?.state;
    if (state === 'signed-out') return "Pi isn't signed in. Run pi, then /login.";
    if (state === 'unreadable') return "Couldn't read Pi's models.";
    if (state === 'not-installed') return 'Pi is not installed. Run npm ci.';
    const choices = this.choices();
    const missing = role ? choices[role] : [choices.main, choices.quick].find(choice => choice.missing);
    return missing?.missing ? `${oneLine(missing.choice!.id)} is no longer listed by Pi. ${CHOOSE_AI}` : CHOOSE_AI;
  }
  /** Only the first catalog read may block a runner. Later reads use stale state and one bounded background retry. */
  private async runnerCatalog(): Promise<void> {
    if (!this.catalog.last) { await this.models(); return; }
    if (this.catalog.staleForRunner() && !this.runnerRefresh) {
      const refresh = this.models(true).then(() => {}).finally(() => { this.runnerRefresh = undefined; });
      this.runnerRefresh = refresh;
      this.background(refresh);
    }
  }
  async require(role: AiRole): Promise<string> {
    await this.initializing;
    if (this.mode() === 'off' || this.closed) throw new Error(CHOOSE_AI);
    await this.runnerCatalog();
    const model = this.current(role);
    if (!model) throw new Error(this.unavailable(role));
    return this.allow(model);
  }
  allow(model: string): string {
    if (!this.settings().aiMode && this.settings().setupSeen !== undefined) throw new Error('AI setup is waiting for model discovery. Check again in AI settings.');
    if (this.mode() === 'off') throw new Error('AI is off. Change it in AI settings.');
    if (this.mode() === 'local' && !isLocalModel(model)) throw new Error(`Only local models may run on this Mac: ${oneLine(model)}.`);
    if (this.settings().aiMode === 'cloud') {
      const ids = [this.current('main'), this.current('quick'), model].filter((id): id is string => !!id);
      const consent = this.settings().cloudConsent;
      if (!consentCovers(consent, ids) && !(consent?.legacy && ids.every(id => consent.providers.includes(id.split('/')[0])))) throw new Error('Cloud AI needs consent in AI settings before transcript text can be sent.');
    }
    return model;
  }
  currentCorrection(): string | null {
    return this.mode() !== 'off' ? this.env.MEETING_CORRECTION_MODEL ?? this.current('main') : null;
  }
  async correction(): Promise<string> {
    await this.initializing;
    if (this.mode() === 'off' || this.closed) throw new Error(CHOOSE_AI);
    const override = this.env.MEETING_CORRECTION_MODEL;
    if (!override) return this.require('main');
    if (this.mode() === 'local' && !isLocalModel(override)) throw new Error(`Only local models may run on this Mac: ${oneLine(override)}.`);
    if (this.settings().aiMode === 'cloud' && !this.settings().cloudConsent?.providers.includes(override.split('/')[0])) throw new Error('Cloud correction needs consent for its provider in AI settings.');
    return this.allow(override);
  }
  private key() { return JSON.stringify([this.current('main'), this.current('quick')]); }
  status() {
    const choices = this.choices(), list = this.catalog.last;
    const main = choices.main.choice, quick = choices.quick.choice;
    let state: string, detail: string | undefined;
    // Precedence: off > pending Save check > catalog failure/reading > missing saved choice > unset role > access result.
    // Only a newer Save or close can supersede Save's pending auth/tiny obligation, not metadata refresh or recheck.
    // In particular an env id absent from an ok list cannot become ready, even if auth says ready.
    if (this.mode() === 'off') state = 'off';
    else if (this.saveCheck?.pending) state = 'checking';
    else if (!list) state = 'reading';
    else if (list.state !== 'ok') {
      state = list.state;
      detail = this.unavailable();
    } else if (choices.main.missing || choices.quick.missing) { state = 'missing'; detail = this.unavailable(); }
    else if (!main || !quick) { state = 'choose'; detail = CHOOSE_AI; }
    else if (!list.models.some(m => m.id === main.id) || !list.models.some(m => m.id === quick.id)) { state = 'no-access'; detail = "Pi doesn't list a chosen model."; }
    else if (this.settings().aiMode === 'cloud' && !this.settings().cloudConsent) { state = 'no-access'; detail = 'Cloud AI needs consent in AI settings.'; }
    else if (!this.access || this.access.key !== this.key()) state = 'checking';
    else { state = this.access.state; detail = this.access.detail; }
    return { id: 'ai', needed: false, state, mode: this.mode(), forcedOff: !this.options.cloud || this.env.MEETING_CLOUD === '0', cloudConsent: this.settings().cloudConsent, cloudNotice: !!this.settings().cloudNotice, main, quick, count: list?.count ?? 0, providers: list?.providers ?? [], web: this.web, ...(detail ? { detail } : {}) };
  }
  private background(task: Promise<void>) {
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
  }
  start() {
    this.initializing = this.initialize();
    this.background(this.initializing);
  }
  private async initialize() {
    if (!this.options.cloud) {
      if (!this.settings().aiMode && this.settings().setupSeen === false) await this.save({ ...this.settings(), aiMode: 'off', cloudNotice: false });
      return;
    }
    if (!this.settings().aiMode && this.settings().setupSeen !== undefined) {
      const allowed = this.metadataGuard();
      let ids: string[] = [];
      if (this.options.cloud) {
        if (this.settings().setupSeen) await this.options.keysReady?.();
        if (!allowed()) return;
        const list = await (this.settings().setupSeen ? this.reader : this.localReader).read(false, allowed);
        if (!allowed()) return;
        if (this.settings().setupSeen && (list.state === 'unreadable' || list.state === 'not-installed')) return; // Do not turn a working legacy cloud install off because discovery failed.
        ids = list.models.map(m => m.id);
      }
      if (!this.closed) await this.save({ ...this.settings(), ...migrateAi(this.settings(), ids, !this.options.cloud) });
    }
    await this.recheck(false);
  }
  async models(refresh = false, mode?: AiMode) {
    await this.initializing;
    const preview = mode !== undefined;
    mode ??= this.mode();
    const off = () => ({ state: 'off', models: [], count: 0, providers: [] });
    const allowed = this.metadataGuard(mode, preview);
    if (!allowed() || mode === 'off') return off();
    await this.options.keysReady?.();
    if (!allowed()) return off();
    const save = this.saveCheck, pendingSave = save?.pending;
    const reader = mode === 'local' ? this.localReader : this.reader;
    const raw = await reader.read(refresh, allowed);
    if (!allowed()) return off();
    const models = raw.models.filter(m => isLocalModel(m.id) === (mode === 'local'));
    const list = { ...raw, models, count: models.length, providers: [...new Set(models.map(m => m.provider))] };
    if (mode === this.mode() && !this.closed && !pendingSave && save === this.saveCheck && this.access?.key !== this.key()) this.background(this.check(false));
    const defaults = modelChoices({ mainModel: null, quickModel: null }, list, this.env);
    return { ...list, defaults: { main: defaults.main.choice?.id ?? null, quick: defaults.quick.choice?.id ?? null } };
  }
  async recheck(migrate = true) {
    if (migrate && !this.settings().aiMode && this.settings().setupSeen !== undefined && this.options.cloud) { await this.initialize(); return; }
    if (this.mode() === 'off' || this.closed) return;
    // Invalidate passive auth only. A saved pair's tiny check owns a separate generation.
    const mode = this.mode(), allowed = this.metadataGuard(mode);
    const reader = mode === 'local' ? this.localReader : this.reader;
    const version = ++this.version, webVersion = ++this.webVersion;
    const save = this.saveCheck, pendingSave = save?.pending;
    if (!pendingSave) this.access = null;
    await this.options.keysReady?.();
    if (!allowed()) return;
    const [, web] = await Promise.all([reader.read(true, allowed), mode === 'cloud' ? this.reader.web(allowed) : false]);
    if (!allowed()) return;
    if (webVersion === this.webVersion) this.web = web;
    // A recheck begun during Save shares its access obligation, even if metadata finishes after the tiny call.
    if (!pendingSave && save === this.saveCheck && version === this.version) await this.check(false);
  }
  private async check(tiny: boolean): Promise<void> {
    const allowed = this.metadataGuard();
    if (!allowed() || (!tiny && this.saveCheck?.pending)) return;
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
    const ownsResult = () => allowed() && (tiny ? this.saveCheck === save : !this.saveCheck?.pending && version === this.version && key === this.key());
    this.access = { key, state: 'checking' };
    try {
      if (!main || !quick) return;
      if (this.mode() === 'local') { if (ownsResult()) this.access = { key, state: 'ready' }; return; }
      const checks = await Promise.all([...new Set([main, quick])].map(id => this.reader.auth(id, allowed)));
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
      await this.initializing;
      const { main, quick, mode = this.mode() === 'off' ? 'cloud' : this.mode(), consent } = (value && typeof value === 'object' ? value : {}) as { main?: unknown; quick?: unknown; mode?: unknown; consent?: unknown };
      if (!['local', 'cloud', 'off'].includes(String(mode))) throw new Error('Choose On this Mac, Cloud or Off.');
      if (mode === 'off') { await this.save({ ...this.settings(), aiMode: 'off' }); ++this.generation; this.saveCheck?.controller.abort(); this.web = false; return; }
      if (this.env.MEETING_HEAVY_MODEL !== undefined || this.env.MEETING_QUICK_MODEL !== undefined) throw new Error('AI model choices are set by the environment.');
      const list = await (mode === 'local' ? this.localReader : this.reader).read(false, this.metadataGuard(mode as AiMode, true));
      for (const id of [main, quick]) {
        if (typeof id !== 'string' || list.state !== 'ok' || !list.models.some(m => m.id === id && isLocalModel(m.id) === (mode === 'local'))) throw new Error(`Pi doesn't list ${oneLine(String(id))}.`);
      }
      if (this.closed) throw new Error('AI setup has stopped.');
      const managed = this.settings().setupSeen !== undefined || this.settings().aiMode !== undefined || (value && typeof value === 'object' && 'mode' in value);
      if (managed && mode === 'cloud' && consent !== true && !consentCovers(this.settings().cloudConsent, [main as string, quick as string])) throw new Error('Tick Send this to the chosen providers before saving cloud AI.');
      const next: AiSettings = { ...this.settings(), ...(mode === 'cloud' ? { mainModel: main as string, quickModel: quick as string } : {}) };
      if (managed) {
        next.aiMode = mode as AiMode;
        if (mode === 'local') { next.localMainModel = main as string; next.localQuickModel = quick as string; }
        else {
          next.cloudMainModel = main as string; next.cloudQuickModel = quick as string;
          if (consent === true) next.cloudConsent = { providers: [...new Set([main, quick].map(id => (id as string).split('/')[0]))].sort(), time: Date.now() };
        }
      }
      await this.save(next);
      ++this.generation;
      if (mode !== 'cloud') this.web = false;
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
      if (reset.length && !this.closed) await this.save({ ...settings, mainModel: reset.includes('main') ? null : settings.mainModel, quickModel: reset.includes('quick') ? null : settings.quickModel, ...(settings.aiMode !== undefined ? { cloudMainModel: reset.includes('main') ? null : settings.cloudMainModel, cloudQuickModel: reset.includes('quick') ? null : settings.cloudQuickModel } : {}) });
      return reset;
    });
    this.mutations = mutation;
    return mutation;
  }
  async close() {
    this.closed = true; ++this.version; this.saveCheck?.controller.abort();
    await this.localReader.close();
    await this.reader.close(); // Includes foreground models/recheck/validation probes, not just tasks in this set.
    await this.mutations.catch(() => {});
    await Promise.allSettled([...this.tasks]);
  }
}
