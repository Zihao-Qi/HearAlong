import { AsyncLocalStorage } from 'node:async_hooks';
import { isLocalModel, watchPiRun } from './pi-command.ts';

// One app server owns model work. Keep cloud concurrency and reserve local turns before starting any execution timer.
type Lane = { tail: Promise<void>; closed?: boolean };
/** Admission was cancelled, not a provider failure. Task callers keep the existing cancelled reason. */
export class LocalPiCancelled extends Error {
  readonly reason = 'cancelled';
  constructor() { super('Pi task was cancelled while waiting for the local model.'); }
}
const globalLane: Lane = { tail: Promise.resolve() };
const jobLane = new AsyncLocalStorage<Lane>();
export function inLocalPiLane<T>(model: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return isLocalModel(model) ? inLane(jobLane.getStore() ?? globalLane, run, signal) : run();
}
/** A plan's whole-job deadline starts after admission; its concurrent child calls still share a single inner lane. */
export function inLocalPiJob<T>(local: boolean, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!local) return run();
  return inLane(globalLane, async () => {
    const lane: Lane = { tail: Promise.resolve() };
    try { return await jobLane.run(lane, run); }
    finally { lane.closed = true; await lane.tail; }
  }, signal);
}
async function inLane<T>(lane: Lane, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const stopped = () => controller.abort(new LocalPiCancelled());
  const unwatch = watchPiRun(stopped);
  const waiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const previous = lane.tail;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  lane.tail = previous.then(() => turn);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new LocalPiCancelled());
    waiting.addEventListener('abort', abort, { once: true });
    if (waiting.aborted) abort();
  });
  try {
    await Promise.race([previous, cancelled]);
    waiting.throwIfAborted();
    if (lane.closed) throw new Error('The local model job has ended.');
    unwatch(); waiting.removeEventListener('abort', abort);
    return await run();
  } finally { unwatch(); waiting.removeEventListener('abort', abort); release(); }
}
