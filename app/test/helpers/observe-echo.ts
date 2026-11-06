import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

export type EchoEvent = { event: string; id?: string; force?: boolean; expired?: boolean; ids?: string[]; pending?: number; now?: number; wallNow?: number };
export const observedWorker = new URL('../fixtures/echo-observed-worker.ts', import.meta.url);

/** Observe real worker delivery/drains. No polling, sleeps, or alternate AEC implementation. */
export function observeEcho(t: TestContext) {
  const events: EchoEvent[] = [], listeners = new Set<() => void>(), workers = new WeakSet<Worker>();
  const post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, ...args: Parameters<Worker['postMessage']>) {
    if (!workers.has(this)) {
      workers.add(this);
      this.on('message', (message: EchoEvent & { kind: string }) => {
        if (message.kind !== 'echo-observed') return;
        events.push(message);
        for (const listener of listeners) listener();
      });
    }
    return post.apply(this, args);
  });
  const waitFor = (predicate: (event: EchoEvent) => boolean, since = 0) => new Promise<EchoEvent>((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Timed out awaiting an AEC ordering observation.')); }, 10_000);
    const check = () => {
      const event = events.slice(since).find(predicate);
      if (!event) return;
      clearTimeout(timer); listeners.delete(check); resolve(event);
    };
    listeners.add(check); check();
  });
  const assertReleased = (id: string, by: 'flush' | 'reference-ended' | 'reference') => {
    const admitted = events.findLastIndex(event => event.event === 'microphone' && event.id === id);
    const index = events.findIndex((event, at) => at > admitted && event.event === 'drain' && event.ids?.includes(id));
    assert.ok(admitted >= 0, `worker observed microphone ${id}`);
    assert.ok(index >= 0, `worker emitted ${id}, rather than a watchdog raw fallback`);
    assert.ok(!events.slice(admitted + 1, index + 1).some(event => event.expired), `${id} did not use its reference timeout`);
    assert.ok(events.slice(0, index).some(event => event.event === by), `${by} was observed before ${id} completed`);
    if (by === 'flush') {
      assert.ok(events.slice(admitted + 1, index).some(event => event.event === 'flush'), `flush followed admission of ${id}`);
      assert.equal(events[index].force, true, `${id} was released by a forced checkpoint`);
    }
  };
  return { events, waitFor, assertReleased, workerScript: observedWorker };
}
