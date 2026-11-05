// The only production module loading AEC WASM. Never runs on the server event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { EchoProcessor, audioEnd, type TimedAudio } from './echo-timeline.ts';

if (!parentPort) throw new Error('AEC requires a worker thread.');
const port = parentPort;
const module = await WebRtcAec3();
const processor = new EchoProcessor(module, workerData.leadMs ?? 0);
if (workerData.selfTest) {
  const pcm = new Float32Array(160);
  processor.reference({ pcm, timing: { captureWallMs: 1000 } });
  const result = processor.process({ pcm, timing: { captureWallMs: 1000 } });
  port.postMessage({ kind: 'self-test', wasmPath: createRequire(import.meta.url).resolve('@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm'),
    samples: result.pcm.length, finite: result.pcm.every(Number.isFinite) });
  processor.close(); port.close();
} else {
  type Pending = TimedAudio & { id: string; receivedAt: number };
  const pending: Pending[] = [];
  let timer: NodeJS.Timeout | undefined, finishing = false;
  const drain = () => {
    clearTimeout(timer);
    while (pending.length) {
      const next = pending[0];
      const remaining = workerData.waitMs - (Date.now() - next.receivedAt);
      if (!finishing && processor.referenceEndMs < audioEnd(next) && remaining > 0) {
        timer = setTimeout(drain, remaining); return;
      }
      pending.shift();
      const start = performance.now();
      const result = processor.process(next);
      port.postMessage({ kind: 'audio', id: next.id, pcm: result.pcm, missingSamples: result.missingSamples,
        computeMs: performance.now() - start }, [result.pcm.buffer]);
    }
    if (finishing) { processor.close(); port.close(); }
  };
  port.on('message', (message: Pending & { kind: string }) => {
    if (message.kind === 'reference') processor.reference(message);
    else if (message.kind === 'microphone') pending.push(message);
    else if (message.kind === 'finish') finishing = true;
    drain();
  });
  port.postMessage({ kind: 'ready' });
}
