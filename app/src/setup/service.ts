import { execFile } from 'node:child_process';
import { SpeechModels, type ScanOptions, type ScanResult } from './speech-models.ts';
import { checkFfmpeg, type FfmpegResult } from './ffmpeg.ts';
import { ModelDownload, type DownloadOptions } from './model-download.ts';
import type { ModelConfig } from './speech-models.ts';
import type { SwitchOptions } from './switchable-recognizer.ts';

export type SpeechRuntime = {
  recording(): boolean;
  cancelSwitch(): void;
  switchTo(path: string, applied: () => void, canApply: () => boolean): Promise<boolean>;
  applied(config: ModelConfig): void;
  kick(): void;
};

export type SetupSettings = { speechModelPath: string | null; setupSeen: boolean };
export type SpeechIntent = { seq: number; kind: 'path'; path: string } | { seq: number; kind: 'download' } | null;
export type SetupDownload = Pick<ModelDownload, keyof ModelDownload>;
export type SetupOptions = {
  /** Injectable transfer boundary for deterministic scheduling tests. */
  createDownload?: (options: DownloadOptions) => SetupDownload;
  worker?: SwitchOptions;
  scan?: Omit<ScanOptions, 'directory' | 'savedPath'>;
  picker?: () => Promise<string | null>;
  ffmpeg?: (env: NodeJS.ProcessEnv) => Promise<FfmpegResult>;
  download?: Omit<DownloadOptions, 'directory' | 'onDone'>;
};
export function macModelPicker(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', 'POSIX path of (choose file with prompt "Choose a speech model (GGUF)")'], { timeout: 10 * 60_000, maxBuffer: 16_384 }, (error, stdout, stderr) => {
      if (error && /(?:\(-128\)|\b-128\b)/.test(stderr)) resolve(null);
      else if (error) reject(new Error('Could not open the speech model file picker.'));
      else resolve(stdout.trim());
    });
  });
}

