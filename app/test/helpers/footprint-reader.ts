// The calculation guard's footprint reader (native/footprint.swift), compiled once per source version into the temp
// folder, as the desktop build compiles it into the app. null when swiftc is missing: the reader tests then skip.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOOTPRINT_SOURCE = fileURLToPath(new URL('../../native/footprint.swift', import.meta.url));
let built: Promise<string | null> | null = null;
export function footprintReaderBinary(): Promise<string | null> {
  built ??= (async () => {
    if (!existsSync('/usr/bin/swiftc')) return null;
    const hash = createHash('sha256').update(readFileSync(FOOTPRINT_SOURCE)).digest('hex').slice(0, 12);
    const folder = join(tmpdir(), 'hearalong-test-footprint'), bin = join(folder, `footprint-${hash}`);
    if (existsSync(bin)) return bin;
    await mkdir(folder, { recursive: true });
    const partial = `${bin}.${randomUUID()}.tmp`, cache = `${partial}.cache`;
    try {
      await new Promise<void>((resolve, reject) => execFile('/usr/bin/swiftc', ['-O', '-module-cache-path', cache, '-o', partial, FOOTPRINT_SOURCE], { timeout: 240_000 },
        error => error ? reject(error) : resolve()));
      await rename(partial, bin); // atomic: a parallel test file either finds the finished binary or builds its own copy
    } finally { await rm(cache, { recursive: true, force: true }); await rm(partial, { force: true }); }
    return bin;
  })();
  return built;
}
