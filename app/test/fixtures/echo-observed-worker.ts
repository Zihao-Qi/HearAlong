// Observe the production worker/scheduler, without replacing its DSP or scheduling policy.
import { parentPort } from 'node:worker_threads';
import { EchoScheduler } from '../../src/echo-scheduler.ts';
if (!parentPort) throw new Error('Fixture needs a worker.');
const port = parentPort;
const drain = EchoScheduler.prototype.drain;
EchoScheduler.prototype.drain = function(now, force = false, fadeToRaw = false) {
  const deadline = this.deadline;
  const results = drain.call(this, now, force, fadeToRaw);
  port.postMessage({ kind: 'echo-observed', event: 'drain', now, wallNow: Date.now(), force, expired: !force && now >= deadline,
    ids: results.map(result => result.id), pending: this.buffered().pending });
  return results;
};
// An observation is sent BEFORE dispatch, so it precedes any resulting audio reply.
const on = port.on.bind(port);
port.on = ((event, listener) => on(event, event === 'message' ? (message: { kind: string; id?: string }) => {
  port.postMessage({ kind: 'echo-observed', event: message.kind, id: message.id });
  listener(message);
} : listener)) as typeof port.on;
await import('../../src/echo-worker.ts');
