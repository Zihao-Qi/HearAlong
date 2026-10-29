// Headless transcription of one media file through the same store, queue, and STT subprocess the server uses.
// Usage: node --experimental-strip-types scripts/transcribe-file.ts <media> [outputDir]
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverModel } from '../src/config.ts';
import { probeDuration } from '../src/audio.ts';
import { MeetingStore } from '../src/store.ts';
import { JobManager } from '../src/jobs.ts';
import { LocalRecognizer, type Recognition } from '../src/recognizer.ts';

export type FileTranscript = {
  directory: string;
  meetingId: string;
  /** Final segment text, in time order, joined by spaces. */
  text: string;
  modelPath: string;
  summary: {
    media: string; durationSeconds: number; chunkCount: number;
    failed: { sequence: number; status: string; error: string | null }[];
    wallSeconds: number; computeSeconds: number; decodeSeconds: number;
    realTimeFactor: number; peakWorkerRssMiB: number;
    backend: string | undefined; timestampKind: string | undefined; wordCount: number;
    emptyChunks: number; recovered: { sequence: number; by: Recognition['recoveredBy'] }[];
  };
};

/** Transcribe `media` into `directory` (created). Same queue and recognizer as the command-line tool. */
export async function transcribeMedia(mediaPath: string, directory: string): Promise<FileTranscript> {
  const media = resolve(mediaPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = await discoverModel();
  if (!config.available || !config.path) throw new Error(config.error ?? 'Model unavailable.');
  const store = new MeetingStore(directory);
  const recognizer = new LocalRecognizer(config.path);
  const jobs = new JobManager(store, recognizer);
  const started = performance.now();
  let progress: ReturnType<typeof setInterval> | undefined;
  try {
    const duration = await probeDuration(media);
    const meeting = store.createMeeting(basename(media));
    store.addMedia(meeting.id, media, duration); // Reads the original in place; nothing is written next to it.
    const total = store.chunks(meeting.id).length;
    console.log(`${basename(media)}: ${(duration / 60).toFixed(1)} min, ${total} chunks → ${directory}`);
    progress = setInterval(() => {
      const done = store.chunks(meeting.id).filter(c => c.status === 'completed' || c.status === 'failed').length;
      console.log(`${done}/${total} chunks · ${((performance.now() - started) / 1000).toFixed(0)}s elapsed`);
    }, 30_000);
    jobs.kick();
    await jobs.wait();
    clearInterval(progress);

    const chunks = store.chunks(meeting.id);
    const metrics = chunks.map(c => (c.metrics ? JSON.parse(c.metrics) : null) as Recognition | null);
    const words = chunks.flatMap((c, i) => (metrics[i]?.words ?? []).map(w => ({
      chunk: c.sequence, startMs: Math.round(c.startMs + w.t0Ms), endMs: Math.round(c.startMs + w.t1Ms), text: w.text,
    })));
    const recovered = chunks.flatMap((c, i) => metrics[i]?.recoveredBy ? [{ sequence: c.sequence, by: metrics[i]!.recoveredBy }] : []);
    const computeMs = metrics.reduce((sum, m) => sum + (m?.computeMs ?? 0), 0);
    const decodeMs = metrics.reduce((sum, m) => sum + (m?.decodeMs ?? 0), 0);
    const summary = {
      media, durationSeconds: duration, chunkCount: chunks.length,
      failed: chunks.filter(c => c.status !== 'completed').map(c => ({ sequence: c.sequence, status: c.status, error: c.error })),
      wallSeconds: (performance.now() - started) / 1000, computeSeconds: computeMs / 1000, decodeSeconds: decodeMs / 1000,
      realTimeFactor: computeMs / 1000 / duration, peakWorkerRssMiB: Math.max(0, ...metrics.map(m => (m?.processRssBytes ?? 0) / 2 ** 20)),
      backend: metrics.find(Boolean)?.backend, timestampKind: metrics.find(Boolean)?.timestampKind, wordCount: words.length,
      emptyChunks: chunks.filter(c => c.status === 'completed' && !c.text.trim()).length, recovered,
    };
    const text = store.segments(meeting.id).map(segment => segment.text.trim()).filter(Boolean).join(' ');
    await writeFile(resolve(directory, 'transcript.md'), store.markdown(meeting.id));
    await writeFile(resolve(directory, 'transcript.json'), JSON.stringify({
      summary, chunks: chunks.map(c => ({ sequence: c.sequence, startMs: c.startMs, seconds: c.seconds, status: c.status, text: c.text })), words,
    }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    return { directory, meetingId: meeting.id, text, modelPath: config.path, summary };
  } finally {
    if (progress) clearInterval(progress);
    try { await jobs.close(); }
    finally { store.close(); }
  }
}

async function main(): Promise<void> {
  const [input, output = 'data/transcripts'] = process.argv.slice(2);
  if (!input) throw new Error('Usage: transcribe-file.ts <media> [outputDir]');
  const media = resolve(input);
  const directory = resolve(output, basename(media).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-'));
  await transcribeMedia(media, directory);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
