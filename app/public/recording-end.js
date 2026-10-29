/** End messages outlive the capture session. Losing one must not leave a stopped meeting open forever. */
export function createRecordingEnds(send, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();
  function attempt(entry) {
    clearTimer(entry.timer);
    entry.work = Promise.resolve().then(() => send(entry.path, entry.value)).then(reply => {
      pending.delete(entry.key);
      return reply;
    }, error => {
      // A deleted meeting needs no end. Otherwise keep the tiny idempotent message until the page closes or it succeeds.
      if (error.status === 404) pending.delete(entry.key);
      else {
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(entry.failures++, 5));
        entry.timer = setTimer(() => { void attempt(entry).catch(() => {}); }, wait);
      }
      throw error;
    });
    return entry.work;
  }
  return {
    end(path, value) {
      const key = `${path}:${value.source}`, existing = pending.get(key);
      if (existing) return existing.work;
      // Snapshot values rather than retain the AudioContext, stream or discarded capture session.
      const entry = { key, path, value: { ...value }, failures: 0, timer: undefined, work: null };
      pending.set(key, entry);
      return attempt(entry);
    },
  };
}
