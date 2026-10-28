const RETRY_MS = 30_000;
const ATTEMPT_MS = 10_000;

/** Retry the same frame's bytes. Re-read until so Stop can bound a frame already retrying. */
export async function uploadWithRetry(options) {
  const { attempt, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  const started = now();
  let failures = 0, lastError;
  for (;;) {
    const current = now(), left = RETRY_MS - (current - started);
    const drainLeft = (options.until ?? Infinity) - current;
    if (drainLeft <= 0) throw lastError ?? new Error('saving deadline reached');
    if (left <= 0 && failures >= 3) throw lastError;
    try {
      // The first three attempts get a real chance after wake, unless Stop's deadline wins.
      return await attempt(Math.min(drainLeft, failures < 3 ? ATTEMPT_MS : Math.min(ATTEMPT_MS, left)));
    } catch (error) {
      if (error.status !== undefined && !(error.status >= 500 && error.status < 600)) throw error;
      lastError = error;
      failures++;
      const current = now(), remaining = RETRY_MS - (current - started);
      const drainLeft = (options.until ?? Infinity) - current;
      if (drainLeft <= 0 || (remaining <= 0 && failures >= 3)) throw error;
      const wait = 500 * 2 ** Math.min(failures - 1, 3);
      await sleep(Math.min(wait, drainLeft, remaining > 0 ? remaining : Infinity));
    }
  }
}
