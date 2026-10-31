import { TranscribeModel, setLogHandler } from 'transcribe-cpp';
import { decodeChunk, readRecordingChunk, SAMPLE_RATE } from './audio.ts';
import { transcribeRecovering } from './recovery.ts';

setLogHandler(() => {});
let stopping = false;
let busy = false;
let model: TranscribeModel | undefined;
let controller: AbortController | undefined;
let disconnectTimer: NodeJS.Timeout | undefined;
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
async function shutdown() {
  if (busy) return;
  model?.dispose();
  model = undefined;
  // dispose() queues native frees. Let those drain before disconnect/exit.
  await new Promise<void>(resolve => setImmediate(resolve));
  clearTimeout(disconnectTimer);
  if (process.connected) process.disconnect();
}
async function handleMessage(job: any) {
  if (job.kind === 'shutdown') {
    stopping = true;
    controller?.abort();
    await shutdown();
    return;
  }
  if (job.kind !== 'transcribe' || stopping || !model) return;
  if (busy) { send({ kind: 'error', id: job.id, error: 'Native recognizer is busy.' }); return; }
  busy = true;
  controller = new AbortController();
  try {
    const decodeStart = performance.now();
    if (job.sampleRate && job.sampleRate !== SAMPLE_RATE) throw new Error('Recorded audio must be 16 kHz mono.');
    const pcm = job.sampleRate
      ? await readRecordingChunk(job.path, job.decodeStart, job.seconds, controller.signal)
      : await decodeChunk(job.path, job.decodeStart, job.seconds, undefined, controller.signal);
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
    send({ kind: 'result', id: job.id, result: {
      text: result.text, backend: model.backend, computeMs: performance.now() - start, decodeMs,
      audioSeconds: pcm.length / model.capabilities.nativeSampleRate, processRssBytes: process.memoryUsage().rss,
      words: result.words, segments: result.segments, timestampKind, retries: result.retries, recoveredBy: result.recoveredBy,
    } });
  } catch (error) {
    send({ kind: 'error', id: job.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
    controller = undefined;
    if (stopping) await shutdown();
  }
}
const fail = (error: unknown) => { console.error(`Speech worker failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); };
process.on('message', (job: any) => {
  // IPC cannot await listeners; handleMessage reports recognition failures and drains shutdown itself.
  handleMessage(job).catch(fail);
});
process.on('disconnect', () => {
  disconnectTimer = setTimeout(() => {
    console.error('Speech worker disconnect drain exceeded 10 s.');
    process.exit(1);
  }, 10_000);
  stopping = true; controller?.abort();
  // The parent has gone; idle shutdown runs now, or the active job's finally drains it.
  shutdown().catch(fail);
});
model = await TranscribeModel.load(process.argv[2]);
if (stopping) await shutdown();
else send({ kind: 'ready', backend: model.backend, capabilities: model.capabilities });
