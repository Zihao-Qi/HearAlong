import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

export class ScanTimeout extends Error {
  constructor() { super('Speech model scan timed out.'); }
}

/** Stop awaiting at the deadline; resource-producing operations dispose of late results. */
export function byDeadline<T>(pending: Promise<T>, deadline: number, discard?: (value: T) => Promise<unknown>): Promise<T> {
  if (deadline === Infinity) return pending;
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new ScanTimeout()); }, Math.max(0, deadline - performance.now()));
    timer.unref();
    pending.then(value => {
      clearTimeout(timer);
      if (expired || performance.now() >= deadline) {
        reject(new ScanTimeout());
        void Promise.resolve().then(() => discard?.(value)).catch(() => {});
      } else resolve(value);
    }, error => { clearTimeout(timer); if (!expired) reject(error); });
  });
}

/** Optional configuration is never read from a pipe/device or allowed an unbounded allocation. */
export async function readSmallFile(path: string, maxBytes: number, deadline: number) {
  const info = await byDeadline(stat(path), deadline);
  if (!info.isFile() || info.size > maxBytes) return null;
  const file = await byDeadline(open(path, constants.O_RDONLY | constants.O_NONBLOCK), deadline, file => file.close());
  try {
    const opened = await byDeadline(file.stat(), deadline);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await byDeadline(file.read(buffer, size, buffer.length - size, size), deadline);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size <= maxBytes ? buffer.subarray(0, size).toString('utf8') : null;
  } finally { await byDeadline(file.close(), deadline).catch(() => {}); }
}
