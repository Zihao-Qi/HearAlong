// Capture bounded raw PCM. Never reuse a buffer after transferring it.
// Mono comes from the node's options (channelCount 1, explicit, speakers): a stereo tab is mixed down, not cut to its left channel.
// Each frame carries the context frame of its first sample, so two sources on one context share a clock. Capture starts with the
// first real input; after that, a render quantum without input (a paused or silent track) is recorded as timed silence, so the
// source's own sample count never runs behind the clock.
import { SampleCaptureClock } from './capture-clock.js';

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate)); // 1 s frames: saved by the server before they are acknowledged
    this.used = 0;
    this.started = false;
    this.firstFrame = 0;
    this.clock = new SampleCaptureClock();
    this.captureWallMs = 0;
    this.discontinuities = [];
    this.lastCaptureEndWallMs = null;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        // Only sent when the source ends: the rest of the buffer is its last frame, and nothing is captured after it.
        this.flush();
        this.stopped = true;
        this.port.postMessage({ kind: 'flushed' });
      }
    };
  }
  flush() {
    if (!this.used) return;
    const pcm = this.buffer.slice(0, this.used);
    this.port.postMessage({ kind: 'pcm', buffer: pcm.buffer, sampleRate, frame: this.firstFrame,
      captureWallMs: this.captureWallMs, discontinuities: this.discontinuities }, [pcm.buffer]);
    this.used = 0;
    this.discontinuities = [];
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input && !this.started && !this.stopped) this.started = true;
    if (this.started && !this.stopped) {
      const length = input ? input.length : 128;
      const quantumWallMs = this.clock.at(currentFrame, sampleRate, Date.now());
      // A sleep can be entirely inside the last, partial frame. Keep its sample offset without cutting or padding PCM.
      // At a frame boundary, leave detection to the server's capture-time comparison instead.
      if (this.used && this.lastCaptureEndWallMs !== null && quantumWallMs - this.lastCaptureEndWallMs > 5000) {
        this.discontinuities.push({ offsetSamples: this.used, fromWallMs: this.lastCaptureEndWallMs, toWallMs: quantumWallMs });
      }
      for (let index = 0; index < length; index++) {
        if (this.used === 0) {
          this.firstFrame = currentFrame + index;
          this.captureWallMs = quantumWallMs + index * 1000 / sampleRate;
        }
        this.buffer[this.used++] = input ? input[index] : 0;
        if (this.used === this.buffer.length) this.flush();
      }
      this.lastCaptureEndWallMs = quantumWallMs + length * 1000 / sampleRate;
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
