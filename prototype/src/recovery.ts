// Recovery for windows the recognizer returns empty although they clearly contain sound.
export type Word = { text: string; t0Ms: number; t1Ms: number };
export type Pass = { text: string; words: Word[]; segments?: Word[] };
export type Recovered = Pass & { retries: number; recoveredBy: 'halves' | 'normalized' | null };

const RATE = 16_000;
const FRAME = 480; // 30 ms

function frameDb(pcm: Float32Array): number[] {
  const result: number[] = [];
  for (let start = 0; start + FRAME <= pcm.length; start += FRAME) {
    let sum = 0;
    for (let i = start; i < start + FRAME; i++) sum += pcm[i] * pcm[i];
    result.push(10 * Math.log10(sum / FRAME + 1e-12));
  }
  return result;
}

/**
 * Share of 30 ms frames louder than the threshold. Calibrated on a quiet laptop room recording, where
 * transcribed speech windows sit around -50 dBFS median, so the gate is deliberately permissive.
 */
export function activeFraction(pcm: Float32Array, thresholdDb = -50): number {
  const frames = frameDb(pcm);
  return frames.length ? frames.filter(db => db > thresholdDb).length / frames.length : 0;
}

/** Scale so the 95th-percentile frame reaches the target, with bounded gain and clipping. */
export function normalized(pcm: Float32Array, targetDb = -20, maxGainDb = 20): Float32Array {
  const frames = frameDb(pcm).sort((a, b) => a - b);
  if (!frames.length) return pcm;
  const p95 = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))];
  const gain = 10 ** (Math.min(maxGainDb, targetDb - p95) / 20);
  return pcm.map(sample => Math.max(-1, Math.min(1, sample * gain)));
}

/** Cut near the middle at the quietest frame within ±2 s, so a word is less likely to be split. */
export function splitPoint(pcm: Float32Array): number {
  const frames = frameDb(pcm);
  const middle = Math.floor(frames.length / 2);
  const reach = Math.floor((2 * RATE) / FRAME);
  let best = middle;
  for (let i = Math.max(1, middle - reach); i <= Math.min(frames.length - 2, middle + reach); i++) if (frames[i] < frames[best]) best = i;
  return best * FRAME;
}

export async function transcribeRecovering(pcm: Float32Array, run: (pcm: Float32Array) => Promise<Pass>): Promise<Recovered> {
  const first = await run(pcm);
  if (first.text.trim() || activeFraction(pcm) < 0.15) return { ...first, retries: 0, recoveredBy: null };
  const cut = splitPoint(pcm);
  const offsetMs = (cut / RATE) * 1000;
  const [left, right] = [await run(pcm.slice(0, cut)), await run(pcm.slice(cut))];
  const halves: Pass = {
    text: [left.text.trim(), right.text.trim()].filter(Boolean).join(' '),
    words: [...left.words, ...right.words.map(w => ({ ...w, t0Ms: w.t0Ms + offsetMs, t1Ms: w.t1Ms + offsetMs }))],
    segments: [...(left.segments ?? []), ...(right.segments ?? []).map(s => ({ ...s, t0Ms: s.t0Ms + offsetMs, t1Ms: s.t1Ms + offsetMs }))],
  };
  if (halves.text) return { ...halves, retries: 1, recoveredBy: 'halves' };
  const louder = await run(normalized(pcm));
  return { ...louder, retries: 2, recoveredBy: louder.text.trim() ? 'normalized' : null };
}
