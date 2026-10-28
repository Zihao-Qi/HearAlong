/** Sample time anchored in the capture thread, never in the upload queue. AudioContext time stops during sleep. */
export class SampleCaptureClock {
  at(sample, rate, wallMs) {
    const audioMs = sample * 1000 / rate;
    // Re-anchor small capture pauses too; the server alone applies the >5 s gap threshold. Ignore render jitter.
    if (this.origin === undefined || Math.abs(wallMs - (this.origin + audioMs)) > 100) this.origin = wallMs - audioMs;
    return this.origin + audioMs;
  }
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
