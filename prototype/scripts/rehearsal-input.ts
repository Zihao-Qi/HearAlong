import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Refuse aliases before the server can open any file in a saved run, including SQLite sidecars and audio. */
export async function validateRunFiles(folder: string): Promise<void> {
  for (const name of await readdir(folder)) {
    const path = join(folder, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`A rehearsal run must not contain symlinks: ${path}`);
    if (info.isFile() && info.nlink > 1) throw new Error(`A rehearsal run must not contain hard-linked files: ${path}`);
    if (info.isDirectory()) await validateRunFiles(path);
  }
}

export type RehearsalArgs = {
  mic?: string; them?: string; open?: string; from: number; minutes?: number; withModels: boolean; headless: boolean;
};
const USAGE = 'Usage: npm run rehearse -- <mic.wav> [--from M:SS] [--minutes N] [--them them.wav] [--with-models]\n       npm run rehearse -- --open <run folder>';

export function parseArgs(args: string[]): RehearsalArgs {
  const result: RehearsalArgs = { from: 0, withModels: false, headless: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (result.mic) throw new Error(USAGE);
      result.mic = arg;
      continue;
    }
    if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
    seen.add(arg);
    if (arg === '--with-models') result.withModels = true;
    else if (arg === '--headless') result.headless = true; // Test-only; never changes the visible default.
    else if (['--from', '--minutes', '--them', '--open'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      if (arg === '--from') {
        if (!/^\d+:[0-5]\d$/.test(value)) throw new Error('--from must be M:SS.');
        const [minutes, seconds] = value.split(':').map(Number);
        result.from = minutes * 60 + seconds;
        if (!Number.isSafeInteger(result.from)) throw new Error('--from is too large.');
      } else if (arg === '--minutes') {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error('--minutes must be a positive number.');
        result.minutes = Number(value);
      } else if (arg === '--them') result.them = value;
      else result.open = value;
    } else throw new Error(`Unknown option: ${arg}\n${USAGE}`);
  }
  if (result.open ? result.mic || result.them || seen.has('--from') || result.minutes !== undefined : !result.mic) throw new Error(USAGE);
  return result;
}

export function clock(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Parse RIFF chunks, not a fixed 44-byte header (recorders often include metadata). */
export function parseWav(bytes: Buffer) {
  const invalid = () => new Error('Expected a valid, uncompressed WAV file.');
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length) throw invalid();
  let fmt: Buffer | undefined, data: Buffer | undefined;
  for (let at = 12; at + 8 <= end;) {
    const size = bytes.readUInt32LE(at + 4), start = at + 8;
    if (start + size > end) throw invalid();
    const name = bytes.toString('ascii', at, at + 4);
    if (name === 'fmt ') fmt = bytes.subarray(start, start + size);
    if (name === 'data') data = bytes.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (!fmt || fmt.length < 16 || !data?.length) throw invalid();
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2), sampleRate = fmt.readUInt32LE(4), blockAlign = fmt.readUInt16LE(12), bits = fmt.readUInt16LE(14);
  let validBits = bits;
  if (format === 0xfffe) {
    if (fmt.length < 40 || fmt.readUInt16LE(16) < 22 || fmt.readUInt16LE(16) > fmt.length - 18
      || fmt.subarray(26, 40).toString('hex') !== '000000001000800000aa00389b71') throw invalid();
    format = fmt.readUInt16LE(24);
    validBits = fmt.readUInt16LE(18);
  }
  if (!channels || !sampleRate || !((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits)))
    || validBits < 1 || validBits > bits || (format === 3 && validBits !== bits)
    || blockAlign !== channels * bits / 8 || fmt.readUInt32LE(8) !== sampleRate * blockAlign || data.length % blockAlign) throw invalid();
  return { fmt, data, format, channels, bits, validBits, sampleRate, blockAlign, samples: data.length / blockAlign, seconds: data.length / blockAlign / sampleRate };
}

export function trimWav(bytes: Buffer, from = 0, minutes?: number) {
  const wav = parseWav(bytes);
  if (!Number.isFinite(from) || from < 0 || (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0))) throw new Error('Invalid WAV trim interval.');
  const start = Math.floor(from * wav.sampleRate);
  if (start >= wav.samples) throw new Error(`--from ${clock(from)} is beyond the end (${clock(wav.seconds)}).`);
  const count = Math.min(wav.samples - start, minutes === undefined ? wav.samples : Math.floor(minutes * 60 * wav.sampleRate));
  if (count < 1) throw new Error('The requested WAV interval is shorter than one sample.');
  // Chrome's fake capture cannot read every otherwise-valid WAV (notably PCM24 and padded extensible PCM).
  // Always emit plain PCM16 mono, retaining the input rate and frame count. No resampling or browser-specific formats.
  const output = Buffer.alloc(44 + count * 2);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(wav.sampleRate, 24); output.writeUInt32LE(wav.sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(count * 2, 40);
  const bytesPerSample = wav.bits / 8, padding = 2 ** (wav.bits - wav.validBits), scale = 2 ** (wav.validBits - 1);
  for (let frame = 0; frame < count; frame++) {
    let mixed = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      const at = (start + frame) * wav.blockAlign + channel * bytesPerSample;
      let sample: number;
      if (wav.format === 3) {
        sample = wav.bits === 32 ? wav.data.readFloatLE(at) : wav.data.readDoubleLE(at);
        if (!Number.isFinite(sample)) throw new Error('WAV contains a non-finite audio sample.');
      } else {
        const raw = wav.bits === 8 ? wav.data.readUInt8(at) - 128 : wav.data.readIntLE(at, bytesPerSample);
        // Extensible PCM stores its valid bits left-aligned in the container; discard unused low bits.
        sample = Math.floor(raw / padding) / scale;
      }
      mixed += sample / wav.channels;
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed * 32768))), 44 + frame * 2);
  }
  return { bytes: output, seconds: count / wav.sampleRate, sampleRate: wav.sampleRate, samples: count };
}

export async function loadWav(path: string, from: number, minutes?: number) {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch { throw new Error(`Cannot read WAV: ${path}`); }
  try { return trimWav(bytes, from, minutes); }
  catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
}

export async function writeTrimmed(path: string, wav: ReturnType<typeof trimWav>) {
  await writeFile(path, wav.bytes, { mode: 0o600 });
}