export class SpeechSetup {
  readonly scanner = new SpeechModels();
  readonly download: SetupDownload;
  scan!: ScanResult;
  ffmpeg!: FfmpegResult;
  runningPath: string | null = null;
  private runningStreaming?: boolean;
  private choiceMade: boolean;
  private recheckVersion = 0;
  private readonly userDecoders = { MEETING_FFMPEG: process.env.MEETING_FFMPEG, MEETING_FFPROBE: process.env.MEETING_FFPROBE };
  private workerDecoders?: { ffmpeg: string; ffprobe: string };
  runningConfig!: ModelConfig;
  private runningChoice: string | null = null;
  private choiceQueue: Promise<void> = Promise.resolve();
  private intent: SpeechIntent = null;
  private intentSeq = 0;
  private runtime?: SpeechRuntime;
  private switchVersion = 0;
  private switchTask?: Promise<void>;
  private switchTimer?: NodeJS.Timeout;
  private targetKey?: string;
  pending?: { path: string; applies: 'after recording' | 'loading' };
  switchError?: string;
  private rechecking?: Promise<void>;
  private recheckWaiters: { version: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private picking = false;
  readonly directory: string;
  readonly settings: () => SetupSettings;
  readonly save: (change: Partial<SetupSettings>) => Promise<void>;
  readonly options: SetupOptions;
  constructor(directory: string, settings: () => SetupSettings,
    save: (change: Partial<SetupSettings>) => Promise<void>, options: SetupOptions = {}) {
    this.directory = directory; this.settings = settings; this.save = save; this.options = options;
    this.choiceMade = settings().speechModelPath !== null;
    this.download = (options.createDownload ?? (download => new ModelDownload(download)))({ ...options.download, directory,
      onDone: () => this.applyIntent(),
    });
  }
  async initialize() {
    await Promise.all([this.download.ready, this.recheck()]);
    this.runningPath = this.scan.config.available ? this.scan.config.path : null;
    this.runningStreaming = this.scan.config.streaming;
    this.runningConfig = { ...this.scan.config };
    this.runningChoice = this.settings().speechModelPath === null ? null : this.runningPath;
    this.workerDecoders = this.decoderPaths();
  }
  /** Serialize saves and their rechecks; decide what to save only when the step starts. */
  private mutateChoice(mutation: () => Promise<void>): Promise<void> {
    const work = this.choiceQueue.then(async () => {
      if (this.closed) return;
      await mutation();
    });
    this.choiceQueue = work.catch(() => {}); // A failed save must not poison later choices.
    return work;
  }
  private applyIntent(force = false): Promise<void> {
    return this.mutateChoice(async () => {
      const intent = this.intent;
      const path = intent?.kind === 'path' ? intent.path
        : this.download.completed && (intent?.kind === 'download' || (!intent && !this.runningPath)) ? this.download.path : null;
      if (path && (force || path !== this.settings().speechModelPath)) {
        this.invalidateSwitch();
        try { await this.save({ speechModelPath: path }); }
        catch (error) {
          this.switchError = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
          throw error;
        }
        // A concurrent recheck may have started a load from the old saved path while this save awaited disk.
        this.invalidateSwitch();
        this.choiceMade ||= intent !== null;
      }
      await this.recheck();
      if (path && intent === this.intent && force && this.settings().speechModelPath === path && this.targetKey === undefined) this.requestSwitch(true);
    });
  }
  /** Attach only after startup, so the initial model is never preflighted. */
  attachRuntime(runtime: SpeechRuntime) { this.runtime = runtime; }
  private invalidateSwitch() {
    ++this.switchVersion;
    clearTimeout(this.switchTimer);
    this.runtime?.cancelSwitch();
    this.pending = undefined;
    this.switchError = undefined;
    this.targetKey = undefined;
  }
  private requestSwitch(force = false) {
    if (!this.runtime || this.closed) return;
    const config = { ...this.scan.config }, decoders = this.decoderPaths();
    const key = JSON.stringify([config.path, decoders]);
    if (!force && (key === this.targetKey || (config.path === this.runningPath
      && JSON.stringify(decoders) === JSON.stringify(this.workerDecoders)))) return;
    if (!config.available || !config.path) return;
    this.targetKey = key;
    const version = ++this.switchVersion;
    this.runtime.cancelSwitch();
    clearTimeout(this.switchTimer);
    this.switchError = undefined;
    this.pending = { path: config.path, applies: 'after recording' };
    const choice = this.settings().speechModelPath;
    const intentSeq = this.intentSeq;
    const start = () => {
      if (this.closed || version !== this.switchVersion) return;
      if (this.runtime!.recording()) {
        this.switchTimer = setTimeout(start, 1000); this.switchTimer.unref(); return;
      }
      this.pending = { path: config.path!, applies: 'loading' };
      this.switchTask = this.runtime!.switchTo(config.path!, () => {
        if (this.closed || version !== this.switchVersion) return;
        this.runningPath = config.path;
        this.runningStreaming = config.streaming;
        this.runningConfig = config;
        this.runningChoice = choice;
        this.workerDecoders = decoders;
        this.runtime!.applied(config);
      }, () => {
        const recording = this.runtime!.recording();
        this.pending = { path: config.path!, applies: recording ? 'after recording' : 'loading' };
        return !recording;
      }).then(() => {
        if (!this.closed && version === this.switchVersion) { this.pending = undefined; this.runtime!.kick(); }
      }).catch(async error => {
        this.switchError = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
        if (this.closed || version !== this.switchVersion) return;
        this.pending = undefined;
        await this.mutateChoice(async () => {
          if (version !== this.switchVersion || intentSeq !== this.intentSeq) return;
          const rollbackVersion = ++this.switchVersion;
          try { await this.save({ speechModelPath: this.runningChoice }); }
          catch (saveError) {
            this.switchError = `${this.switchError ?? ''} Could not restore saved choice: ${String(saveError).replace(/[\r\n]+/g, ' ')}`.trim();
          }
          if (rollbackVersion === this.switchVersion) this.scan.config = { ...this.runningConfig };
        });
      }).finally(() => { if (version === this.switchVersion) this.pending = undefined; });
    };
    start();
  }
  private decoderPaths() {
    return { ffmpeg: process.env.MEETING_FFMPEG ?? 'ffmpeg', ffprobe: process.env.MEETING_FFPROBE ?? 'ffprobe' };
  }
  recheck(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const version = ++this.recheckVersion;
    const result = new Promise<void>((resolve, reject) => { this.recheckWaiters.push({ version, resolve, reject }); });
    this.startRecheck();
    return result;
  }
  private startRecheck() {
    if (this.rechecking || !this.recheckWaiters.length) return;
    this.rechecking = Promise.resolve().then(async () => {
      // Requests queued before this pass starts share it; later requests share the next pass.
      const version = this.recheckVersion;
      let failed = false, failure: unknown;
      try { await this.recheckPass(); } catch (error) { failed = true; failure = error; }
      const finished = this.recheckWaiters.filter(w => w.version <= version);
      this.recheckWaiters = this.recheckWaiters.filter(w => w.version > version);
      this.rechecking = undefined;
      this.startRecheck();
      for (const waiter of finished) { if (failed) waiter.reject(failure); else waiter.resolve(); }
    });
  }
  private async recheckPass(): Promise<void> {
    const switchVersion = this.switchVersion;
    const savedPath = this.settings().speechModelPath;
    this.choiceMade ||= savedPath !== null;
    // Ignore app-owned discoveries from earlier checks, but retain startup user overrides.
    const env = { ...process.env, ...this.userDecoders };
    // Drain both checks even on failure, so a queued pass cannot overlap either one.
    const [scanned, checked] = await Promise.allSettled([
      Promise.resolve().then(() => this.scanner.scan({ ...this.options.scan, directory: this.directory, savedPath })),
      Promise.resolve().then(() => this.options.ffmpeg ? this.options.ffmpeg(env) : checkFfmpeg({ env })),
    ]);
    // A choice or rollback may have completed while either check was in flight.
    // Discard both snapshots and re-run before publishing any model or decoder state.
    if (savedPath !== this.settings().speechModelPath || switchVersion !== this.switchVersion) return this.recheckPass();
    if (scanned.status === 'rejected') throw scanned.reason;
    if (checked.status === 'rejected') throw checked.reason;
    const scan = scanned.value, ffmpeg = checked.value;
    // Publish every completed pass, without making its callers wait for later requests.
    if (!this.choiceMade && scan.config.source !== 'MEETING_MODEL_PATH' && this.runningPath) {
      const model = scan.models.find(m => m.files.some(f => f.path === this.runningPath));
      const file = model?.files.find(f => f.path === this.runningPath);
      if (model && file) scan.config = { available: true, path: file.path, source: file.source, bytes: file.bytes,
        error: null, name: model.name, streaming: this.runningStreaming };
    }
    this.scan = scan; this.ffmpeg = ffmpeg;
    // Workers inherit these paths. Commands already found on PATH are deliberately left unchanged.
    for (const [key, path] of [['MEETING_FFMPEG', ffmpeg.ffmpeg], ['MEETING_FFPROBE', ffmpeg.ffprobe]] as const) {
      if (this.userDecoders[key] !== undefined) continue;
      if (path?.startsWith('/')) process.env[key] = path;
      else delete process.env[key];
    }
    if (savedPath === this.settings().speechModelPath) this.requestSwitch();
  }
  /** Stop pending switches before shutting down recording and queue owners. */
  stopSwitches() {
    this.closed = true;
    ++this.switchVersion;
    clearTimeout(this.switchTimer);
    this.pending = undefined;
    this.runtime?.cancelSwitch();
  }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      try { this.stopSwitches(); await this.switchTask; await this.download.close(); }
      finally {
        await this.choiceQueue;
        while (this.rechecking) await this.rechecking;
        for (const [key, value] of Object.entries(this.userDecoders)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    })();
    return this.closing;
  }
  get restartNeeded() {
    const decoders = this.decoderPaths();
    if (this.runtime) return false; // Model and decoder changes are handled live (including pending/failed attempts).
    return (this.scan.config.available ? this.scan.config.path : null) !== this.runningPath
      || Boolean(this.workerDecoders && (decoders.ffmpeg !== this.workerDecoders.ffmpeg || decoders.ffprobe !== this.workerDecoders.ffprobe));
  }
  status() {
    const config = this.scan.config;
    const download = this.download.state;
    const state = this.rechecking ? 'scanning' : download.state !== 'idle' && download.state !== 'done' ? download.state
      : this.scan.missingPath ? 'missing' : config.available ? 'ready' : 'none';
    return { seen: this.settings().setupSeen, restartNeeded: this.restartNeeded, rows: [
      { id: 'speech', needed: true, state, ...(config.name ? { label: config.name } : {}),
        source: config.source, path: config.path, streaming: config.streaming, downloadTargetPath: this.download.path,
        ...(this.pending ? { pending: { ...this.pending } } : {}), ...(this.switchError ? { switchError: this.switchError } : {}),
        ...(this.scan.missingPath ? { missingPath: this.scan.missingPath } : {}), download },
      { id: 'ffmpeg', needed: false, state: this.ffmpeg.found ? 'found' : 'missing', ...(this.ffmpeg.ffmpeg ? { path: this.ffmpeg.ffmpeg } : {}) },
    ] };
  }
  models() { return { models: this.scan.models.map(model => ({ ...model, inUse: model.files.some(file => file.path === this.runningPath) })), truncated: this.scan.truncated }; }
  private async choose(path: string) {
    this.intent = { seq: ++this.intentSeq, kind: 'path', path };
    // Pause outside the mutation queue: the job may itself be waiting for its queued onDone step.
    if (['downloading', 'checking'].includes(this.download.state.state)) await this.download.pause();
    await this.applyIntent(true);
    return this.status();
  }
  async use(id: unknown) {
    if (typeof id !== 'string') throw new Error('Give the id of a speech model.');
    const model = this.scan.models.find(m => m.id === id);
    if (!model) throw new Error('That speech model is no longer in the list. Check again.');
    await this.scanner.inspect(model.chosenFile.path);
    return this.choose(model.chosenFile.path);
  }
  async chooseFile() {
    if (this.picking) throw new Error('The speech model file picker is already open.');
    this.picking = true;
    try {
      const path = await (this.options.picker ?? macModelPicker)();
      if (path === null) return { cancelled: true };
      try { await this.scanner.inspect(path); }
      catch (error) { throw new Error(`Not a speech model HearAlong can run: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}`); }
      return await this.choose(path);
    } finally { this.picking = false; }
  }
  async startDownload(use = false) {
    if (this.closed) return this.status();
    if (use) this.intent = { seq: ++this.intentSeq, kind: 'download' };
    if (this.download.state.state === 'done' && use) {
      try { await this.applyIntent(true); }
      catch (error) { console.warn(`The speech model was downloaded, but setup could not be updated: ${(error as Error).message}`); }
    } else void this.download.start();
    return this.status();
  }
  async cancelDownload() {
    if (this.intent?.kind === 'download') { this.intent = null; ++this.intentSeq; }
    await this.download.cancel();
    return this.status();
  }
  async seen() { await this.save({ setupSeen: true }); return this.status(); }
}
