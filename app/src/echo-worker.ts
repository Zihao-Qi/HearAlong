// AEC, latency buffering and reference waiting run only in this owned worker.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { EchoProcessor, type TimedAudio, type EchoOutput } from './echo-timeline.ts';
import { EchoScheduler } from './echo-scheduler.ts';

if (!parentPort) throw new Error('AEC requires a worker thread.');
const port = parentPort, module = await WebRtcAec3();
const processor = new EchoProcessor(module, workerData.leadMs ?? 0);
if (workerData.selfTest) {
  const pcm = new Float32Array(160); pcm[159] = 0.5;
  processor.reference({ pcm: new Float32Array(1600), timing: { captureWallMs: 1000 } });
  processor.push('smoke', { pcm, timing: { captureWallMs: 1000 } }); processor.flush();
  const result = processor.takeReady()[0];
  port.postMessage({ kind: 'self-test', wasmPath: createRequire(import.meta.url).resolve('@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm'),
    samples: result.pcm.length, finite: result.pcm.every(Number.isFinite), delaySamples: processor.delaySamples, tail: result.pcm[159] });
  processor.close(); port.close();
} else {
  type Message = (TimedAudio & { kind: 'microphone'; id: string; receivedAt: number }) | (TimedAudio & { kind: 'reference' })
    | { kind: 'switch'; audio: TimedAudio[] } | { kind: 'reference-ended' } | { kind: 'flush' | 'finish'; request?: number; fadeToRaw?: boolean };
  const scheduler = new EchoScheduler(processor, workerData.waitMs);
  let timer: NodeJS.Timeout | undefined, computeMs = 0;
  const emit = (results: EchoOutput[]) => {
    const samples = results.reduce((sum, result) => sum + result.pcm.length, 0);
    for (const result of results) port.postMessage({ kind: 'audio', ...result, computeMs: computeMs * result.pcm.length / samples }, [result.pcm.buffer]);
    if (results.length) computeMs = 0;
  };
  const drain = (force = false, fadeToRaw = false) => {
    clearTimeout(timer);
    const start = performance.now(), results = scheduler.drain(Date.now(), force, fadeToRaw);
    computeMs += performance.now() - start; emit(results);
    if (Number.isFinite(scheduler.deadline)) timer = setTimeout(() => drain(), Math.max(1, scheduler.deadline - Date.now()));
  };
  port.on('message', (message: Message) => {
    if (message.kind === 'reference') scheduler.reference(message);
    else if (message.kind === 'microphone') scheduler.admit(message.id, message, message.receivedAt);
    else if (message.kind === 'reference-ended') scheduler.referenceEnded();
    else if (message.kind === 'switch') {
      const start = performance.now(), results = scheduler.switchReference(message.audio, Date.now());
      computeMs += performance.now() - start; emit(results);
    } else {
      drain(true, message.fadeToRaw);
      if (message.request !== undefined) port.postMessage({ kind: 'flushed', request: message.request });
      if (message.kind === 'finish') { clearTimeout(timer); processor.close(); port.close(); return; }
    }
    drain();
  });
  port.postMessage({ kind: 'ready', delaySamples: processor.delaySamples });
}
