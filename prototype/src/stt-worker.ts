import { TranscribeModel, setLogHandler } from 'transcribe-cpp';
import { decodeChunk } from './audio.ts';
import { transcribeRecovering } from './recovery.ts';

setLogHandler(() => {});
let stopping = false;
let busy = false;
let model: TranscribeModel | undefined;
let controller: AbortController | undefined;
async function shutdown() {
  if (busy) return;
  model?.dispose();
  model = undefined;
  // dispose() queues native frees. Let those drain before disconnect/exit.
  await new Promise<void>(resolve => setImmediate(resolve));
  if (process.connected) process.disconnect();
}
process.on('message', async (job: any) => {
  if (job.kind === 'shutdown') {
    stopping = true;
    controller?.abort();
    await shutdown();
    return;
  }
  if (job.kind !== 'transcribe' || stopping || !model) return;
  if (busy) { process.send?.({ kind: 'error', id: job.id, error: 'Native recognizer is busy.' }); return; }
  busy = true;
  controller = new AbortController();
  try {
    const decodeStart = performance.now();
    const pcm = await decodeChunk(job.path, job.decodeStart, job.seconds, job.sampleRate);
    const decodeMs = performance.now() - decodeStart;
    const start = performance.now();
    const loaded = model;
    const signal = controller.signal;
    let timestampKind = 'none';
    const result = await transcribeRecovering(pcm, async part => {
      const pass = await loaded.transcribe(part, { language: 'en', timestamps: 'auto', signal });
      if (pass.aborted || pass.truncated) throw new Error('The recognizer returned incomplete audio processing.');
      timestampKind = pass.timestampKind;
      return { text: pass.text.trim(), words: pass.words.map(w => ({ text: w.text, t0Ms: w.t0Ms, t1Ms: w.t1Ms })),
        segments: pass.segments.map(s => ({ text: s.text, t0Ms: s.t0Ms, t1Ms: s.t1Ms })) };
    });
    process.send?.({ kind: 'result', id: job.id, result: {
      text: result.text, backend: model.backend, computeMs: performance.now() - start, decodeMs,
      audioSeconds: pcm.length / model.capabilities.nativeSampleRate, processRssBytes: process.memoryUsage().rss,
      words: result.words, segments: result.segments, timestampKind, retries: result.retries, recoveredBy: result.recoveredBy,
    } });
  } catch (error) {
    process.send?.({ kind: 'error', id: job.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
    controller = undefined;
    if (stopping) await shutdown();
  }
});
process.on('disconnect', () => { stopping = true; controller?.abort(); void shutdown(); });
model = await TranscribeModel.load(process.argv[2]);
if (stopping) await shutdown();
else process.send?.({ kind: 'ready', backend: model.backend, capabilities: model.capabilities });
