// Pure pieces of the live lag measurement: when one uploaded frame ends, when a meeting position was spoken,
// one segments snapshot fed to LagMeter, and DOM sights turned into spoken-to-visible lag.
import { LagMeter } from '../lag-meter.ts';

export type FrameEnd = { source: string; endMs: number };

/** One captured PCM frame. `captureWallMs` is the wall time of the first sample; `startMs` is that sample's meeting time. */
export type SpokenFrame = { source: string; startMs: number; endMs: number; captureWallMs: number };

/**
 * One DOM observation. `key` is the draft row for a preview and the segment id (`span[data-id]`) for a final.
 * `endMs` is the meeting time that sight covers. A final span has no end attribute, so `endMs` is null
 * until the segments snapshot supplies it.
 */
export type DomSight = { kind: 'preview' | 'final'; key: string; endMs: number | null; at: number };

/** A meeting position this close past a frame end still belongs to that frame. The spoken time stays inside the frame. */
const COVERAGE_SLACK_MS = 1;

/**
 * Meeting-time end of one PCM upload. Headers are the lower-case names Playwright reports.
 * The body is 16-bit-width float32 samples; `byteLength` must be a positive multiple of 4.
 * End time is the header start plus the samples at the header rate. A 201 is the caller's signal that the server has the audio.
 */
export function frameEndMs(headers: Record<string, string | undefined>, byteLength: number): FrameEnd | null {
  const source = headers['x-audio-source'];
  const start = Number(headers['x-start-ms']);
  const rate = Number(headers['x-sample-rate']);
  if (!source || !Number.isFinite(start) || !Number.isFinite(rate) || rate <= 0 || byteLength <= 0 || byteLength % 4 !== 0) return null;
  return { source, endMs: start + (byteLength / 4) * 1000 / rate };
}

type SegmentRow = { id: string; endMs: number; source?: string };
type DraftRow = { source: string; window: string; windowStartMs: number; coveredUntilMs: number };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function segmentOf(value: unknown): SegmentRow | null {
  const row = record(value);
  if (!row || typeof row.id !== 'string' || typeof row.endMs !== 'number' || !Number.isFinite(row.endMs)) return null;
  return typeof row.source === 'string' ? { id: row.id, endMs: row.endMs, source: row.source } : { id: row.id, endMs: row.endMs };
}

function draftOf(value: unknown): DraftRow | null {
  const row = record(value);
  if (!row || typeof row.source !== 'string' || typeof row.window !== 'string') return null;
  if (typeof row.windowStartMs !== 'number' || typeof row.coveredUntilMs !== 'number') return null;
  if (!Number.isFinite(row.windowStartMs) || !Number.isFinite(row.coveredUntilMs)) return null;
  return { source: row.source, window: row.window, windowStartMs: row.windowStartMs, coveredUntilMs: row.coveredUntilMs };
}

/**
 * One poll of the segments API. `preview` is LagMeter's draft samples and `final` its final-line samples.
 * A mic-only meeting does not label segment sources; pass the microphone source id as `fallbackSource`.
 */
export function applySnapshot(meter: LagMeter, body: unknown, at: number, fallbackSource?: string): { preview: number[]; final: number[] } {
  const snap = record(body);
  const segments = Array.isArray(snap?.segments) ? snap.segments.flatMap(item => { const row = segmentOf(item); return row ? [row] : []; }) : [];
  const drafts = Array.isArray(snap?.drafts) ? snap.drafts.flatMap(item => { const row = draftOf(item); return row ? [row] : []; }) : [];
  const sample = meter.poll({ segments, drafts }, at, fallbackSource);
  return { preview: sample.draft, final: sample.final };
}

/**
 * The frame the page uploaded, or null when the capture clock is missing.
 * `X-Capture-Wall-Ms` is the wall time of the first sample. The body is float32; its length sets the frame end.
 * The server accepts a capture time that is finite, above 0, and below 8.64e15. This uses the same bounds.
 */
export function spokenFrame(headers: Record<string, string | undefined>, byteLength: number): SpokenFrame | null {
  const frame = frameEndMs(headers, byteLength);
  const captureWallMs = Number(headers['x-capture-wall-ms']);
  const startMs = Number(headers['x-start-ms']);
  if (!frame || !Number.isFinite(startMs) || !Number.isFinite(captureWallMs) || captureWallMs <= 0 || captureWallMs >= 8.64e15) return null;
  return { source: frame.source, startMs, endMs: frame.endMs, captureWallMs };
}

/**
 * Wall time when meeting position `ms` was spoken.
 * The frame that contains it contributes `captureWallMs + (ms - startMs)`, the sample offset within the frame.
 * A position on a shared boundary uses the later frame. A position in a gap, or more than 1 ms past every frame, is unmapped.
 */
