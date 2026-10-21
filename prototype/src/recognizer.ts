import { fork, type ChildProcess } from 'node:child_process';
import type { Chunk } from './store.ts';
import type { Word } from './recovery.ts';

export type Recognition = {
  text: string; backend: string; computeMs: number; decodeMs: number; audioSeconds: number;
  processRssBytes: number; timestampKind: string; words: Word[];
  /** Native segment timings: the fallback when word timings are unusable. */
  segments?: Word[];
  retries?: number; recoveredBy?: 'halves' | 'normalized' | null;
};

/** A subprocess, not a thread: native crashes cannot take down the recorder/server. */
export class LocalRecognizer {
  modelPath: string;
  workerScript: URL;
  worker?: ChildProcess;
  lastExit?: { code: number | null; signal: string | null };
  backend = 'not loaded';
  private ready = false;
  private closing = false;
  private pending?: { resolve: (result: Recognition) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; job: Chunk };
  constructor(modelPath: string, workerScript = new URL('./stt-worker.ts', import.meta.url)) {
    this.modelPath = modelPath;
    this.workerScript = workerScript;
  }
  transcribe(job: Chunk): Promise<Recognition> {
    if (this.closing) return Promise.reject(new Error('Recognizer has stopped.'));
    if (this.pending) return Promise.reject(new Error('Recognizer is busy.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Transcription timed out after 120 seconds.')), 120_000);
      this.pending = { resolve, reject, timer, job };
      if (!this.worker) {
        this.ready = false;
        this.worker = fork(this.workerScript, [this.modelPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const child = this.worker;
        let stderr = '';
        child.stderr?.on('data', part => { stderr = (stderr + part.toString()).slice(-4000); });
        child.on('message', (message: any) => {
          if (message.kind === 'ready') {
            this.ready = true;
            this.backend = message.backend;
            this.sendPending();
          } else if (message.id === this.pending?.job.id) {
            const pending = this.pending!;
            this.pending = undefined;
            clearTimeout(pending.timer);
            if (message.kind === 'result') pending.resolve(message.result);
            else pending.reject(new Error(message.error));
          }
        });
        child.on('error', error => this.fail(error));
        child.on('exit', (code, signal) => {
          this.lastExit = { code, signal };
          if (this.worker === child) this.fail(new Error(`STT process exited (${signal ?? code}). ${stderr}`));
        });
      } else if (this.ready) this.sendPending();
    });
  }
  private sendPending() {
    if (!this.pending) return;
    const job = this.pending.job;
    this.worker?.send({ kind: 'transcribe', id: job.id, path: job.path, decodeStart: job.decodeStart, seconds: job.seconds, sampleRate: job.sampleRate ?? undefined });
  }
  private fail(error: Error) {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    this.backend = 'not loaded';
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  }
  async close() {
    this.closing = true;
    const child = this.worker;
    if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ kind: 'shutdown' });
      else child.kill('SIGKILL');
    });
  }
}
