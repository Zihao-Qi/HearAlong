// Outside memory edits are untrusted input, not permission to follow links elsewhere in the account.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MEMORY_FILE_BYTES = 1024 * 1024;
const unsafe = (file: string) => new Error(`Memory file refused (${file}): use a regular, single-link file of at most ${MEMORY_FILE_BYTES} bytes, without symlinked folders.`);
const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;

/** Check the memory root and every descendant component, including missing output paths before mkdir/write. */
export async function memoryPath(folder: string, file: string): Promise<string> {
  const root = resolve(folder), target = resolve(root, file);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw unsafe(file);
  // Canonicalize the trusted parent (repo/app-owned project folder), never the untrusted memory root itself.
  const parent = await realpath(dirname(root)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return dirname(root);
    throw error;
  });
  let current = join(parent, basename(root));
  const parts = rel ? rel.split(sep) : [];
  for (let i = 0; i <= parts.length; i++) {
    const info = await lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (info && (info.isSymbolicLink() || ((i < parts.length || !rel) && !info.isDirectory()))) throw unsafe(file);
    if (i < parts.length) current = join(current, parts[i]);
  }
  return current;
}

/** O_NOFOLLOW protects the leaf; inode and parent rechecks protect a parent swapped during admission. No bytes read first. */
export async function readMemoryFile(folder: string, file: string): Promise<string | null> {
  const path = await memoryPath(folder, file);
  const before = await lstat(path, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MEMORY_FILE_BYTES)) throw unsafe(file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    const checked = await memoryPath(folder, file);
    const now = await lstat(checked, { bigint: true });
    if (checked !== path || !same(before, opened) || !same(opened, now) || !opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MEMORY_FILE_BYTES) || now.isSymbolicLink()) throw unsafe(file);
    // A file growing during the read cannot turn this into an unbounded allocation/read.
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (used > MEMORY_FILE_BYTES || after.size > opened.size || after.nlink !== 1n) throw unsafe(file);
    return bytes.subarray(0, used).toString('utf8');
  } finally { await handle.close(); }
}
