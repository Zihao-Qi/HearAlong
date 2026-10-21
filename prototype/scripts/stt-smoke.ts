import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { discoverModel } from '../src/config.ts';
import { runBinary, probeDuration, decodeChunk } from '../src/audio.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import type { Chunk } from '../src/store.ts';

const config = await discoverModel();
if (!config.available || !config.path) throw new Error(config.error ?? 'Model unavailable.');
const directory = resolve('artifacts');
await mkdir(directory, { recursive: true });
const audio = resolve(directory, 'synthetic-meeting.aiff');
const wav = resolve(directory, 'synthetic-meeting.wav');
const reference = 'The workshop has thirty-six lanterns ready for the evening parade. Please check the repair cafe intake limit for Saturday.';
// Synthetic speech is written to a file; this never records or plays the microphone.
await runBinary('say', ['-v', 'Samantha', '-o', audio, reference]);
await runBinary(process.env.MEETING_FFMPEG ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', audio, '-ar', '16000', '-ac', '1', wav]);
const seconds = await probeDuration(audio);
const recognizer = new LocalRecognizer(config.path);
try {
  const start = performance.now();
  const job: Chunk = { id: randomUUID(), meetingId: 'smoke', source: 'synthetic', sequence: 0, path: audio,
    decodeStart: 0, startMs: 0, seconds, sampleRate: null, status: 'queued', text: '', error: null, metrics: null, hash: 'synthetic' };
  const first = await recognizer.transcribe(job);
  const coldMs = performance.now() - start;
  const warm = await recognizer.transcribe({ ...job, id: randomUUID() });
  assert.match(first.text.toLowerCase(), /lanterns/);
  assert.match(first.text.toLowerCase(), /parade/);
  // Separately verify the real streaming API, without mixing it with a claimed live UI feature.
  const { TranscribeModel, setLogHandler } = await import('transcribe-cpp');
  setLogHandler(() => {});
  await recognizer.close(); // Gracefully free the subprocess model before the streaming probe.
  assert.equal(recognizer.lastExit?.code, 0, 'The STT child must shut down cleanly.');
  const model = await TranscribeModel.load(config.path);
  let streaming: unknown = { supported: model.capabilities.supportsStreaming };
  try {
    if (model.capabilities.supportsStreaming) {
      const pcm = await decodeChunk(audio, 0, seconds);
      const session = model.createSession();
      try {
        const stream = await session.stream({ language: 'en', timestamps: 'auto', commitPolicy: 'stable_prefix' });
        try {
          for (let offset = 0; offset < pcm.length; offset += 16_000) await stream.feed(pcm.slice(offset, offset + 16_000));
          await stream.finalize();
          assert.match(stream.snapshot.text.toLowerCase(), /lanterns/);
          streaming = { supported: true, text: stream.snapshot.text, capabilities: model.capabilities };
        } finally { stream.reset(); }
      } finally { session.dispose(); }
    }
  } finally { model.dispose(); }
  const report = { input: 'Synthetic Samantha voice, not a real meeting or microphone recording', reference, seconds,
    first, warm, coldMs, subprocessExit: recognizer.lastExit, warmRealTimeFactor: warm.computeMs / 1000 / seconds, streaming,
    limitation: 'Short synthetic clip only. No real meeting accuracy, battery, or one-hour endurance claim.' };
  await writeFile(resolve(directory, 'stt-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await recognizer.close(); }
