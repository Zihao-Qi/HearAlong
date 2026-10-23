import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

type CachedFile = { size: number; mtime: number; hash: string };
export type FingerprintOptions = { read?: (path: string) => Promise<Buffer>; log?: (message: string) => void };

/** Content identity of what a restart loads. Metadata only avoids rereading unchanged files; it is not the identity. */
export class CodeFingerprint {
  private files = new Map<string, CachedFile>();
  private startup = '';
  private current = '';
  private checkedAt = 0;
  private pending?: Promise<void>;
  private root: string;
  private publicRoot: string;
  private clock: () => number;
  private read: (path: string) => Promise<Buffer>;
  private log: (message: string) => void;
  private warned = new Set<string>();
  private constructor(root: string, publicRoot: string, clock: () => number, options: FingerprintOptions) {
    this.root = root; this.publicRoot = publicRoot; this.clock = clock;
    this.read = options.read ?? readFile; this.log = options.log ?? console.warn;
  }

  static async start(root: string, publicRoot = join(root, 'public'), clock = Date.now, options: FingerprintOptions = {}) {
    const fingerprint = new CodeFingerprint(root, publicRoot, clock, options);
    await fingerprint.scan();
    fingerprint.startup = fingerprint.current;
    fingerprint.checkedAt = clock();
    return fingerprint;
  }

  ready() {
    // Status never waits for disk. One background pass, no more often than every 30 seconds (including failed passes).
    if (!this.pending && this.clock() - this.checkedAt >= 30_000) {
      this.checkedAt = this.clock();
      this.pending = this.scan().catch(error => this.warn(this.root, error)).finally(() => { this.pending = undefined; });
    }
    return this.current !== this.startup;
  }

  private warn(path: string, error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || this.warned.has(path)) return;
    this.warned.add(path);
    this.log(`Update fingerprint: ignoring unreadable ${path}: ${(error as Error).message}`);
  }

  private async scan() {
    const paths: [string, string][] = [];
    const walk = async (directory: string, prefix: string) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { this.warn(directory, error); return; }
      for (const entry of entries) {
        const path = join(directory, entry.name), key = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(path, key);
        else if (entry.isFile()) paths.push([key, path]);
      }
    };
    await walk(join(this.root, 'src'), 'src');
    await walk(this.publicRoot, 'public');
    for (const name of ['package.json', 'package-lock.json']) paths.push([name, join(this.root, name)]);
    const next = new Map<string, CachedFile>();
    const digest = createHash('sha256');
    for (const [key, path] of paths.sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const info = await stat(path), previous = this.files.get(key);
        // Permission changes need not alter size/mtime. Check readability even when the content hash can be reused.
        await access(path, constants.R_OK);
        const file = previous && previous.size === info.size && previous.mtime === info.mtimeMs ? previous
          : { size: info.size, mtime: info.mtimeMs, hash: createHash('sha256').update(await this.read(path)).digest('hex') };
        next.set(key, file);
        digest.update(JSON.stringify([key, file.hash]));
      } catch (error) {
        // Missing or unreadable files count as absent; neither startup nor status depends on every file being readable.
        this.warn(path, error);
      }
    }
    this.files = next;
    this.current = digest.digest('hex');
  }
}
