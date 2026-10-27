/** Numeric-only notes telemetry. Unknown/unreported usage stays null, not an invented zero. */
export type RequestDiagnostics = {
  stopReason: string | null;
  usage: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null };
};
export type PartDiagnostics = { wallMs: number; waitMs: number | null; requests: RequestDiagnostics[] };
export type NotesDiagnostics = { jobId: string; parts: Record<'project' | 'tasks' | 'other', PartDiagnostics> };
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const reasons = new Set(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
const request = (value?: any): RequestDiagnostics => ({
  stopReason: reasons.has(value?.stopReason) ? value.stopReason : null,
  usage: { input: number(value?.usage?.input), output: number(value?.usage?.output), reasoning: number(value?.usage?.reasoning), cacheRead: number(value?.usage?.cacheRead) },
});
export const emptyPartDiagnostics = (): PartDiagnostics => ({ wallMs: 0, waitMs: null, requests: [] });
/** turn_start counts requests even when Pi is killed before response headers/message_start. */
export function partDiagnosticEvent(part: PartDiagnostics, event: any) {
  if (event?.type === 'turn_start') part.requests.push(request());
  if (event?.message?.role !== 'assistant' || !['message_start', 'message_update', 'message_end'].includes(event.type)) return;
  if (!part.requests.length || part.requests.at(-1)!.stopReason !== null) part.requests.push(request());
  // Streaming usage can survive a timeout; a final event replaces it with Pi's settled usage.
  const current = part.requests.at(-1)!;
  if (event.message.usage) current.usage = request(event.message).usage;
  if (event.type === 'message_end') current.stopReason = request(event.message).stopReason;
}
/** Whitelist both newly written and reloaded rows: no message, prompt, error or transcript text. */
export function notesDiagnosticsRows(value: unknown): NotesDiagnostics[] {
  if (!Array.isArray(value)) return [];
  return value.filter(row => row && typeof row.jobId === 'string' && row.parts).slice(-10).map(row => ({
    jobId: row.jobId,
    parts: Object.fromEntries(['project', 'tasks', 'other'].map(name => {
      const part = row.parts[name];
      return [name, { wallMs: number(part?.wallMs) ?? 0, waitMs: number(part?.waitMs), requests: Array.isArray(part?.requests) ? part.requests.map(request) : [] }];
    })) as NotesDiagnostics['parts'],
  }));
}
