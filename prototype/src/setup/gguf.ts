import { open, stat, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import { byDeadline, ScanTimeout } from './deadline.ts';

export class GgufError extends Error {
  code: 'notGGUF' | 'truncated' | 'tooLarge' | 'invalid';
  constructor(code: GgufError['code'], message: string) { super(message); this.name = 'GgufError'; this.code = code; }
}
export type GgufMetadata = { architecture: string; name: string; fileType: string; streaming: boolean };
const LIMIT = 64 * 1024 * 1024;
// ggml's llama_ftype (not the tensor ggml_type enum).
const FILE_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 4: 'Q4_1_F16', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
  33: 'Q4_0_4_4', 34: 'Q4_0_4_8', 35: 'Q4_0_8_8', 36: 'TQ1_0', 37: 'TQ2_0',
  38: 'IQ4_NL_4_4', 39: 'IQ4_NL_4_8', 40: 'IQ4_NL_8_8', 41: 'MXFP4', 42: 'NVFP4', 43: 'Q1_0',
};
const WIDTHS: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** A bounded window, so tokenizer arrays are never retained or read as one allocation. */
class HeaderReader {
  position = 0;
  window = Buffer.alloc(0);
  start = 0;
  readonly file: FileHandle;
  readonly size: number;
  readonly deadline: number;
  constructor(file: FileHandle, size: number, deadline: number) { this.file = file; this.size = size; this.deadline = deadline; }
  bound(bytes: number) {
    if (performance.now() >= this.deadline) throw new ScanTimeout();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.position + bytes > LIMIT) throw new GgufError('tooLarge', 'GGUF header exceeds 64 MiB.');
    if (this.position + bytes > this.size) throw new GgufError('truncated', 'GGUF header is truncated.');
  }
  skip(bytes: number) { this.bound(bytes); this.position += bytes; }
  async bytes(n: number) {
    this.bound(n);
    if (this.position < this.start || this.position + n > this.start + this.window.length) {
      this.start = this.position;
      this.window = Buffer.alloc(Math.min(Math.max(64 * 1024, n), LIMIT - this.position, this.size - this.position));
      let filled = 0;
      while (filled < this.window.length) {
        const { bytesRead } = await byDeadline(this.file.read(this.window, filled, this.window.length - filled, this.start + filled), this.deadline);
        if (!bytesRead) throw new GgufError('truncated', 'GGUF header is truncated.');
        filled += bytesRead;
      }
    }
    const result = this.window.subarray(this.position - this.start, this.position - this.start + n);
    this.position += n;
    return result;
  }
  async u32() { return (await this.bytes(4)).readUInt32LE(); }
  async u64() {
    const value = (await this.bytes(8)).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new GgufError('tooLarge', 'GGUF header length is too large.');
    return Number(value);
  }
  async string(keep: boolean) {
    const length = await this.u64();
    if (!keep) { this.skip(length); return ''; }
    return (await this.bytes(length)).toString('utf8');
  }
  async value(type: number, keep: boolean): Promise<string | number | boolean | undefined> {
    if (type === 8) return this.string(keep);
    if (type === 9) {
      const element = await this.u32(), count = await this.u64();
      if (element === 8) {
        // Even string arrays are skipped: read only each length, seek past its contents.
        for (let i = 0; i < count; i++) await this.string(false);
      } else if (WIDTHS[element]) this.skip(count * WIDTHS[element]);
      else throw new GgufError('invalid', `Unsupported GGUF array value type ${element}.`);
      return;
    }
    const width = WIDTHS[type];
    if (!width) throw new GgufError('invalid', `Unknown GGUF value type ${type}.`);
    if (!keep) { this.skip(width); return; }
    const data = await this.bytes(width);
    switch (type) {
      case 0: return data.readUInt8(); case 1: return data.readInt8();
      case 2: return data.readUInt16LE(); case 3: return data.readInt16LE();
      case 4: return data.readUInt32LE(); case 5: return data.readInt32LE();
      case 6: return data.readFloatLE(); case 7: return data[0] !== 0;
      case 10: return Number(data.readBigUInt64LE()); case 11: return Number(data.readBigInt64LE());
      case 12: return data.readDoubleLE();
    }
  }
}

export async function readGguf(path: string, deadline = Infinity): Promise<GgufMetadata> {
  const info = await byDeadline(stat(path), deadline);
  if (!info.isFile()) throw new GgufError('invalid', 'The selected model is not a regular file.');
  const file = await byDeadline(open(path, constants.O_RDONLY | constants.O_NONBLOCK), deadline, file => file.close());
  try {
    const opened = await byDeadline(file.stat(), deadline);
    if (!opened.isFile()) throw new GgufError('invalid', 'The selected model is not a regular file.');
    const reader = new HeaderReader(file, opened.size, deadline);
    if ((await reader.bytes(4)).toString('ascii') !== 'GGUF') throw new GgufError('notGGUF', 'Not a GGUF file.');
    const version = await reader.u32();
    if (version !== 2 && version !== 3) throw new GgufError('invalid', `Unsupported GGUF version ${version}; expected v2 or v3.`);
    await reader.u64(); // tensor count; weights and tensor descriptors are not needed
    const count = await reader.u64();
    const wanted = new Set(['general.architecture', 'general.name', 'general.basename', 'general.file_type', 'stt.capability.streaming']);
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      const key = await reader.string(true);
      const value = await reader.value(await reader.u32(), wanted.has(key));
      if (wanted.has(key)) metadata[key] = value;
    }
    const architecture = typeof metadata['general.architecture'] === 'string' ? metadata['general.architecture'] : '';
    const name = [metadata['general.name'], metadata['general.basename'], basename(path)].find(v => typeof v === 'string' && v) as string;
    const fileType = metadata['general.file_type'];
    return { architecture, name, fileType: typeof fileType === 'number' ? FILE_TYPES[fileType] ?? `type ${fileType}` : 'unknown',
      streaming: typeof metadata['stt.capability.streaming'] === 'boolean' ? metadata['stt.capability.streaming'] : ['parakeet', 'moonshine', 'voxtral'].includes(architecture) };
  } finally { await byDeadline(file.close(), deadline).catch(() => {}); }
}
