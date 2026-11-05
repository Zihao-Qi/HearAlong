// Offline only. No MeetingStore, network, device access, playback, or product integration.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { CHUNK_SECONDS, SAMPLE_RATE } from '../src/audio.ts';
import { discoverModel } from '../src/config.ts';
import { LocalRecognizer, type Recognition } from '../src/recognizer.ts';

export const AEC_VERSION = '@ennuicastr/webrtcaec3.js@0.3.0';
const FRAME = SAMPLE_RATE / 100;
let modulePromise: ReturnType<typeof WebRtcAec3> | undefined;
export type Range = { start: number; end: number };
export type TrialOptions = { micStartMs: number; callStartMs: number; extraDelayMs?: number; echoOnly?: Range[] };

export async function readF32(path: string): Promise<Float32Array> {
  const size = (await stat(path)).size;
  if (!size || size % 4 || size > SAMPLE_RATE * 4 * 8 * 3600) throw new Error('Expected nonempty mono f32le, at most 8 hours, with no partial sample.');
  const bytes = await readFile(path);
  const pcm = new Float32Array(bytes.length / 4);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(pcm[i]) || Math.abs(pcm[i]) > 1) throw new Error('PCM must contain finite samples in [-1, 1].');
  }
  return pcm;
}

export function f32Bytes(pcm: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(pcm.length * 4);
  for (let i = 0; i < pcm.length; i++) bytes.writeFloatLE(pcm[i], i * 4);
  return bytes;
}

export function power(pcm: Float32Array, start = 0, end = pcm.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += pcm[i] ** 2;
  return sum / Math.max(1, end - start);
}
const db = (value: number): number | null => value > 0 ? 10 * Math.log10(value) : null;

export function alignedCall(call: Float32Array, length: number, options: TrialOptions): Float32Array {
  for (const value of [options.micStartMs, options.callStartMs, options.extraDelayMs ?? 0]) {
    if (!Number.isFinite(value)) throw new Error('Start times and delay must be finite milliseconds.');
  }
  const offset = Math.round((options.micStartMs - options.callStartMs - (options.extraDelayMs ?? 0)) * SAMPLE_RATE / 1000);
  const out = new Float32Array(length);
  const first = Math.max(0, -offset), last = Math.min(length, call.length - offset);
  if (last > first) out.set(call.subarray(first + offset, last + offset), first);
  return out;
}

/** Diagnostic only, NOT an AEC3 metric. Positive lag means the microphone trails the reference.
 * Average to 1 kHz, correlate the first 30 s, search -1000..1000 ms. Does not change alignment.
 */
export function estimateDelay(mic: Float32Array, call: Float32Array) {
  const count = Math.floor(Math.min(mic.length, call.length, 30 * SAMPLE_RATE) / 16);
  const x = new Float64Array(count), y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 16; j++) { x[i] += mic[i * 16 + j] / 16; y[i] += call[i * 16 + j] / 16; }
  }
  let best = 0, lagMs: number | null = null;
  for (let lag = -1000; lag <= 1000; lag++) {
    const first = Math.max(0, lag), last = Math.min(count, count + lag);
    if (last - first < 1000) continue;
    let xy = 0, xx = 0, yy = 0;
    for (let i = first; i < last; i++) { xy += x[i] * y[i - lag]; xx += x[i] ** 2; yy += y[i - lag] ** 2; }
    const correlation = xx && yy ? Math.abs(xy / Math.sqrt(xx * yy)) : 0;
    if (correlation > best) { best = correlation; lagMs = lag; }
  }
  return { lagMs: best >= 0.1 ? lagMs : null, correlation: best, method: 'independent 1-kHz waveform cross-correlation, first 30 s; not AEC3 telemetry' };
}

/** Exactly one analyze/render then process/capture per 10 ms. Never batch the whole render first.
 * The supported internal rate is 48 kHz; the package resamples 16 -> 48 -> 16 kHz.
 * Pad only the final frame, then trim, preserving the input sample count and meeting start time.
 */
