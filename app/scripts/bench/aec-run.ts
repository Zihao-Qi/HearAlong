// Public AMI only; read-only corpus, new output directory. Sequential AEC and local recognition.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { benchPaths, decodeXml, reference, referenceText, type ReferenceWord } from './ami.ts';
import { planIhm } from './ihm.ts';
import { corpusWer, normalize, wer } from './wer.ts';
import { decodeChunk, SAMPLE_RATE } from '../../src/audio.ts';
import { LocalRecognizer } from '../../src/recognizer.ts';
import { AEC_VERSION, alignedCall, cancelEcho, energySummary, estimateDelay, f32Bytes, newOutputDirectory, power, transcribeF32, trialModel, type Range, type Transcript } from '../aec-trial.ts';

type Source = { meeting: string; speaker: string };
const PAIRS: { near: Source; far: Source; delayMs: number; gainDb: number }[] = [
  { near: { meeting: 'ES2004a', speaker: 'B' }, far: { meeting: 'IS1009a', speaker: 'A' }, delayMs: 30, gainDb: -6 },
  { near: { meeting: 'IS1009a', speaker: 'D' }, far: { meeting: 'TS3003a', speaker: 'A' }, delayMs: 50, gainDb: -8 },
  { near: { meeting: 'TS3003a', speaker: 'D' }, far: { meeting: 'EN2002a', speaker: 'C' }, delayMs: 70, gainDb: -9 },
  { near: { meeting: 'EN2002a', speaker: 'B' }, far: { meeting: 'ES2004b', speaker: 'D' }, delayMs: 100, gainDb: -10 },
  { near: { meeting: 'ES2004b', speaker: 'A' }, far: { meeting: 'IS1009b', speaker: 'C' }, delayMs: 120, gainDb: -12 },
];
const SECONDS = 120, BLOCK = 20, N = SECONDS * SAMPLE_RATE;
const FAR_BLOCKS = [0, 2, 3, 5], NEAR_BLOCKS = [1, 2, 4, 5];
const ECHO_ONLY: Range[] = [{ start: 0, end: 20 }, { start: 60, end: 80 }];

/** Pack complete annotated utterances into prescribed talk states. Different meetings avoid shared headset bleed.
 * No word-level gating; retain natural within-utterance pauses. 10-ms edge fades, 350-ms gaps.
 */
async function sourceAudio(source: Source, blocks: number[], root: string) {
  const allWords = reference(source.meeting, { root }).filter(word => word.speaker === source.speaker);
  const clips = planIhm([source.meeting], root).filter(clip => clip.speaker === source.speaker && clip.end - clip.start >= 1 && clip.end - clip.start <= 13
    && allWords.filter(word => word.start >= clip.start && word.end <= clip.end).length >= 4);
  const pcm = new Float32Array(N), words: ReferenceWord[] = [], provenance = [];
  const planned: { start: number; end: number; at: number; path: string }[] = [];
  for (const block of blocks) {
    let at = block * BLOCK + 0.3;
    const end = (block + 1) * BLOCK - 0.6;
    while (at < end - 1) {
      const index = clips.findIndex(clip => clip.end + 0.1 - Math.max(0, clip.start - 0.1) <= end - at);
      if (index < 0) break; // Keep longer clips for the NEXT block, rather than discarding them.
      const [clip] = clips.splice(index, 1), start = Math.max(0, clip.start - 0.1), stop = clip.end + 0.1;
      planned.push({ start, end: stop, at, path: clip.path });
      at += stop - start + 0.35;
    }
    if (at < block * BLOCK + 10) throw new Error(`Insufficient speech in block ${block}: ${source.meeting}.${source.speaker}.`);
  }
  if (planned.length < 8) throw new Error(`Insufficient utterances for ${source.meeting}.${source.speaker}.`);
  const audio = await decodeChunk(planned[0].path, 0, Math.max(...planned.map(item => item.end)));
  for (const clip of planned) {
    const first = Math.round(clip.start * SAMPLE_RATE), last = Math.round(clip.end * SAMPLE_RATE), out = Math.round(clip.at * SAMPLE_RATE);
    for (let i = 0; i < last - first; i++) pcm[out + i] = audio[first + i] * Math.min(1, i / 160, (last - first - 1 - i) / 160);
    words.push(...allWords.filter(word => word.start >= clip.start && word.end <= clip.end).map(word => ({ ...word, start: clip.at + word.start - clip.start, end: clip.at + word.end - clip.start })));
    provenance.push({ ...source, sourceStart: clip.start, sourceEnd: clip.end, outputStart: clip.at });
  }
  // Equal active-source RMS, not whole-file RMS (there are different silent talk states).
  let sum = 0, count = 0;
  for (let pos = 0; pos < N; pos += 160) {
    const p = power(pcm, pos, pos + 160);
    if (p > 1e-7) { sum += p; count++; }
  }
  const scale = 0.06 / Math.sqrt(sum / count);
  for (let i = 0; i < N; i++) pcm[i] *= scale;
  return { pcm, words, provenance, activeRms: 0.06, scale };
}

