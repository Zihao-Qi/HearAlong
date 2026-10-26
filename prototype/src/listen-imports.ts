import { CHUNK_SECONDS, decodeChunk, SAMPLE_RATE } from './audio.ts';

type Pending = { controller: AbortController; users: number; done: Promise<Float32Array> };
// Global across requests: four 20 s mono windows (5.12 MB PCM), at most two decoders.
const cached = new Map<string, Float32Array>(), pending = new Map<string, Pending>();
const waiting = new Set<() => void>();
let decoding = 0;
async function acquire(signal: AbortSignal) {
  signal.throwIfAborted();
  if (decoding < 2) { decoding++; return; }
  await new Promise<void>((resolve, reject) => {
    const ready = () => { cleanup(); decoding++; resolve(); };
    const cancelled = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => { waiting.delete(ready); signal.removeEventListener('abort', cancelled); };
    waiting.add(ready); signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}
function release() { decoding--; waiting.values().next().value?.(); }

/** Requests share a decode, but cancelling the last waiter also cancels queued/running work. */
export async function importedWindow(path: string, start: number, seconds: number, signal: AbortSignal): Promise<Float32Array> {
  signal.throwIfAborted();
  if (seconds <= 0 || seconds > CHUNK_SECONDS) throw new Error('Playback import window exceeds its bound.');
  const key = JSON.stringify([process.env.MEETING_FFMPEG ?? 'ffmpeg', path, start, seconds]);
  const hit = cached.get(key);
  if (hit) { cached.delete(key); cached.set(key, hit); return hit; }
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, done: Promise.resolve(new Float32Array()) };
    const current = entry;
    entry.done = (async () => {
      await acquire(controller.signal);
      try {
        controller.signal.throwIfAborted();
        const pcm = await decodeChunk(path, start, seconds, undefined, controller.signal);
        controller.signal.throwIfAborted();
        if (pcm.length > CHUNK_SECONDS * SAMPLE_RATE) throw new Error('Decoded playback window exceeds its bound.');
        cached.set(key, pcm);
        while (cached.size > 4) cached.delete(cached.keys().next().value!);
        return pcm;
      } finally { release(); }
    })().finally(() => { if (pending.get(key) === current) pending.delete(key); });
    pending.set(key, entry);
  }
  const current = entry; current.users++;
  return new Promise<Float32Array>((resolve, reject) => {
    let finished = false;
    const finish = (pcm?: Float32Array, error?: unknown) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', cancel);
      if (--current.users === 0 && pending.get(key) === current) {
        pending.delete(key); current.controller.abort();
      }
      if (pcm) resolve(pcm); else reject(error);
    };
    const cancel = () => finish(undefined, signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    current.done.then(pcm => finish(pcm), error => finish(undefined, error));
    if (signal.aborted) cancel();
  });
}
