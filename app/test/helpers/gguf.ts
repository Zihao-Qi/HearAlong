import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
export const u64 = (value: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
export const str = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
export type Kv = [string, number, Buffer];
export function gguf(options: { family?: string; name?: string; fileType?: number; streaming?: boolean; version?: number; extra?: Kv[]; padding?: number } = {}) {
  const pairs: Kv[] = [
    ['general.architecture', 8, str(options.family ?? 'parakeet')],
    ['general.name', 8, str(options.name ?? 'Example speech')],
    ['general.file_type', 4, u32(options.fileType ?? 7)],
    ...(options.streaming === undefined ? [] : [['stt.capability.streaming', 7, Buffer.from([Number(options.streaming)])] as Kv]),
    ...(options.extra ?? []),
  ];
  return Buffer.concat([Buffer.from('GGUF'), u32(options.version ?? 3), u64(0), u64(pairs.length),
    ...pairs.flatMap(([key, type, value]) => [str(key), u32(type), value]), Buffer.alloc(options.padding ?? 0)]);
}
export async function model(path: string, options: Parameters<typeof gguf>[0] = {}) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, gguf(options)); return path;
}