export function spokenAt(frames: SpokenFrame[], ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  let best: SpokenFrame | null = null;
  for (const frame of frames) {
    if (ms < frame.startMs || ms > frame.endMs + COVERAGE_SLACK_MS) continue;
    if (!best || frame.startMs > best.startMs) best = frame;
  }
  if (!best) return null;
  const position = Math.min(ms, best.endMs);
  return best.captureWallMs + (position - best.startMs);
}

/** One DOM observation from the page, or null when the shape is wrong. A final may omit `endMs` when the span has no end attribute. */
export function domSight(value: unknown): DomSight | null {
  const row = record(value);
  if (!row || (row.kind !== 'preview' && row.kind !== 'final') || typeof row.key !== 'string' || !row.key) return null;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return null;
  if (row.kind === 'final' && (row.endMs === null || row.endMs === undefined)) return { kind: 'final', key: row.key, endMs: null, at: row.at };
  if (typeof row.endMs !== 'number' || !Number.isFinite(row.endMs)) return null;
  return { kind: row.kind, key: row.key, endMs: row.endMs, at: row.at };
}

/** Copy `id` → `endMs` from a segments snapshot. A later poll overwrites the same id. Ids already stored are kept when a poll omits them. */
export function rememberSegmentEnds(body: unknown, into: Map<string, number>): void {
  const snap = record(body);
  if (!Array.isArray(snap?.segments)) return;
  for (const item of snap.segments) {
    const row = segmentOf(item);
    if (row) into.set(row.id, row.endMs);
  }
}

function bySight(a: DomSight, b: DomSight): number {
  return a.at - b.at || (a.endMs ?? 0) - (b.endMs ?? 0) || a.key.localeCompare(b.key);
}

/** Union of the polled page log and the samples pushed out of the page. Same stamp is kept once, in time order. */
export function mergeSights(polled: DomSight[], exposed: DomSight[]): DomSight[] {
  const seen = new Set<string>();
  const merged: DomSight[] = [];
  for (const sight of [...polled, ...exposed]) {
    const id = `${sight.kind}\0${sight.key}\0${sight.endMs}\0${sight.at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(sight);
  }
  merged.sort(bySight);
  return merged;
}

/**
 * Spoken-to-visible lag. Sights may arrive in any order.
 * Preview: a grey row's end moves forward. The sample is the visible time minus the spoken time of the new end,
 * so a silent stretch that the row jumps across is not added on top. A repeat or a retraction adds nothing.
 * Final: the first sight of one saved segment (`key` is `span[data-id]`), minus the spoken time of that segment's end.
 * A span end attribute is that end. When the span has none, `ends` (segment id → endMs from the segments snapshot) supplies it.
 * A second segment that joins a paragraph is its own key, so it is its own sample. A later sight of the same id adds nothing.
 * An end that is missing from both the span and the map, or that no frame covers, is left out.
 */
export function visibleLags(frames: SpokenFrame[], sights: DomSight[], ends: ReadonlyMap<string, number> = new Map()): { preview: number[]; final: number[] } {
  const preview: number[] = [];
  const finals: number[] = [];
  const covered = new Map<string, number>();
  const seen = new Set<string>();
  for (const sight of [...sights].sort(bySight)) {
    if (sight.kind === 'preview') {
      if (sight.endMs === null) continue;
      const before = covered.get(sight.key);
      if (before !== undefined && sight.endMs <= before) continue;
      covered.set(sight.key, sight.endMs);
      const spoken = spokenAt(frames, sight.endMs);
      if (spoken !== null) preview.push(sight.at - spoken);
    } else {
      if (seen.has(sight.key)) continue;
      seen.add(sight.key);
      const endMs = sight.endMs ?? ends.get(sight.key);
      if (endMs === undefined || !Number.isFinite(endMs)) continue;
      const spoken = spokenAt(frames, endMs);
      if (spoken !== null) finals.push(sight.at - spoken);
    }
  }
  return { preview, final: finals };
}

/**
 * Headline lag includes the browser and the page, so its median should not beat the server diagnostic.
 * Returns a warning when the headline p50 is more than 250 ms below the diagnostic p50.
 * Either side with no samples is not compared. The caller records the text and does not fail the run.
 */
export function headlineLagWarning(kind: 'preview' | 'final', headline: { p50: number; n: number }, diagnostic: { p50: number; n: number }): string | null {
  if (headline.n === 0 || diagnostic.n === 0) return null;
  const gap = diagnostic.p50 - headline.p50;
  if (gap <= 250) return null;
  return `Headline ${kind} p50 ${headline.p50.toFixed(0)} ms is ${gap.toFixed(0)} ms below the diagnostic p50 ${diagnostic.p50.toFixed(0)} ms (more than 250 ms).`;
}
