// Deterministic virtual-arrival benchmark for reference uploads 600 ms after their audio frame ends.
// No recognition, devices, playback or network. Fractions distinguish render coverage from echo removal.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { EchoProcessor } from '../../src/echo-timeline.ts';
import { EchoScheduler } from '../../src/echo-scheduler.ts';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('Usage: aec-steady.ts --out NEW_DIR');
await mkdir(values.out, { mode: 0o700 });
const module = await WebRtcAec3(), rows = [];
for (const phaseMs of [0, 300, 800]) {
  const seconds = 30, base = 100000, source = new Float32Array((seconds + 3) * 16000);
  let seed = 17, low = 0;
  for (let i = 0; i < source.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; low += 0.6 * ((seed / 2 ** 32 - 0.5) * 0.3 - low); source[i] = low; }
  const mic = new Float32Array(seconds * 16000);
  for (let i = 0; i < mic.length; i++) mic[i] = (source[i - 1120] ?? 0) * 0.4 + (source[i - 1504] ?? 0) * 0.1;
  const processor = new EchoProcessor(module, 100), scheduler = new EchoScheduler(processor, 1500);
  const events: { at: number; kind: 'reference' | 'mic'; index: number }[] = [];
  for (let index = 0; index < seconds; index++) {
    events.push({ at: index * 1000 + 1020, kind: 'mic', index });
    events.push({ at: phaseMs + index * 1000 + 1600, kind: 'reference', index });
  }
  events.sort((a, b) => a.at - b.at);
  let cursor = 0, samples = 0, missing = 0, steadySamples = 0, suppressed = 0, beforePower = 0, afterPower = 0;
  try {
    while (cursor < events.length || Number.isFinite(scheduler.deadline)) {
      const now = Math.min(events[cursor]?.at ?? Infinity, scheduler.deadline);
      while (events[cursor]?.at === now) {
        const event = events[cursor++], first = event.index * 16000;
        if (event.kind === 'reference') scheduler.reference({ pcm: source.slice(first + phaseMs * 16, first + phaseMs * 16 + 16000), timing: { captureWallMs: base + phaseMs + event.index * 1000 } });
        else scheduler.admit(String(event.index), { pcm: mic.subarray(first, first + 16000), timing: { captureWallMs: base + event.index * 1000 } }, now);
      }
      for (const result of scheduler.drain(now)) {
        samples += result.pcm.length; missing += result.missingSamples;
        const first = Number(result.id) * 16000;
        if (first < 5 * 16000) continue; // Exclude the five-second convergence warm-up.
        for (let pos = 0; pos < result.pcm.length; pos += 160) {
          let before = 0, after = 0;
          for (let i = pos; i < pos + 160; i++) { before += mic[first + i] ** 2; after += result.pcm[i] ** 2; }
          steadySamples += 160; beforePower += before; afterPower += after;
          if (after < before / 4) suppressed += 160;
        }
      }
    }
    rows.push({ referenceDelayMs: 600, phaseMs, seconds, samples, referenceCoveredFraction: 1 - missing / samples,
      steadySamples, cleanedFraction6Db: suppressed / steadySamples, steadyEchoReductionDb: 10 * Math.log10(beforePower / afterPower) });
  } finally { processor.close(); }
}
await writeFile(join(values.out, 'results.json'), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
