/** Sample time anchored in the capture thread, never in the upload queue. AudioContext time stops during sleep. */
export class SampleCaptureClock {
  at(sample, rate, wallMs, frameBoundary = true) {
    const audioMs = sample * 1000 / rate;
    // Only a pause between CONSECUTIVE quanta can step the clock. Accumulated oscillator
    // drift crossing 100 ms is not a pause. UTC adjustments can step in either direction.
    const excess = this.lastWall === undefined ? 0 : wallMs - this.lastWall - (sample - this.lastSample) * 1000 / rate;
    if (this.origin === undefined || Math.abs(excess) >= 100) {
      this.origin = wallMs - audioMs;
      this.lastSlewSample = sample;
    }
    this.lastWall = wallMs; this.lastSample = sample;
    return frameBoundary ? this.frame(sample, rate, wallMs) : this.time(sample, rate);
  }
  frame(sample, rate, wallMs) {
    const drift = wallMs - this.time(sample, rate);
    const budget = Math.min(2, Math.max(0, sample - this.lastSlewSample) * 2 / rate);
    // A small deadband ignores millisecond Date.now/render jitter; a frame never slews >2 ms.
    if (Math.abs(drift) > 5) this.origin += Math.max(-budget, Math.min(budget, drift));
    this.lastSlewSample = sample;
    return this.time(sample, rate);
  }
  time(sample, rate) { return this.origin + sample * 1000 / rate; }
}

/** Page-observed suspension is evidence for a cause, not evidence that audio is missing. */
export class CaptureSuspension {
  constructor(now) { this.lastTick = now; this.interval = null; }
  tick(now, resumed = false) {
    if (resumed && now - this.lastTick <= 5000 && this.interval?.toWallMs === this.lastTick) {
      // A timer/worklet message may observe wake just before the resume event. Keep the beginning of that sleep.
      this.interval = { ...this.interval, toWallMs: now };
    } else if (resumed || now - this.lastTick > 5000) this.interval = { fromWallMs: this.lastTick, toWallMs: now };
    this.lastTick = now;
  }
}
