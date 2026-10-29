// Score each SC session and microphone through the same file-transcription path as scripts/transcribe-file.ts.
// Usage: npm run bench:wer -- [--sessions ES2004a,ES2004b] [--mic Mix-Headset] [--run-label text]
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeMedia } from '../transcribe-file.ts';
import { benchPaths, reference, referenceText } from './ami.ts';
import { parseWerArgs } from './cli.ts';
import { machineInfo } from './machine.ts';
import { fileStamp, resultPath, type WerFile, type WerSession } from './results.ts';
import { corpusWer, wer } from './wer.ts';

async function main(): Promise<void> {
  const args = parseWerArgs(process.argv.slice(2));
  const paths = benchPaths();
  const machine = machineInfo();
  const started = new Date();
  const sessions: WerSession[] = [];
  const pairs: { reference: string; hypothesis: string }[] = [];
  let model = '';
  let error: string | null = null;
  for (const meetingId of args.sessions) {
    for (const mic of args.mics) {
      const wav = paths.wav(meetingId, mic);
      if (!existsSync(wav)) {
        error = `Missing audio: ${wav}. Run npm run bench:fetch first.`;
        break;
      }
      try {
        const work = join(paths.work, 'wer', fileStamp(started), meetingId, mic);
        const transcript = await transcribeMedia(wav, work);
        const spoken = referenceText(reference(meetingId, { root: paths.root }));
        const scored = wer(spoken, transcript.text);
        model ||= basename(transcript.modelPath);
        pairs.push({ reference: spoken, hypothesis: transcript.text });
        sessions.push({
          meetingId, mic, audioSeconds: transcript.summary.durationSeconds, wallSeconds: transcript.summary.wallSeconds,
          substitutions: scored.substitutions, deletions: scored.deletions, insertions: scored.insertions, hits: scored.hits,
          referenceWords: scored.referenceWords, wer: scored.wer, failedChunks: transcript.summary.failed.length,
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        break;
      }
    }
    if (error) break;
  }
  const scored = corpusWer(pairs);
  const result: WerFile = {
    ...machine, kind: 'wer', createdAt: started.toISOString(), runLabel: args.label, model: model || 'unavailable', error,
    sessions,
    totals: {
      substitutions: scored.substitutions, deletions: scored.deletions, insertions: scored.insertions, hits: scored.hits,
      referenceWords: scored.referenceWords, wer: scored.wer,
      audioSeconds: sessions.reduce((sum, item) => sum + item.audioSeconds, 0),
      wallSeconds: sessions.reduce((sum, item) => sum + item.wallSeconds, 0),
    },
  };
  await mkdir(paths.results, { recursive: true, mode: 0o700 });
  const output = resultPath(paths.results, 'wer', started);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(output);
  if (error) throw new Error(error);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
