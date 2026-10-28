import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSetup, type SetupDownload, type SpeechIntent } from '../src/setup/service.ts';
import type { DownloadOptions, DownloadState } from '../src/setup/model-download.ts';
import type { ScanResult, SpeechModel } from '../src/setup/speech-models.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function random(seed: number) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 0x100000000; };
}
const microtasks = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const paths = ['A', 'B', 'C', 'D'].map(name => `/fictional/${name}.gguf`);
const downloaded = '/fictional/models/download.gguf';
const names = ['useA', 'useB', 'useC', 'chooseD', 'downloadTrue', 'downloadFalse', 'pause', 'resume', 'cancel', 'complete', 'saveFail', 'loadFail', 'loadSuccess', 'recheck'] as const;
type Step = typeof names[number];

/** Transfer outcomes are controlled by complete/pause/cancel, with the same completion replay contract as ModelDownload. */
class FakeDownload implements SetupDownload {
  state: DownloadState = { state: 'idle' };
  readonly path = downloaded;
  readonly part = `${downloaded}.part`;
  readonly ready = Promise.resolve();
  private options: DownloadOptions;
  private finalizing = false;
  private revision = 0;
  private job?: Promise<void>;
  private closed = false;
  constructor(options: DownloadOptions) { this.options = options; }
  get completed() { return this.finalizing || this.state.state === 'done'; }
  start() {
    if (this.closed) return Promise.resolve();
    ++this.revision;
    if (this.job) return this.job;
    if (this.state.state !== 'done') this.state = { state: 'downloading', bytes: 0, total: 1, etaSeconds: null };
    return Promise.resolve();
  }
  complete() {
    if (this.closed || this.job || this.state.state !== 'downloading') return;
    this.state = { state: 'checking' }; this.finalizing = true;
    this.job = (async () => {
      let revision: number;
      do {
        revision = this.revision;
        try { await this.options.onDone?.(this.path); } catch { /* Service must report save errors, even for background completion. */ }
      } while (revision !== this.revision);
      this.state = { state: 'done', path: this.path }; this.finalizing = false; this.job = undefined;
    })();
  }
  pause() {
    if (this.job) return this.job;
    if (this.state.state === 'downloading') this.state = { state: 'paused', bytes: 0 };
    return Promise.resolve();
  }
  cancel() {
    if (this.job) return this.job;
    if (this.state.state !== 'done') this.state = { state: 'idle' };
    return Promise.resolve();
  }
  async close() { this.closed = true; await this.pause(); }
  get busy() { return Boolean(this.job); }
}