export async function cancelEcho(mic: Float32Array, call: Float32Array, options: TrialOptions) {
  const reference = alignedCall(call, mic.length, options);
  const module = await (modulePromise ??= WebRtcAec3());
  const started = performance.now();
  const aec = new module.AEC3(48_000, 1, 1);
  const cleaned = new Float32Array(mic.length);
  const input = new Float32Array(FRAME), render = new Float32Array(FRAME), output = new Float32Array(FRAME);
  const processOptions = { sampleRateIn: SAMPLE_RATE, sampleRateOut: SAMPLE_RATE };
  try {
    for (let pos = 0; pos < mic.length; pos += FRAME) {
      input.fill(0); render.fill(0);
      input.set(mic.subarray(pos, pos + FRAME)); render.set(reference.subarray(pos, pos + FRAME));
      aec.analyze([render], { sampleRateIn: SAMPLE_RATE });
      if (aec.processSize([input], processOptions) !== FRAME) throw new Error('Unexpected AEC frame size.');
      aec.process([output], [input], processOptions);
      cleaned.set(output.subarray(0, Math.min(FRAME, mic.length - pos)), pos);
    }
  } finally { aec.free(); }
  const computeSeconds = (performance.now() - started) / 1000;
  if (!cleaned.every(Number.isFinite)) throw new Error('AEC returned nonfinite samples.');
  return { cleaned, computeSeconds, realTimeFactor: computeSeconds / (mic.length / SAMPLE_RATE) };
}

export function energySummary(mic: Float32Array, cleaned: Float32Array, call: Float32Array, options: TrialOptions) {
  const reference = alignedCall(call, mic.length, options);
  return Array.from({ length: Math.ceil(mic.length / SAMPLE_RATE) }, (_, second) => {
    const start = second * SAMPLE_RATE, end = Math.min(mic.length, start + SAMPLE_RATE);
    const before = power(mic, start, end), after = power(cleaned, start, end), far = power(reference, start, end);
    const reductionDb = before > 0 && after > 0 ? 10 * Math.log10(before / after) : null;
    // ERLE is only meaningful when the caller KNOWS no near-end speech is present.
    const echoOnly = (options.echoOnly ?? []).some(range => range.start <= second && range.end >= end / SAMPLE_RATE);
    return { second, beforePower: before, afterPower: after, referencePower: far,
      beforeDbfs: db(before), afterDbfs: db(after), energyReductionDb: reductionDb,
      erleDb: echoOnly && before > 1e-7 && far > 1e-7 ? reductionDb : null };
  });
}

/** Exclusive new output directory. Existing directories (including symlinks) are rejected.
 * Only fixed child names, exclusive writes, and no product store or default output path.
 */
export async function newOutputDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  const parent = await realpath(dirname(requested)); // Parent must already exist.
  const directory = join(parent, basename(requested));
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

export type Transcript = { text: string; words: { text: string; startMs: number; endMs: number }[]; chunks: (Recognition & { startMs: number })[] };
/** Same 20-s chunks and isolated/recovering worker as the app; no database or text echo rule. */
export async function transcribeF32(recognizer: LocalRecognizer, path: string, samples: number, meetingStartMs = 0): Promise<Transcript> {
  const chunks: Transcript['chunks'] = [];
  for (let sequence = 0, start = 0; start < samples; sequence++, start += CHUNK_SECONDS * SAMPLE_RATE) {
    const seconds = Math.min(CHUNK_SECONDS, (samples - start) / SAMPLE_RATE), startMs = meetingStartMs + start / SAMPLE_RATE * 1000;
    const result = await recognizer.transcribe({ id: `trial-${sequence}`, meetingId: 'offline-aec-trial', source: 'microphone', sequence,
      path, decodeStart: start / SAMPLE_RATE, startMs, seconds, sampleRate: SAMPLE_RATE, status: 'queued', text: '', error: null,
      metrics: null, hash: '', attempts: 0, retryAt: null });
    chunks.push({ ...result, startMs });
  }
  return { text: chunks.map(chunk => chunk.text).filter(Boolean).join(' '),
    words: chunks.flatMap(chunk => chunk.words.map(word => ({ text: word.text, startMs: chunk.startMs + word.t0Ms, endMs: chunk.startMs + word.t1Ms }))), chunks };
}

export async function trialModel() {
  // Never fall through to ~/.pi settings. Pass an explicit public/local model path via the environment.
  const path = process.env.MEETING_MODEL_PATH;
  if (!path) throw new Error('Recognition requires MEETING_MODEL_PATH (no settings/cache discovery is performed).');
  const config = await discoverModel(path);
  if (!config.available || !config.path) throw new Error(config.error ?? 'Model unavailable.');
  return config.path;
}

