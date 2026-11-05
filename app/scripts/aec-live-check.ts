// Real-recognition, file-only browser rehearsal. Public AMI trial pairs in, fresh scratch folder out.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { runRehearsal } from './rehearse.ts';
import { newOutputDirectory, readF32, trialModel } from './aec-trial.ts';
import { MeetingStore } from '../src/store.ts';
import { normalize, wer } from './bench/wer.ts';
import type { ReferenceWord } from './bench/ami.ts';
import type { Recognition } from '../src/recognizer.ts';

function wav(pcm: Float32Array): Buffer {
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32768))), 44 + i * 2);
  return bytes;
}

type Sight = { at: number; endMs: number; text: string };
async function main() {
  const { values } = parseArgs({ options: { pairs: { type: 'string' }, out: { type: 'string' } } });
  if (!values.pairs || !values.out) throw new Error('Usage: aec-live-check.ts --pairs PUBLIC_AEC_TRIAL_PAIRS_DIR --out NEW_DIR (MEETING_MODEL_PATH required)');
  const modelPath = await trialModel(), directory = await newOutputDirectory(values.out);
  const home = join(directory, 'home'); await mkdir(home);
  process.env.HOME = home; process.env.HF_HOME = join(home, 'empty-hf'); process.env.XDG_CACHE_HOME = join(home, 'cache');
  process.env.TMPDIR = directory; process.env.MEETING_CLOUD = '0'; process.env.MEETING_TEST_NO_MODELS = '1';
  process.env.MEETING_SECURITY = '/usr/bin/false'; process.env.MEETING_PI = '/usr/bin/false';
  const rows = [];
  for (const scenario of [{ name: 'aligned-120ms', pair: 5, callDelayMs: 0, lateMs: 0 },
    { name: 'call-joins-at-4s', pair: 3, callDelayMs: 4000, lateMs: 0 },
    { name: 'reference-100ms-late', pair: 1, callDelayMs: 0, lateMs: 100 }]) {
    const input = join(resolve(values.pairs), `pair-${scenario.pair}`);
    const truth = JSON.parse(await readFile(join(input, 'result.json'), 'utf8')) as { nearReference: ReferenceWord[]; farReference: ReferenceWord[] };
    const microphone = (await readF32(join(input, 'microphone.f32'))).slice(0, 60 * 16000);
    if (scenario.callDelayMs) {
      const near = await readF32(join(input, 'near-truth.f32'));
      microphone.set(near.subarray(0, 4 * 16000)); // No unrecorded call plays before it joins.
    }
    const call = (await readF32(join(input, 'call.f32'))).slice(16000, 61 * 16000);
    const micWav = join(directory, `${scenario.name}-mic.wav`), callWav = join(directory, `${scenario.name}-call.wav`);
    await writeFile(micWav, wav(microphone)); await writeFile(callWav, wav(call));
    // Alternate ordering so the cleaned condition is not always the warm second run.
    for (const enabled of scenario.pair === 3 ? [true, false] : [false, true]) {
      const name = `${scenario.name}-${enabled ? 'aec' : 'raw'}`, out = join(directory, name);
      const sights: Sight[] = [], uploads: { source: string; startMs: number; wallMs: number }[] = [];
      console.log(`Running ${name}`);
      const beforeCpu = process.cpuUsage(), start = performance.now();
      await runRehearsal([micWav, '--them', callWav, '--minutes', '1', '--headless'], undefined, async page => {
        await page.exposeFunction('__aecSight', (sight: Sight) => sights.push(sight));
        await page.addInitScript(() => {
          const seen = new Set<string>();
          const scan = () => {
            for (const para of document.querySelectorAll('#transcript .para.me[data-kind="active"]')) {
              const text = para.querySelector('.preview-text')?.textContent?.trim() ?? '';
              const endMs = Number(para.getAttribute('data-end'));
              const key = `${para.getAttribute('data-key')}:${endMs}:${text}`;
              if (!text || !Number.isFinite(endMs) || seen.has(key)) continue;
              seen.add(key);
              (window as unknown as { __aecSight(sight: Sight): Promise<void> }).__aecSight({ at: Date.now(), endMs, text }).catch(() => {});
            }
          };
          const arm = () => new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
          if (document.documentElement) arm(); else document.addEventListener('DOMContentLoaded', arm);
        });
        await page.route('**/pcm', async route => {
          const request = route.request(), headers = request.headers(), source = headers['x-audio-source'];
          if (source?.startsWith('tab:') && scenario.lateMs) headers['x-capture-wall-ms'] = String(Number(headers['x-capture-wall-ms']) + scenario.lateMs);
          uploads.push({ source, startMs: Number(headers['x-start-ms']), wallMs: Number(headers['x-capture-wall-ms']) });
          await route.continue({ headers });
        });
      }, { modelPath, terminalTimeoutMs: 180_000, directory: out, echo: enabled ? {} : null, callDelayMs: scenario.callDelayMs });
      const cpu = process.cpuUsage(beforeCpu);
      const report = JSON.parse(await readFile(join(out, 'rehearsal.json'), 'utf8')) as { meetingId: string; reason: string; failedChunks: number; unfinishedChunks: number; errors: string[]; echo: { frames: number; samples: number; missingSamples: number; delayMs: number; maxDelayMs: number; computeMs: number; failures: number } | null };
      assert.equal(report.reason, 'audio ended'); assert.equal(report.failedChunks, 0); assert.equal(report.unfinishedChunks, 0); assert.deepEqual(report.errors, []);
      const first = uploads.find(frame => frame.source.startsWith('mic:'))!;
      assert.ok(first && Number.isFinite(first.wallMs));
      const store = new MeetingStore(out);
      try {
        const chunks = store.chunks(report.meetingId).filter(chunk => chunk.source.startsWith('mic:'));
        const words = chunks.flatMap(chunk => ((chunk.metrics ? JSON.parse(chunk.metrics) : null) as Recognition | null)?.words.map(word => ({ text: word.text, startMs: chunk.startMs + word.t0Ms, endMs: chunk.startMs + word.t1Ms })) ?? []);
        const textIn = (start: number, end: number) => words.filter(word => word.startMs >= first.startMs + start * 1000 && word.startMs < first.startMs + end * 1000).map(word => word.text).join(' ');
        const reference = truth.nearReference.filter(word => word.start >= 40 && word.start < 60).map(word => word.text).join(' ');
        const farReference = truth.farReference.filter(word => word.start >= 0 && word.start < 20).map(word => word.text).join(' ');
        // Score the actual stored final text, including recovery hallucinations whose word list may be incomplete.
        const stored = store.db.prepare("SELECT startMs,endMs,text FROM segments WHERE meetingId=? AND source LIKE 'mic:%' ORDER BY startMs,ord").all(report.meetingId) as { startMs: number; endMs: number; text: string }[];
        const storedTextIn = (start: number, end: number) => stored.filter(segment => segment.startMs >= first.startMs + start * 1000 && segment.startMs < first.startMs + end * 1000).map(segment => segment.text).join(' ');
        const storedFarText = storedTextIn(0, 20), doubleTalkText = storedTextIn(40, 60);
        const me = store.segments(report.meetingId).filter(segment => segment.source.startsWith('mic:'));
        const visibleFarText = me.filter(segment => segment.startMs >= first.startMs && segment.startMs < first.startMs + 20_000).map(segment => segment.text).join(' ');
        const farPreviews = sights.filter(sight => sight.endMs >= first.startMs && sight.endMs <= first.startMs + 20_000);
        const previewLagMs = sights.map(sight => sight.at - (first.wallMs - first.startMs + sight.endMs)).filter(value => value >= 0);
        const result = { name, scenario, enabled, model: 'explicit discoverModel selection', nearDoubleTalk: wer(reference, doubleTalkText), doubleTalkText,
          metricWordDoubleTalk: wer(reference, textIn(40, 60)), metricWordFarOnlyWords: normalize(textIn(0, 20)).length,
          storedFarOnlyWords: normalize(storedFarText).length, storedFarOnlyReferenceMatches: wer(farReference, storedFarText).hits, storedFarText,
          visibleMeFarOnlyWords: normalize(visibleFarText).length, visibleFarText,
          greyMeFarOnlyShown: farPreviews.length > 0, greyMeFarOnlyTexts: [...new Set(farPreviews.map(sight => sight.text))], greyMeSamples: sights.length,
          previewSpokenToVisibleMeanMs: previewLagMs.length ? previewLagMs.reduce((sum, value) => sum + value, 0) / previewLagMs.length : null,
          aecAddedMeanMs: report.echo?.frames ? report.echo.delayMs / report.echo.frames : 0, aecAddedMaxMs: report.echo?.maxDelayMs ?? 0,
          aecRealTimeFactor: report.echo?.samples ? report.echo.computeMs / (report.echo.samples / 16) : 0,
          echo: report.echo, processCpuSeconds: (cpu.user + cpu.system) / 1e6, wallSeconds: (performance.now() - start) / 1000,
          storedMeSegments: me, micStartMs: first.startMs, micWallMs: first.wallMs };
        rows.push(result);
        await writeFile(join(out, 'aec-result.json'), JSON.stringify(result, null, 2));
        await writeFile(join(out, 'aec-sights.json'), JSON.stringify({ sights, uploads }, null, 2));
        await writeFile(join(directory, 'results.json'), JSON.stringify(rows, null, 2));
        console.log(JSON.stringify(result, null, 2));
      } finally { store.close(); }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
