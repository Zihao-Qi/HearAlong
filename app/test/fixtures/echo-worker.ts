// Deterministic transport fixture, not an AEC algorithm. Used to prove raw durability/cleaned sealing.
import { parentPort, workerData } from 'node:worker_threads';
if (!parentPort) throw new Error('Fixture needs a worker.');
const port = parentPort;
let reference = 0, seen = false;
if (workerData.leadMs === 299) throw new Error('Fictional WASM load failure.');
if (workerData.leadMs === 298) { port.on('message', () => {}); /* No replies: main-thread deadline must win. */ }
else port.on('message', (message: { kind: string; id: string; pcm: Float32Array; request?: number; audio?: { pcm: Float32Array }[] }) => {
  if (message.kind === 'microphone') {
    if (workerData.leadMs === 296 && message.id === 'stall') return;
    if (workerData.leadMs === 295 && seen) throw new Error('Fictional mid-recording crash.');
    seen = true;
    const pcm = workerData.leadMs === 295 ? new Float32Array(message.pcm.length) : message.pcm.map(value => workerData.leadMs === 297 ? value + reference : value / 2);
    port.postMessage({ kind: 'audio', id: message.id, pcm, missingSamples: 0, computeMs: 1 });
  } else if (message.kind === 'reference') reference = message.pcm[0];
  else if (message.kind === 'switch') reference = message.audio!.at(-1)!.pcm[0];
  else if (message.kind === 'flush') port.postMessage({ kind: 'flushed', request: message.request });
  else if (message.kind === 'finish') port.close();
});
