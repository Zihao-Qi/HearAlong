// Download the SC set into the local bench layout. Resumable: a file whose SHA-256 is already in the manifest is skipped.
// This module plans the transfer. Do not run it from tests; the measurement pass runs `npm run bench:fetch` itself.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOTATIONS_URL, MICS, SC_MEETINGS, audioUrl, benchPaths, type AudioMic, type Mic } from './ami.ts';

export type PlannedFile = {
  id: string;
  kind: 'annotations' | 'audio';
  meetingId: string | null;
  mic: AudioMic | null;
  url: string;
  dest: string;
};

export type ManifestEntry = { url: string; bytes: number; sha256: string };
export type Manifest = { version: 1; files: Record<string, ManifestEntry> };

export type LocalFile = { exists: boolean; bytes: number; sha256: string | null };

/**
 * What to do with one planned file. `skip` and `adopt` both leave the bytes in place (`adopt` still records the hash).
 * `download` fetches again, including when the recorded hash does not match.
 */
export function downloadAction(local: LocalFile, recorded: Pick<ManifestEntry, 'bytes' | 'sha256'> | undefined): 'skip' | 'adopt' | 'download' {
  if (!local.exists || local.bytes <= 0 || local.sha256 === null) return 'download';
  if (!recorded) return 'adopt';
  if (recorded.bytes === local.bytes && recorded.sha256 === local.sha256) return 'skip';
  return 'download';
}

/** The annotations zip plus both microphone files for every SC meeting. Paths stay under `root`. */
export function planFetches(root?: string, selection?: Mic | 'Headset'): PlannedFile[] {
  const paths = benchPaths(root);
  const zip: PlannedFile = { id: 'annotations', kind: 'annotations', meetingId: null, mic: null, url: ANNOTATIONS_URL, dest: paths.zip };
  const mics: readonly AudioMic[] = selection === 'Headset' ? ['Headset-0', 'Headset-1', 'Headset-2', 'Headset-3'] : selection ? [selection] : MICS;
  const audio = SC_MEETINGS.flatMap(meetingId => mics.map((mic): PlannedFile => ({
    id: `${meetingId}:${mic}`, kind: 'audio', meetingId, mic, url: audioUrl(meetingId, mic), dest: paths.wav(meetingId, mic),
  })));
  return [zip, ...audio];
}

/**
 * Basename to write under `annotations/words`, or null when the zip entry is not a words XML file.
 * The entry must live in a `words` directory. `..`, absolute paths, and names that are not `*.words.xml` are refused.
 */
export function wordsOutputName(entry: string): string | null {
  const trimmed = entry.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!trimmed || entry.endsWith('/') || entry.endsWith('\\')) return null;
  const parts = trimmed.split('/');
  if (parts.some(part => part === '' || part === '..' || part === '.')) return null;
  if (!parts.includes('words')) return null;
  const base = parts[parts.length - 1];
  if (!base || base.startsWith('-') || !base.toLowerCase().endsWith('.words.xml')) return null;
  return base;
}

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function loadManifest(path: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') return { version: 1, files: parsed.files };
  } catch { /* a missing or unreadable manifest is an empty one */ }
  return { version: 1, files: {} };
}

async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function manifestKey(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

async function localFile(path: string): Promise<LocalFile> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) return { exists: false, bytes: 0, sha256: null };
    return { exists: true, bytes: info.size, sha256: await sha256(path) };
  } catch {
    return { exists: false, bytes: 0, sha256: null };
  }
}

