// Percentiles and the across-run spread the benchmark report prints. No I/O.

export type CountSummary = {
  mean: number;
  p50: number;
  p95: number;
  max: number;
  n: number;
};

export type Spread = { median: number; min: number; max: number; n: number };

/**
 * Linear interpolation between the closest ranks. `p` is 0–100.
 * One value is that value at every percentile. An empty list throws.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) throw new Error('No values.');
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error('Percentile must be between 0 and 100.');
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

/** mean, interpolated p50 and p95, max, and the count. Empty input throws. */
export function summarize(values: number[]): CountSummary {
  if (!values.length) throw new Error('No values.');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values), n: values.length };
}

/**
 * Median and the min–max spread of one number from each run.
 * Odd counts take the middle value. Even counts take the mean of the two middle values.
 */
export function medianSpread(values: number[]): Spread {
  if (!values.length) throw new Error('No runs.');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length };
}
