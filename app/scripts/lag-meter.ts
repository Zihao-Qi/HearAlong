// How late each piece of text arrives (the endurance runs, M7 §6): measured per line, not as "audio held minus text shown", which
// counted the recording's own silences and the 20 s turn changes as lag.
// - A final line's lag: when it first appears in a snapshot, minus when the audio up to its end had reached the server.
// - The preview's lag: each time a draft's covered audio grows, the time then minus when the audio up to the new coverage had
//   reached the server. Coverage grows through silence too, so a silence is never counted as lag.
// Times are wall-clock milliseconds; audio positions are meeting milliseconds, per source.

type Arrival = { endMs: number; at: number };

export class LagMeter {
  private arrivals = new Map<string, Arrival[]>(); // per source, increasing in endMs
  private seen = new Set<string>();
  private covered = new Map<string, number>();

  /** The server has `source`'s audio up to `endMs` (meeting time) as of `at`. */
  audio(source: string, endMs: number, at: number) {
    const list = this.arrivals.get(source) ?? [];
    if (!list.length || endMs > list.at(-1)!.endMs) list.push({ endMs, at });
    this.arrivals.set(source, list);
  }
  /** When the source's audio up to `ms` had reached the server (the first arrival that covers it), or null if it has not. */
  private when(source: string, ms: number): number | null {
    const list = this.arrivals.get(source);
    if (!list?.length || list.at(-1)!.endMs < ms - 1) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].endMs >= ms - 1) hi = mid; else lo = mid + 1; }
    return list[lo].at;
  }
  /** One snapshot of the transcript (`segments` with `source` when labelled, `drafts`) seen at `at`: the new samples it gives. */
  poll(snapshot: { segments: { id: string; endMs: number; source?: string }[]; drafts: { source: string; window: string; windowStartMs: number; coveredUntilMs: number }[] }, at: number, fallbackSource?: string) {
    const final: number[] = [], draft: number[] = [];
    for (const s of snapshot.segments) {
      if (this.seen.has(s.id)) continue;
      this.seen.add(s.id);
      const from = this.when(s.source ?? fallbackSource ?? '', s.endMs);
      if (from !== null) final.push(at - from);
    }
    for (const d of snapshot.drafts) {
      const key = `${d.source} ${d.window}`;
      const before = this.covered.get(key) ?? d.windowStartMs; // a new window covers nothing until its first words
      this.covered.set(key, Math.max(before, d.coveredUntilMs));
      if (d.coveredUntilMs <= before) continue;
      const from = this.when(d.source, d.coveredUntilMs);
      if (from !== null) draft.push(at - from);
    }
    return { final, draft };
  }
}
