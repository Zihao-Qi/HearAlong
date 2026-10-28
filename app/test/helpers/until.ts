import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

/** Wait for an observable prerequisite, not an assertion retry. Also works with mocked global timers. */
export async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) assert.fail('condition did not settle');
    await sleep(10);
  }
}