function microphone(near: Float32Array, far: Float32Array, delayMs: number, gainDb: number, seed: number) {
  const echo = new Float32Array(N), filtered = new Float32Array(N);
  // One-pole low-pass at 3 kHz, direct path + 3 decaying room reflections.
  const alpha = 1 - Math.exp(-2 * Math.PI * 3000 / SAMPLE_RATE);
  let low = 0;
  for (let i = 0; i < N; i++) { low += alpha * (far[i] - low); filtered[i] = low; }
  const delay = Math.round(delayMs / 1000 * SAMPLE_RATE);
  const reflections = [{ samples: 0, gain: 1 }, { samples: 192, gain: 0.35 }, { samples: 496, gain: -0.2 }, { samples: 944, gain: 0.1 }];
  for (let i = delay; i < N; i++) for (const tap of reflections) {
    const pos = i - delay - tap.samples;
    if (pos >= 0) echo[i] += filtered[pos] * tap.gain;
  }
  const echoScale = 10 ** (gainDb / 20) * Math.sqrt(power(near) / power(echo));
  const mic = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    echo[i] *= echoScale;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    mic[i] = near[i] + echo[i] + (seed / 2 ** 32 * 2 - 1) * Math.sqrt(3) * 10 ** (-65 / 20);
    peak = Math.max(peak, Math.abs(mic[i]), Math.abs(near[i]), Math.abs(far[i]));
  }
  // AMI has occasional high-crest-factor transients. Attenuate the whole experiment,
  // never clip/limit either voice, and preserve echo/near and noise/speech ratios.
  const commonScale = Math.min(1, 0.9 / peak);
  for (let i = 0; i < N; i++) { mic[i] *= commonScale; echo[i] *= commonScale; near[i] *= commonScale; far[i] *= commonScale; }
  return { mic, echo, room: { delayMs, gainDb, lowpassHz: 3000, reflections, echoScale, commonScale, noiseDbfs: -65 + 20 * Math.log10(commonScale) } };
}

