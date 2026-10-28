// Offline M9a rule. No clocks, I/O, or live-capture changes.
import { chooseCut } from './live.ts';

export const RATE = 16_000;
export const BLOCK_SAMPLES = RATE / 5;
export type Rule = { id: string; kind: 'today' | 'pause' | 'fixed'; min: number; max: number };
export const RULES: Rule[] = [
  { id: 'today', kind: 'today', min: 16, max: 24 },
  { id: 'pause8', kind: 'pause', min: 8, max: 12 },
  { id: 'pause10', kind: 'pause', min: 10, max: 15 },
  { id: 'fixed12', kind: 'fixed', min: 12, max: 12 },
];
export const rms = (pcm: Float32Array): number => Math.sqrt(pcm.reduce((s, x) => s + x * x, 0) / Math.max(1, pcm.length));
export const dbfs = (pcm: Float32Array): number => 20 * Math.log10(rms(pcm));
/** Nearest-rank percentile: rank ceil(0.1 * 50) = 5. Only the last 50 source blocks count. */
export function pauseThreshold(levels: readonly number[]): number {
  if (levels.length < 50) return -50;
  const sorted = levels.slice(-50).sort((a, b) => a - b);
  return Math.max(-60, Math.min(-38, sorted[4] + 6));
}
export type Boundary = { pause: boolean; quietness: number; todayLoudness: number; threshold: number; leftDb: number; rightDb: number };
/** Caller supplies ONLY audio that has arrived, ending with the right-hand frame. History includes sealed audio. */
export function boundaryAt(arrived: Float32Array, cutSample: number): Boundary {
  if (cutSample < BLOCK_SAMPLES || arrived.length < cutSample + BLOCK_SAMPLES) throw new Error('Boundary lacks its right-hand audio.');
  const levels: number[] = [];
  const end = Math.floor(arrived.length / BLOCK_SAMPLES) * BLOCK_SAMPLES;
  for (let i = Math.max(0, end - 50 * BLOCK_SAMPLES); i < end; i += BLOCK_SAMPLES) levels.push(dbfs(arrived.subarray(i, i + BLOCK_SAMPLES)));
  const threshold = pauseThreshold(levels);
  const left = arrived.subarray(cutSample - BLOCK_SAMPLES, cutSample), right = arrived.subarray(cutSample, cutSample + BLOCK_SAMPLES);
  const leftDb = dbfs(left), rightDb = dbfs(right);
  return { threshold, leftDb, rightDb, pause: leftDb < threshold && rightDb < threshold,
    quietness: rms(left) + rms(right),
    todayLoudness: rms(left.subarray(BLOCK_SAMPLES / 2)) + rms(right.subarray(0, BLOCK_SAMPLES / 2)) };
}
/** First frame NOT sealed; null means wait. Evidence is frozen at each boundary's right-frame arrival. */
export function chooseWindowCut(rule: Rule, frames: { samples: number }[], evidence: (index: number) => Boundary, force = false): number | null {
  if (!frames.length) return null;
  const seconds = frames.reduce((s, f) => s + f.samples / RATE, 0);
  // Today's idle/end path: take all held audio if it fits, including short last frames.
  if (force && seconds <= rule.max) return frames.length;
  if (rule.kind === 'today') return seconds >= rule.max || force ? chooseCut(frames, i => evidence(i).todayLoudness) : null;
  if (rule.kind === 'fixed') {
    let elapsed = 0;
    for (let i = 0; i < frames.length; i++) { elapsed += frames[i].samples / RATE; if (elapsed >= rule.max) return i + 1; }
    return null;
  }
  let elapsed = 0, best: number | null = null, quietest = Infinity;
  for (let i = 1; i < frames.length; i++) { // never inspect the boundary after the last arrived frame
    elapsed += frames[i - 1].samples / RATE;
    if (elapsed < rule.min) continue;
    if (elapsed > rule.max) break;
    // A short EOF frame has arrived, but may not yet supply the full 200 ms right-hand block.
    if (frames[i].samples < BLOCK_SAMPLES) continue;
    const b = evidence(i);
    if (b.pause) return i;
    if (b.quietness <= quietest) { best = i; quietest = b.quietness; }
  }
  return seconds >= rule.max || force ? best : null;
}