async function fetchTo(url: string, dest: string, attempt = 1): Promise<void> {
  const partial = `${dest}.partial`;
  let have = 0;
  try { have = (await stat(partial)).size; } catch { have = 0; }
  const headers = new Headers();
  if (have > 0) headers.set('Range', `bytes=${have}-`);
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (response.status === 416 && attempt === 1) {
    await rm(partial, { force: true });
    return fetchTo(url, dest, 2);
  }
  if (response.status !== 200 && response.status !== 206) throw new Error(`Download failed (${response.status}) for ${url}`);
  const append = response.status === 206 && have > 0;
  await mkdir(dirname(dest), { recursive: true });
  const file = await open(partial, append ? 'a' : 'w', 0o600);
  try {
    if (!response.body) throw new Error(`Empty response for ${url}`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await file.write(value);
    }
    await file.sync();
  } finally { await file.close(); }
  await rename(partial, dest);
}

function unzipList(zip: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-Z', '-1', zip], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Cannot list ${zip}: ${error.message}`));
      else resolve(stdout.split('\n').map(line => line.trim()).filter(Boolean));
    });
  });
}

function unzipEntry(zip: string, entry: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-p', zip, entry], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(new Error(`Cannot extract ${entry}: ${error.message}`));
      else resolve(stdout);
    });
  });
}

/** Extract only `words/*.words.xml` into `annotations/words`, one basename each. Other annotation types stay in the zip. */
export async function extractWords(zip: string, wordsDir: string): Promise<number> {
  await mkdir(wordsDir, { recursive: true });
  let written = 0;
  for (const entry of await unzipList(zip)) {
    const base = wordsOutputName(entry);
    if (!base) continue;
    const dest = `${wordsDir}/${base}`;
    const info = await stat(dest).catch(() => null);
    if (info?.isFile() && info.size > 0) continue;
    await writeFile(dest, await unzipEntry(zip, entry), { mode: 0o644 });
    written++;
  }
  return written;
}

export async function runFetch(root?: string, selection?: Mic | 'Headset'): Promise<void> {
  const paths = benchPaths(root);
  const manifest = await loadManifest(paths.manifest);
  const planned = planFetches(root, selection);
  // Bounded concurrent transfers: the corpus mirror can be slow per connection. Serialize manifest writes per batch.
  for (let offset = 0; offset < planned.length; offset += 8) {
    const completed = await Promise.all(planned.slice(offset, offset + 8).map(async item => {
      const key = manifestKey(paths.ami, item.dest);
      const present = await localFile(item.dest);
      const action = downloadAction(present, manifest.files[key]);
      if (action === 'download') {
        console.log(`fetch ${item.url}`);
        await fetchTo(item.url, item.dest);
      } else console.log(`${action} ${item.dest}`);
      const saved = action === 'download' ? await localFile(item.dest) : present;
      if (!saved.sha256) throw new Error(`Missing file after download: ${item.dest}`);
      return { key, entry: { url: item.url, bytes: saved.bytes, sha256: saved.sha256 } };
    }));
    for (const { key, entry } of completed) manifest.files[key] = entry;
    await saveManifest(paths.manifest, manifest);
  }
  const count = await extractWords(paths.zip, paths.words);
  console.log(`words extracted or already present under ${paths.words} (${count} written)`);
  if (selection === 'Headset') {
    for (const entry of await unzipList(paths.zip)) {
      const parts = entry.split('/');
      if (parts.some(part => !part || part === '..' || part === '.')) continue;
      const base = parts.at(-1)!;
      const subdir = parts.includes('segments') && /^[A-Za-z0-9]+\.[A-D]\.segments\.xml$/.test(base) ? 'segments'
        : parts.includes('corpusResources') && base === 'meetings.xml' ? 'corpusResources' : null;
      if (!subdir) continue;
      const dest = resolve(paths.annotations, subdir, base);
      if ((await stat(dest).catch(() => null))?.size) continue;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await unzipEntry(paths.zip, entry), { mode: 0o644 });
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run bench:fetch -- [--mic Headset|Mix-Headset|Array1-01]');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--mic' || !['Headset', ...MICS].includes(args[1]))) throw new Error('Usage: npm run bench:fetch -- [--mic Headset|Mix-Headset|Array1-01]');
  await runFetch(undefined, args[1] as Mic | 'Headset' | undefined);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
