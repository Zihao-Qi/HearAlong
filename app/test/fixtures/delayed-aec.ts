// Deterministic DSP stand-in: a known delayed identity/gain kernel. It detects timeline loss,
// duplication and padding independently of actual echo suppression/recognizer quality.
import type { EchoModule } from '../../src/echo-timeline.ts';
export function delayedAec(delay = 165, gain = 1) {
  const counts = { constructed: 0, freed: 0, blocks: 0 };
  const module: EchoModule = { AEC3: class {
    private ring = new Float32Array(delay);
    private at = 0;
    constructor() { counts.constructed++; }
    analyze() {}
    process(output: Float32Array[], input: Float32Array[]) {
      counts.blocks++;
      for (let i = 0; i < input[0].length; i++) {
        output[0][i] = this.ring[this.at]; this.ring[this.at] = input[0][i] * gain;
        this.at = (this.at + 1) % this.ring.length;
      }
    }
    free() { counts.freed++; }
  } };
  return { module, counts };
}