function signalMetrics(before: Float32Array, after: Float32Array, near: Float32Array) {
  // Account for deterministic resampler/filter latency in auxiliary waveform metrics ONLY.
  // Search a near-only window, never tune on double talk or word error rate.
  let outputLatencySamples = 0, best = -Infinity;
  for (let lag = 0; lag <= 320; lag++) {
    let dot = 0;
    for (let i = 21 * SAMPLE_RATE; i < 39 * SAMPLE_RATE; i += 16) dot += after[i] * near[i - lag];
    if (dot > best) { best = dot; outputLatencySamples = lag; }
  }
  let beforeEcho = 0, afterEcho = 0, nearError = 0, nearPower = 0, dtError = 0, dtBeforeError = 0;
  // Guard state edges; retain startup adaptation in the first echo-only block.
  for (let i = SAMPLE_RATE; i < N - SAMPLE_RATE; i++) {
    const block = Math.floor(i / SAMPLE_RATE / BLOCK), secondInBlock = i / SAMPLE_RATE % BLOCK;
    if (secondInBlock < 1 || secondInBlock > 19) continue;
    if (block === 0 || block === 3) { beforeEcho += before[i] ** 2; afterEcho += after[i] ** 2; }
    if (block === 1 || block === 4) { nearError += (after[i] - near[i - outputLatencySamples]) ** 2; nearPower += near[i] ** 2; }
    if (block === 2 || block === 5) { dtError += (after[i] - near[i - outputLatencySamples]) ** 2; dtBeforeError += (before[i] - near[i]) ** 2; }
  }
  return { outputLatencyMs: outputLatencySamples / SAMPLE_RATE * 1000, echoOnlyErleDb: 10 * Math.log10(beforeEcho / afterEcho), nearOnlyErrorToSignalDb: 10 * Math.log10(nearError / nearPower), doubleTalkErrorReductionDb: 10 * Math.log10(dtBeforeError / dtError) };
}

function transcriptMetrics(transcript: Transcript, nearWords: ReferenceWord[], farWords: ReferenceWord[], micStartMs: number) {
  const text = (block: number) => transcript.chunks[block].text;
  const ref = (words: ReferenceWord[], block: number) => referenceText(words.filter(word => word.start >= block * BLOCK && word.start < (block + 1) * BLOCK));
  const farText = [0, 3].map(text).join(' '), farReference = [0, 3].map(block => ref(farWords, block)).join(' ');
  return { doubleTalk: corpusWer([2, 5].map(block => ({ reference: ref(nearWords, block), hypothesis: text(block) }))),
    nearOnly: corpusWer([1, 4].map(block => ({ reference: ref(nearWords, block), hypothesis: text(block) }))),
    farOnlyWordsLeaked: normalize(farText).length, farOnlyMatchedReferenceWords: wer(farReference, farText).hits,
    farOnlyReferenceWords: normalize(farReference).length, farOnlyText: farText,
    missingWordTimings: transcript.chunks.filter(chunk => chunk.text.trim() && !chunk.words.length).length, micStartMs };
}

