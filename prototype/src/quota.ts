// The shared quota cooldown (M7b §4): a rate-limit error from any sol job (actions, notes, memory updates, plans) pauses the
// others for the same time. The web tools' own throttling (a search service answering 429) is kept apart from the model's
// quota: it pauses the jobs that wait on the web, and says so, but it does not stop the model's other users.
import type { ToolResult } from './pi-task.ts';

export const RATE_LIMIT = /rate.?limit|\b429\b|usage limit|quota exceeded|too many requests/i;
export const COOLDOWN_MS = 5 * 60_000;
/** How often a job waiting for a cooldown looks again (it may be extended, or the clock may be a test's). */
export const QUOTA = { pollMs: 1000 };
export type QuotaKind = 'model' | 'web';

/** Failures inside a tool result, including per-query and per-page errors of an otherwise successful web call. */
export function toolErrors(r: ToolResult): string[] {
  const s = (r.structured ?? {}) as { queries?: { error?: unknown }[]; urls?: { error?: unknown }[] };
  return [...(r.isError ? [r.text] : []), ...[...(s.queries ?? []), ...(s.urls ?? [])].map(x => x?.error).filter((e): e is string => typeof e === 'string' && e !== '')];
}
export const WEB_TOOLS = ['web_search', 'fetch_content', 'get_search_content'];
/** A web tool's own rate limit (not the model's): from its error text or a per-query or per-page error. */
export function webRateLimited(r: ToolResult): boolean {
  return WEB_TOOLS.includes(r.name) && toolErrors(r).some(e => RATE_LIMIT.test(e));
}
/** A local clock time for messages ("until 14:05"). */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** One per server, shared by every sol job. A hit only ever extends a cooldown. */
export class Cooldowns {
  private until: Record<QuotaKind, number> = { model: 0, web: 0 };
  private listeners = new Set<(kind: QuotaKind, from: string | undefined) => void>();
  private clock: () => number;
  constructor(clock: () => number = Date.now) { this.clock = clock; }
  /** A rate-limit error seen by `from` (a job id, or a job type): the others wait as long. */
  hit(kind: QuotaKind, from?: string, ms = COOLDOWN_MS) {
    this.until[kind] = Math.max(this.until[kind], this.clock() + ms);
    for (const listener of this.listeners) {
      try { listener(kind, from); } catch (error) { console.warn(`Quota listener: ${(error as Error).message}`); }
    }
  }
  /** When the cooldown ends, or null when none is in force. */
  pausedUntil(kind: QuotaKind): number | null { return this.until[kind] > this.clock() ? this.until[kind] : null; }
  /** Resolves once no cooldown of this kind is in force (looking again at least every QUOTA.pollMs); rejects when `signal` aborts. */
  async wait(kind: QuotaKind, signal?: AbortSignal) {
    for (let until = this.pausedUntil(kind); until; until = this.pausedUntil(kind)) {
      if (signal?.aborted) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.max(1, Math.min(QUOTA.pollMs, until - this.clock())));
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (signal?.aborted) throw new Error("Stopped while waiting for the model's quota.");
  }
  /** Told of every hit (an exploration gives way to a recording, §4). Returns the way to stop listening. */
  onHit(listener: (kind: QuotaKind, from: string | undefined) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