test('seeded latest-intent interleavings: 2000 sequences of 3–12 steps', { timeout: 20_000 }, async t => {
  t.mock.method(console, 'warn', () => {}); // Background saves are asserted through switchError, not console output.
  const seed = Number(process.env.SETUP_INTENT_SEED ?? 0x51eed123) >>> 0, rng = random(seed), started = performance.now();
  const coverage = Object.fromEntries(names.map(name => [name, 0]));
  let failedSaves = 0, failedLoads = 0, successfulLoads = 0;
  for (let sequence = 0; sequence < 2000; sequence++) {
    const steps: string[] = [], trace: string[] = [], callers: { settled: boolean }[] = [], errors = new Set<string>(), reported = new Set<string>();
    let saved: string | null = paths[0], oracleFailure: Error | undefined;
    const history: { path: string | null; intent: SpeechIntent; restore: boolean }[] = [];
    let failSave = false, loadOutcome: boolean | undefined, lastSwitchSucceeded = false, errorId = 0, picking = false;
    let expectedIntent: { kind: 'path'; path: string } | { kind: 'download' } | null = null;
    let fake!: FakeDownload;
    const saves: { path: string | null; task: ReturnType<typeof deferred<void>>; fail: boolean }[] = [];
    const loads: { path: string; seq: number; apply: () => void; task: ReturnType<typeof deferred<boolean>> }[] = [];
    const rollback = new Map<number, string | null>();
    const models: SpeechModel[] = [...paths, downloaded].map(path => ({ id: path, name: path, family: 'parakeet', streaming: true,
      sources: ['fixture'], files: [{ path, bytes: 1, fileType: 'Q8_0', source: 'fixture' }], chosenFile: { path, bytes: 1, fileType: 'Q8_0', source: 'fixture' } }));
    const setup = new SpeechSetup('/fictional', () => ({ speechModelPath: saved, setupSeen: false }), async change => {
      if (!('speechModelPath' in change)) return;
      const path = change.speechModelPath!;
      const current = (setup as unknown as { intent: SpeechIntent }).intent;
      const seq = current?.seq ?? 0;
      const desired = current?.kind === 'path' ? current.path
        : fake.completed && (current?.kind === 'download' || (!current && !setup.runningPath)) ? downloaded : undefined;
      // A load failure may restore the previously running choice, but only for the same intent.
      const restore = rollback.has(seq) && path === rollback.get(seq);
      try { assert.ok(path === desired || restore, `save of ${path} is neither current intent ${desired} nor an authorized rollback`); }
      catch (error) { oracleFailure = error as Error; throw error; }
      trace.push(`save starts ${path} intent=${seq} restore=${restore}`);
      const task = deferred<void>(), entry = { path, task, fail: failSave }; failSave = false; saves.push(entry);
      await task.promise;
      saved = path; history.push({ path, intent: current, restore }); trace.push(`saved ${path} running=${setup.runningPath}`);
      if (path !== setup.runningPath) lastSwitchSucceeded = false; // This saved choice still needs its own load.
    }, {
      createDownload: options => (fake = new FakeDownload(options)),
      picker: async () => paths[3], ffmpeg: async () => ({ found: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
    });
    setup.scanner.scan = async (): Promise<ScanResult> => ({ models, truncated: false,
      config: { available: saved !== null, path: saved, source: 'fixture', error: null, streaming: true } });
    setup.scanner.inspect = async path => ({ canonical: path, bytes: 1, family: 'parakeet' as const,
      header: { architecture: 'parakeet', name: path, fileType: 'Q8_0', streaming: true } });
    let switchError: string | undefined;
    Object.defineProperty(setup, 'switchError', { configurable: true, get: () => switchError, set: (value: string | undefined) => {
      switchError = value;
      if (value) for (const id of errors) if (value.includes(id)) reported.add(id);
    } });
    const launch = (promise: Promise<unknown>) => {
      const caller = { settled: false }; callers.push(caller);
      void promise.then(() => { caller.settled = true; }, error => {
        caller.settled = true;
        for (const id of errors) if (String(error).includes(id)) reported.add(id);
        // Assertion failures from the reference oracle must not masquerade as expected save errors.
        if (error instanceof assert.AssertionError) oracleFailure = error;
      });
    };
    await setup.initialize();
    setup.attachRuntime({ recording: () => false, applied() {}, kick() {}, cancelSwitch() {
      trace.push(`cancel loads=${loads.length}`);
      if (loads.length) lastSwitchSucceeded = false;
      for (const load of loads.splice(0)) load.task.resolve(false);
    }, switchTo: (path, apply) => {
      const current = (setup as unknown as { intent: SpeechIntent }).intent;
      trace.push(`load starts ${path} intent=${current?.seq ?? 0}`);
      const task = deferred<boolean>(); loads.push({ path, apply, task, seq: current?.seq ?? 0 }); return task.promise;
    } });
    const resolveOne = () => {
      if (saves.length && (rng() < .6 || !loads.length)) {
        const save = saves.shift()!;
        if (save.fail) {
          const id = `save-error-${++errorId}`; errors.add(id); ++failedSaves; trace.push(id); save.task.reject(new Error(id));
        } else save.task.resolve();
      } else if (loads.length) {
        const load = loads.shift()!, success = loadOutcome ?? rng() >= .25; loadOutcome = undefined;
        lastSwitchSucceeded = success;
        if (success) { ++successfulLoads; load.apply(); trace.push(`load success ${load.path} running=${setup.runningPath}`); load.task.resolve(true); }
        else {
          const id = `load-error-${++errorId}`; errors.add(id); ++failedLoads;
          trace.push(`${id} ${load.path}`); rollback.set(load.seq, setup.runningPath); load.task.reject(new Error(id));
        }
      }
    };
    const drain = async () => {
      for (let i = 0; i < 300; i++) {
        await microtasks(); resolveOne(); await microtasks();
        if (oracleFailure) throw oracleFailure;
        if (!saves.length && !loads.length && !fake.busy && callers.every(c => c.settled)) {
          // Also flush service continuations that have not reached a fake boundary yet.
          await microtasks(24);
          if (!saves.length && !loads.length && !fake.busy && callers.every(c => c.settled)) return;
        }
      }
      throw new Error('Unsettled caller/operation after bounded drain');
    };
    const check = () => {
      const last = history.at(-1), current = (setup as unknown as { intent: SpeechIntent }).intent;
      if (last && last.intent === current && !last.restore) {
        const desired = current?.kind === 'path' ? current.path : current?.kind === 'download' && fake.completed ? downloaded : paths[0];
        assert.equal(saved, desired, 'a successful latest-intent save persists that intent');
      } else {
        // No successful save of the latest intent (or an authorized failed-load rollback): retain the preceding choice.
        assert.equal(saved, last?.path ?? paths[0], 'otherwise the preceding validated choice remains');
      }
      assert.equal(setup.pending, undefined, 'no settled sequence may retain pending');
      assert.ok(callers.every(c => c.settled), 'every caller settled');
      if (lastSwitchSucceeded) assert.equal(setup.runningPath, saved, 'last successful switch uses saved choice');
      for (const id of errors) assert.ok(reported.has(id), `swallowed error ${id}`);
    };
    try {
      const length = 3 + Math.floor(rng() * 10);
      for (let i = 0; i < length - 1; i++) {
        const step: Step = names[Math.floor(rng() * names.length)]; steps.push(step); ++coverage[step];
        switch (step) {
          case 'useA': case 'useB': case 'useC': {
            const path = paths[step.charCodeAt(3) - 65]; expectedIntent = { kind: 'path', path }; launch(setup.use(path)); break;
          }
          case 'chooseD': {
            const alreadyPicking = picking;
            if (!alreadyPicking) { expectedIntent = { kind: 'path', path: paths[3] }; picking = true; }
            const choosing = setup.chooseFile();
            if (!alreadyPicking) void choosing.finally(() => { picking = false; }).catch(() => {});
            launch(choosing); break;
          }
          case 'downloadTrue': expectedIntent = { kind: 'download' }; launch(setup.startDownload(true)); break;
          case 'downloadFalse': case 'resume': launch(setup.startDownload(false)); break;
          case 'pause': launch(setup.download.pause()); break;
          case 'cancel': if (expectedIntent?.kind === 'download') expectedIntent = null; launch(setup.cancelDownload()); break;
          case 'complete': fake.complete(); break;
          case 'saveFail': if (saves.length) saves[0].fail = true; else failSave = true; break;
          case 'loadFail': loadOutcome = false; break;
          case 'loadSuccess': loadOutcome = true; break;
          case 'recheck': launch(setup.recheck()); break;
        }
        // Validation is immediate and fake; allow it to publish the explicit intent before the next user action.
        await microtasks(12);
        const actual = (setup as unknown as { intent: SpeechIntent }).intent;
        assert.deepEqual(actual && (actual.kind === 'path' ? { kind: actual.kind, path: actual.path } : { kind: actual.kind }), expectedIntent);
        if (rng() < .65) resolveOne();
        await microtasks(Math.floor(rng() * 6));
      }
      // Half the sequences check settled state without close masking pending, then close as the final step.
      if (sequence % 2 === 0) { await drain(); check(); }
      steps.push('close'); launch(setup.close()); await drain(); check();
    } catch (error) {
      throw new Error(`seed=${seed} sequence=${sequence} steps=${JSON.stringify(steps)} trace=${JSON.stringify(trace)}: ${String(error)}`, { cause: error });
    } finally {
      // Always release fake boundaries, even after an assertion failure.
      failSave = false; loadOutcome = true; oracleFailure = undefined;
      launch(setup.close()); await drain();
    }
  }
  const durationMs = +(performance.now() - started).toFixed(2);
  console.log(JSON.stringify({ seed, sequences: 2000, steps: '3–12', durationMs, failedSaves, failedLoads, successfulLoads, coverage }));
});