async function main() {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, out: { type: 'string' }, 'signal-only': { type: 'boolean', default: false } } });
  if (!values.corpus || !values.out) throw new Error('Usage: aec-run.ts --corpus READ_ONLY_BENCH_ROOT --out NEW_DIR [--signal-only]');
  const root = benchPaths(values.corpus).root;
  const model = values['signal-only'] ? undefined : await trialModel();
  const directory = await newOutputDirectory(values.out);
  await mkdir(join(directory, 'runtime'));
  process.env.TMPDIR = join(directory, 'runtime'); process.env.XDG_CACHE_HOME = join(directory, 'runtime');
  const recognizer = model ? new LocalRecognizer(model) : undefined;
  const rows = [];
  try {
    // Sixth pair is the identical first mixture with a +500-ms reference timestamp error.
    for (let index = 0; index < 6; index++) {
      const config = PAIRS[index % 5], late = index === 5;
      const name = `pair-${index + 1}${late ? '-late-reference' : ''}`, out = join(directory, name);
      await mkdir(out);
      console.log(`${name}: preparing ${config.near.meeting}.${config.near.speaker} / ${config.far.meeting}.${config.far.speaker}`);
      const near = await sourceAudio(config.near, NEAR_BLOCKS, root), far = await sourceAudio(config.far, FAR_BLOCKS, root);
      const mixed = microphone(near.pcm, far.pcm, config.delayMs, config.gainDb, 123 + index % 5);
      // Exercise meeting-time alignment: call file begins 1 s earlier than mic file.
      const call = new Float32Array(N + SAMPLE_RATE); call.set(far.pcm, SAMPLE_RATE);
      const options = { micStartMs: 1000, callStartMs: late ? 500 : 0, extraDelayMs: 0, echoOnly: ECHO_ONLY };
      await writeFile(join(out, 'microphone.f32'), f32Bytes(mixed.mic));
      await writeFile(join(out, 'call.f32'), f32Bytes(call));
      await writeFile(join(out, 'near-truth.f32'), f32Bytes(near.pcm));
      const diagnosticDelay = estimateDelay(mixed.mic, alignedCall(call, N, options));
      const aec = await cancelEcho(mixed.mic, call, options);
      await writeFile(join(out, 'cleaned.f32'), f32Bytes(aec.cleaned));
      const baselineSignal = signalMetrics(mixed.mic, aec.cleaned, near.pcm);
      const sweep = [];
      let bestErle = -Infinity, bestDelay = 0, bestCleaned = aec.cleaned;
      // Each fresh AEC runs on the entire 120-s pair. Select by echo-only attenuation, not WER.
      for (let delay = 0; delay <= 300; delay += 20) {
        const swept = await cancelEcho(mixed.mic, call, { ...options, extraDelayMs: delay });
        const metrics = signalMetrics(mixed.mic, swept.cleaned, near.pcm);
        sweep.push({ extraDelayMs: delay, ...metrics, realTimeFactor: swept.realTimeFactor });
        if (metrics.echoOnlyErleDb > bestErle) { bestErle = metrics.echoOnlyErleDb; bestDelay = delay; bestCleaned = swept.cleaned; }
      }
      await writeFile(join(out, 'sweep-best.f32'), f32Bytes(bestCleaned));
      const perSecond = energySummary(mixed.mic, aec.cleaned, call, options);
      const row = { name, config, lateReferenceMs: late ? 500 : 0, options, diagnosticDelay, aec3EstimatedDelayMs: null,
        aec3DelayNote: 'Not exported by the pinned WASM bindings; diagnosticDelay is independent.', room: mixed.room,
        realTimeFactor: aec.realTimeFactor, computeSeconds: aec.computeSeconds, baselineSignal, sweep, bestDelayMs: bestDelay,
        provenance: { near: near.provenance, far: far.provenance }, nearReference: near.words, farReference: far.words, perSecond,
        recognition: {} as Record<string, ReturnType<typeof transcriptMetrics>> };
      if (recognizer) {
        // Single worker, no overlapping heavy jobs; alternate before/after ordering between pairs.
        const variants = index % 2 ? ['cleaned', 'microphone', 'sweep-best'] : ['microphone', 'cleaned', 'sweep-best'];
        for (const variant of variants) {
          console.log(`${name}: recognizing ${variant}`);
          const transcript = await transcribeF32(recognizer, join(out, `${variant}.f32`), N, options.micStartMs);
          await writeFile(join(out, `${variant}-transcript.json`), JSON.stringify(transcript, null, 2));
          row.recognition[variant] = transcriptMetrics(transcript, near.words, far.words, options.micStartMs);
        }
      }
      rows.push(row);
      await writeFile(join(out, 'result.json'), JSON.stringify(row, null, 2));
      await writeFile(join(directory, 'results.json'), JSON.stringify({ library: AEC_VERSION, durationPerPair: SECONDS, rows }, null, 2));
      console.log(JSON.stringify({ name, diagnosticDelay, baselineSignal, bestDelayMs: bestDelay, realTimeFactor: aec.realTimeFactor, recognition: row.recognition }, null, 2));
    }
    // Record corpus mapping used, not the entire corpus, to support reproducibility.
    const paths = benchPaths(root);
    await writeFile(join(directory, 'mapping.xml'), decodeXml(await readFile(join(paths.annotations, 'corpusResources', 'meetings.xml'))));
  } finally { await recognizer?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error); process.exitCode = 1; });
}