export function parseRanges(value: string | undefined): Range[] {
  if (value === undefined) return [];
  return value.split(',').map(part => {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(part);
    if (!match || Number(match[2]) <= Number(match[1])) throw new Error('Echo-only ranges must be start:end seconds, separated by commas.');
    return { start: Number(match[1]), end: Number(match[2]) };
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    mic: { type: 'string' }, call: { type: 'string' }, out: { type: 'string' },
    'mic-start-ms': { type: 'string' }, 'call-start-ms': { type: 'string' },
    'extra-delay-ms': { type: 'string', default: '0' }, 'echo-only': { type: 'string' },
    recognize: { type: 'boolean', default: false }, sweep: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('aec-trial.ts --mic mic.f32 --call call.f32 --mic-start-ms N --call-start-ms N --out NEW_DIR [--recognize] [--sweep] [--extra-delay-ms 0..300] [--echo-only 0:20,80:100]');
    return;
  }
  if (!values.mic || !values.call || !values.out || values['mic-start-ms'] === undefined || values['call-start-ms'] === undefined) throw new Error('Required: --mic --call --mic-start-ms --call-start-ms --out. See --help.');
  const options: TrialOptions = { micStartMs: Number(values['mic-start-ms']), callStartMs: Number(values['call-start-ms']),
    extraDelayMs: Number(values['extra-delay-ms']), echoOnly: parseRanges(values['echo-only']) };
  if (![options.micStartMs, options.callStartMs].every(value => Number.isFinite(value) && value >= 0)
    || !Number.isFinite(options.extraDelayMs) || options.extraDelayMs! < 0 || options.extraDelayMs! > 300) throw new Error('Start times must be nonnegative finite milliseconds; extra delay must be 0..300 ms.');
  const model = values.recognize ? await trialModel() : undefined;
  const micPath = await realpath(values.mic), callPath = await realpath(values.call);
  const mic = await readF32(micPath), call = await readF32(callPath);
  const directory = await newOutputDirectory(values.out);
  // Confine temporary files/native runtime caches for the optional worker to this output.
  await mkdir(join(directory, 'runtime'), { mode: 0o700 });
  process.env.TMPDIR = join(directory, 'runtime'); process.env.XDG_CACHE_HOME = join(directory, 'runtime');
  const diagnosticDelay = estimateDelay(mic, alignedCall(call, mic.length, { ...options, extraDelayMs: 0 }));
  const result = await cancelEcho(mic, call, options);
  await writeFile(join(directory, 'cleaned.f32'), f32Bytes(result.cleaned), { flag: 'wx', mode: 0o600 });
  const perSecond = energySummary(mic, result.cleaned, call, options);
  const sweep = [];
  if (values.sweep) {
    for (let delayMs = 0; delayMs <= 300; delayMs += 20) {
      const sweptOptions = { ...options, extraDelayMs: delayMs };
      const swept = await cancelEcho(mic, call, sweptOptions);
      const energy = energySummary(mic, swept.cleaned, call, sweptOptions);
      sweep.push({ extraDelayMs: delayMs, computeSeconds: swept.computeSeconds, realTimeFactor: swept.realTimeFactor, perSecond: energy });
    }
  }
  const summary = { library: AEC_VERSION, sampleRate: SAMPLE_RATE, internalSampleRate: 48_000, samples: mic.length, durationSeconds: mic.length / SAMPLE_RATE,
    alignment: options, aec3EstimatedDelayMs: null, aec3DelayNote: 'The pinned package exports no delay getter; its internal estimator runs but cannot be observed.',
    diagnosticDelay, computeSeconds: result.computeSeconds, realTimeFactor: result.realTimeFactor,
    timingNote: 'AEC-only wall time includes construction, frame copies, internal resampling and free; excludes WASM load, alignment, diagnostics, I/O and recognition. Output has the same sample count; filter latency is not compensated.',
    erleNote: 'ERLE reported only in caller-labeled --echo-only intervals with non-negligible reference/mic power; otherwise null. Other reduction is NOT ERLE.', perSecond, sweep };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  if (model) {
    const recognizer = new LocalRecognizer(model);
    try {
      for (const [name, path] of [['original', micPath], ['cleaned', join(directory, 'cleaned.f32')]]) {
        const transcript = await transcribeF32(recognizer, path, mic.length, options.micStartMs);
        await writeFile(join(directory, `${name}-transcript.json`), JSON.stringify(transcript, null, 2), { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ variant: name, text: transcript.text, words: transcript.words }, null, 2));
      }
    } finally { await recognizer.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
