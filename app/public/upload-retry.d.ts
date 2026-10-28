export function uploadWithRetry<T>(options: {
  attempt: (timeoutMs: number) => Promise<T>;
  /** Absolute drain deadline; a getter can expose Stop starting during a retry. */
  until?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T>;
