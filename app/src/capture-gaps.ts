import type { CaptureGap } from '../public/capture-gaps.js';
export type CaptureDiscontinuity = { offsetSamples: number; fromWallMs: number; toWallMs: number };
export type CaptureTiming = { captureWallMs: number; suspension?: { fromWallMs: number; toWallMs: number }; discontinuities?: CaptureDiscontinuity[] };
type PreviousCapture = { captureWallMs?: number | null; captureEndWallMs?: number | null; samples: number };

/** Optional metadata is bounded and ignored if malformed; it must never cause an otherwise valid audio upload to fail. */
export function captureDiscontinuities(value: unknown, samples: number): CaptureDiscontinuity[] {
  if (!Array.isArray(value) || value.length > 128) return [];
  let offset = 0, end = -Infinity;
  for (const d of value) {
    if (!d || !Number.isInteger(d.offsetSamples) || d.offsetSamples <= offset || d.offsetSamples >= samples
      || !Number.isFinite(d.fromWallMs) || !Number.isFinite(d.toWallMs) || d.fromWallMs < 0 || d.toWallMs >= 8.64e15
      || d.toWallMs - d.fromWallMs <= 5000 || d.fromWallMs < end) return [];
    offset = d.offsetSamples; end = d.toWallMs;
  }
  return value;
}

function gapAt(fromWallMs: number, toWallMs: number, atMs: number, timing: CaptureTiming): Omit<CaptureGap, 'meetingId' | 'source'> {
  const suspension = timing.suspension;
  const sleep = suspension && suspension.fromWallMs < toWallMs && suspension.toWallMs > fromWallMs;
  return { atMs, fromWallMs, toWallMs, reason: sleep ? 'sleep' : null };
}

/** Compare first-sample capture times, not receipt times. An unknown predecessor breaks the chain. */
export function detectCaptureGap(previous: PreviousCapture | undefined,
  timing: CaptureTiming | undefined, atMs: number, rate: number): Omit<CaptureGap, 'meetingId' | 'source'> | null {
  if (!previous || !Number.isFinite(previous.captureWallMs) || !timing || !Number.isFinite(timing.captureWallMs)) return null;
  // New frames account for sleeps inside their PCM. Old frames retain the first-sample + duration fallback.
  const fromWallMs = previous.captureEndWallMs ?? (previous.captureWallMs! + previous.samples * 1000 / rate);
  const toWallMs = timing.captureWallMs;
  return toWallMs - fromWallMs > 5000 ? gapAt(fromWallMs, toWallMs, atMs, timing) : null;
}

/** Both kinds of evidence share the frame's atomic save, including when this is the source's last frame. */
export function detectFrameCaptureGaps(previous: PreviousCapture | undefined, timing: CaptureTiming | undefined,
  atMs: number, samples: number, rate: number) {
  const boundary = detectCaptureGap(previous, timing, atMs, rate);
  const inside = timing ? captureDiscontinuities(timing.discontinuities, samples) : [];
  const gaps = boundary ? [boundary] : [];
  for (const d of inside) gaps.push(gapAt(d.fromWallMs, d.toWallMs, atMs + d.offsetSamples * 1000 / rate, timing!));
  const endWallMs = timing ? timing.captureWallMs + samples * 1000 / rate + inside.reduce((sum, d) => sum + d.toWallMs - d.fromWallMs, 0) : null;
  return { gaps, endWallMs };
}
