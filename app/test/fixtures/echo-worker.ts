// Deterministic transport fixture, not an AEC algorithm. Used to prove raw durability/cleaned sealing.
import { parentPort, workerData } from 'node:worker_threads';
if (!parentPort) throw new Error('Fixture needs a worker.');
const port = parentPort;
if (workerData.leadMs === 299) throw new Error('Fictional WASM load failure.');
if (workerData.leadMs === 298) { port.on('message', () => {}); /* No replies: main-thread deadline must win. */ }
else port.on('message', (message: { kind: string; id: string; pcm: Float32Array }) => {
  if (message.kind === 'microphone') {
    const pcm = message.pcm.map(value => value / 2);
    port.postMessage({ kind: 'audio', id: message.id, pcm, missingSamples: 0, computeMs: 1 });
  } else if (message.kind === 'finish') port.close();
});
