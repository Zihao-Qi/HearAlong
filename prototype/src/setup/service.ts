import { execFile } from 'node:child_process';
import { SpeechModels, type ScanOptions, type ScanResult } from './speech-models.ts';
import { checkFfmpeg, type FfmpegResult } from './ffmpeg.ts';
import { ModelDownload, type DownloadOptions } from './model-download.ts';

export type SetupSettings = { speechModelPath: string | null; setupSeen: boolean };
export type SetupOptions = {
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
  readonly download: ModelDownload;
  scan!: ScanResult;
  ffmpeg!: FfmpegResult;
  runningPath: string | null = null;
  private runningStreaming?: boolean;
  private choiceMade: boolean;
  private recheckVersion = 0;
  private readonly userDecoders = { MEETING_FFMPEG: process.env.MEETING_FFMPEG, MEETING_FFPROBE: process.env.MEETING_FFPROBE };
  private initialDecoders?: { ffmpeg: string; ffprobe: string };
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
    this.download = new ModelDownload({ ...options.download, directory, onDone: async (path, use) => {
      if (use || !this.runningPath) await this.save({ speechModelPath: path });
      await this.recheck();
    } });
  }
  async initialize() {
    await Promise.all([this.download.ready, this.recheck()]);
    this.runningPath = this.scan.config.available ? this.scan.config.path : null;
    this.runningStreaming = this.scan.config.streaming;
    this.initialDecoders = this.decoderPaths();
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
  private async recheckPass() {
    const savedPath = this.settings().speechModelPath;
    this.choiceMade ||= savedPath !== null;
    // Ignore app-owned discoveries from earlier checks, but retain startup user overrides.
    const env = { ...process.env, ...this.userDecoders };
    // Drain both checks even on failure, so a queued pass cannot overlap either one.
    const [scanned, checked] = await Promise.allSettled([
      Promise.resolve().then(() => this.scanner.scan({ ...this.options.scan, directory: this.directory, savedPath })),
      Promise.resolve().then(() => this.options.ffmpeg ? this.options.ffmpeg(env) : checkFfmpeg({ env })),
    ]);
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
  }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      try { await this.download.close(); }
      finally {
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
    return (this.scan.config.available ? this.scan.config.path : null) !== this.runningPath
      || Boolean(this.initialDecoders && (decoders.ffmpeg !== this.initialDecoders.ffmpeg || decoders.ffprobe !== this.initialDecoders.ffprobe));
  }
  status() {
    const config = this.scan.config;
    const download = this.download.state;
    const state = this.rechecking ? 'scanning' : download.state !== 'idle' && download.state !== 'done' ? download.state
      : this.scan.missingPath ? 'missing' : config.available ? 'ready' : 'none';
    return { seen: this.settings().setupSeen, restartNeeded: this.restartNeeded, rows: [
      { id: 'speech', needed: true, state, ...(config.name ? { label: config.name } : {}),
        source: config.source, path: config.path, streaming: config.streaming,
        ...(this.scan.missingPath ? { missingPath: this.scan.missingPath } : {}), download },
      { id: 'ffmpeg', needed: true, state: this.ffmpeg.found ? 'found' : 'missing', ...(this.ffmpeg.ffmpeg ? { path: this.ffmpeg.ffmpeg } : {}) },
    ] };
  }
  models() { return { models: this.scan.models.map(model => ({ ...model, inUse: model.files.some(file => file.path === this.runningPath) })), truncated: this.scan.truncated }; }
  private async choose(path: string) {
    // A deliberate choice wins over a download still in flight, which remains resumable.
    if (['downloading', 'checking'].includes(this.download.state.state)) await this.download.pause();
    await this.save({ speechModelPath: path });
    this.choiceMade = true;
    await this.recheck();
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
  async seen() { await this.save({ setupSeen: true }); return this.status(); }
}
