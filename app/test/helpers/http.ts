import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type AsyncRequestListener = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

/** Node HTTP ignores listener promises; fail the owning test as well as the request if a fixture rejects. */
export function createAsyncServer(t: { after(fn: () => unknown): void }, handler: AsyncRequestListener) {
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  t.after(async () => { await Promise.all(pending); assert.deepEqual(failures, [], 'HTTP fixture handler failed'); });
  return createServer((req, res) => {
    // HTTP cannot await callbacks; track completion for teardown and make rejection a test failure.
    const run = Promise.resolve().then(() => handler(req, res)).then(() => {}).catch(error => {
      failures.push(error);
      console.error('HTTP fixture handler failed:', error);
      res.destroy();
    }).finally(() => { pending.delete(run); });
    pending.add(run);
  });
}
