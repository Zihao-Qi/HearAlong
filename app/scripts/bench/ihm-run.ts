// One AMI segment per native recognizer request, on its speaker's headset; one loaded LocalRecognizer for the run.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverModel } from '../../src/config.ts';
import { LocalRecognizer } from '../../src/recognizer.ts';
import type { Chunk } from '../../src/store.ts';
import { benchPaths, SC_MEETINGS } from './ami.ts';
import { sumScores } from './breakdown.ts';
import { planIhm } from './ihm.ts';
import { machineInfo, modelIdentity } from './machine.ts';
import { fileStamp, resultPath, type IhmFile, type WerSession } from './results.ts';
import { NORMALIZER, wer, type WerResult } from './wer.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--allow-dirty')) throw new Error('Usage: npm run bench:ihm -- [--allow-dirty]');
  const paths = benchPaths(), machine = machineInfo(args.includes('--allow-dirty'));
  const clips = planIhm(SC_MEETINGS, paths.root);
  for (const clip of clips) if (!existsSync(clip.path)) throw new Error(`Missing headset audio: ${clip.path}. Run bench:fetch -- --mic Headset.`);
  const config = await discoverModel();
  if (!config.available || !config.path) throw new Error(config.error ?? 'Model unavailable.');
  const identity = await modelIdentity(config.path);
  const started = new Date(), work = join(paths.work, 'ihm', fileStamp(started));
  await mkdir(work, { recursive: true, mode: 0o700 });
  const transcriptsFile = join(work, 'clips.jsonl');
  await writeFile(transcriptsFile, '', { flag: 'wx', mode: 0o600 });
  const recognizer = new LocalRecognizer(config.path);
  const sessions = new Map<string, WerSession>(), oldScores: WerResult[] = [];
  let error: string | null = null, completed = 0;
  const clock = performance.now();
  try {
    await recognizer.load();
    for (const [index, clip] of clips.entries()) {
      const before = performance.now();
      const job: Chunk = { id: clip.id, meetingId: clip.meetingId, source: clip.speaker, sequence: index, path: clip.path,
        decodeStart: clip.start, startMs: clip.start * 1000, seconds: clip.end - clip.start, sampleRate: null,
        status: 'queued', text: '', error: null, metrics: null, hash: '', attempts: 0, retryAt: null };
      const transcript = await recognizer.transcribe(job);
      const scored = wer(clip.reference, transcript.text), legacy = wer(clip.reference, transcript.text, 'hearalong-1');
      oldScores.push(legacy);
      const key = `${clip.meetingId}:${clip.mic}`, previous = sessions.get(key);
      sessions.set(key, { meetingId: clip.meetingId, mic: clip.mic, ...sumScores(previous ? [previous, scored] : [scored]),
        audioSeconds: (previous?.audioSeconds ?? 0) + job.seconds, wallSeconds: (previous?.wallSeconds ?? 0) + (performance.now() - before) / 1000,
        failedChunks: 0, unfinishedChunks: 0 });
      await appendFile(transcriptsFile, `${JSON.stringify({ ...clip, path: relative(paths.root, clip.path), hypothesis: transcript.text, scored, legacy, retries: transcript.retries, recoveredBy: transcript.recoveredBy })}\n`);
      completed++;
      if (completed % 100 === 0) console.log(`${completed}/${clips.length} clips · ${((performance.now() - clock) / 1000).toFixed(0)} s`);
    }
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  finally { await recognizer.close(); }
  const items = [...sessions.values()];
  const result: IhmFile = { ...machine, kind: 'ihm', normalizer: NORMALIZER, scoringCommit: machine.commit, scoringDirty: machine.dirty,
    createdAt: started.toISOString(), runLabel: 'ami-segments-own-headsets', model: identity.basename, modelIdentity: identity, error,
    condition: { sessions: [...SC_MEETINGS], mics: ['Headset'] }, sessions: items, clips: completed,
    transcriptsFile: relative(paths.root, transcriptsFile), legacyTotals: sumScores(oldScores),
    totals: { ...sumScores(items), audioSeconds: items.reduce((sum, item) => sum + item.audioSeconds, 0), wallSeconds: (performance.now() - clock) / 1000 } };
  await mkdir(paths.results, { recursive: true });
  const output = resultPath(paths.results, 'ihm', started);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(output);
  console.log(`hearalong-2 ${(result.totals.wer * 100).toFixed(2)}%; hearalong-1 ${(result.legacyTotals.wer * 100).toFixed(2)}%; ${completed}/${clips.length} clips`);
  if (error) throw new Error(error);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
