import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readGguf, type GgufMetadata } from './gguf.ts';
import { byDeadline, readSmallFile, ScanTimeout } from './deadline.ts';

export const SPEECH_FAMILIES = ['whisper', 'parakeet', 'parakeet_buffered', 'moonshine', 'voxtral'] as const;
export type SpeechFamily = typeof SPEECH_FAMILIES[number];
export type ModelFile = { path: string; fileType: string; bytes: number; source: string };
export type SpeechModel = { id: string; name: string; family: SpeechFamily; streaming: boolean; sources: string[]; files: ModelFile[]; chosenFile: ModelFile };
export type ModelConfig = { available: boolean; path: string | null; source: string; bytes?: number; error: string | null; name?: string; streaming?: boolean };
export type ScanResult = { models: SpeechModel[]; truncated: boolean; config: ModelConfig; missingPath?: string };
export type ScanOptions = { directory: string; home?: string; envModelPath?: string | null; savedPath?: string | null; hfHome?: string | null; maxFiles?: number; maxScanMs?: number };
export function isSpeechFamily(family: string): family is SpeechFamily { return (SPEECH_FAMILIES as readonly string[]).includes(family); }
export function folderLabel(path: string, home = homedir()) {
  const folder = dirname(resolve(path));
  return folder === home ? '~' : folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}
export function chooseFile(files: ModelFile[]) {
  const q8 = files.find(f => f.fileType === 'Q8_0');
  const f16 = files.find(f => f.fileType === 'F16');
  if (q8 || f16) return (q8 ?? f16)!;
  // Without a Q8 variant, F32/BF16 are not a smaller quantization. Prefer the largest quantized file.
  return files.filter(f => /^(Q[1-6]_|IQ|TQ|MXFP4|NVFP4)/.test(f.fileType)).sort((a, b) => b.bytes - a.bytes)[0] ?? files[0];
}

/** One cache per server, including rejected headers; replaced files invalidate by size and mtime. */
export class SpeechModels {
  private cache = new Map<string, { size: number; mtime: number; header: GgufMetadata | null }>();
  async inspect(path: string, deadline = Infinity) {
    const canonical = await byDeadline(realpath(resolve(path)), deadline);
    const info = await byDeadline(stat(canonical), deadline);
    if (!info.isFile()) throw new Error('The selected path is not a file.');
    const cached = this.cache.get(canonical);
    let header = cached?.size === info.size && cached.mtime === info.mtimeMs ? cached.header : undefined;
    if (header === undefined) {
      try { header = await readGguf(path, deadline); }
      catch (error) {
        // A timeout is not a property of this file and must not poison the cache.
        if (error instanceof ScanTimeout || performance.now() >= deadline) throw error;
        this.cache.set(canonical, { size: info.size, mtime: info.mtimeMs, header: null });
        throw error;
      }
      this.cache.set(canonical, { size: info.size, mtime: info.mtimeMs, header });
    }
    if (!header) throw new Error('The file does not have a readable GGUF header.');
    if (!isSpeechFamily(header.architecture)) throw new Error(`Unsupported architecture ${header.architecture || '(not specified)'}.`);
    return { canonical, bytes: info.size, header, family: header.architecture };
  }
  async scan(options: ScanOptions): Promise<ScanResult> {
    const home = options.home ?? homedir();
    const explicit = options.envModelPath === undefined ? process.env.MEETING_MODEL_PATH : options.envModelPath;
    const hfHome = options.hfHome === undefined ? process.env.HF_HOME : options.hfHome;
    const deadline = performance.now() + (options.maxScanMs ?? 2000);
    const maxFiles = options.maxFiles ?? 500;
    const models: SpeechModel[] = [];
    const entries = new Map<string, SpeechModel>();
    const visited = new Set<string>();
    const paths = new Map<string, { file: ModelFile; model: SpeechModel }>();
    let count = 0, truncated = false;
    const stop = () => {
      if (performance.now() >= deadline) truncated = true;
      return truncated;
    };
    const add = async (path: string, source: string) => {
      if (stop()) return;
      try {
        const canonical = await byDeadline(realpath(resolve(path)), deadline);
        if (visited.has(canonical)) { const previous = paths.get(canonical); if (previous) paths.set(resolve(path), previous); return; }
        if (count >= maxFiles) { truncated = true; return; }
        count++;
        visited.add(canonical);
        const info = await this.inspect(path, deadline);
        const key = `${info.family}\0${info.header.name}`;
        const file: ModelFile = { path: canonical, bytes: info.bytes, fileType: info.header.fileType, source };
        let model = entries.get(key);
        if (!model) {
          model = { id: createHash('sha256').update(key).digest('hex').slice(0, 16), family: info.family,
            name: info.header.name, streaming: info.header.streaming, sources: [], files: [], chosenFile: file };
          models.push(model); entries.set(key, model);
        }
        model.files.push(file);
        if (!model.sources.includes(source)) model.sources.push(source);
        model.chosenFile = chooseFile(model.files);
        model.streaming = this.cache.get(model.chosenFile.path)!.header!.streaming;
        paths.set(resolve(path), { file, model }); paths.set(canonical, { file, model });
      } catch (error) {
        if (error instanceof ScanTimeout) truncated = true;
        // Missing, unreadable and non-speech files do not belong in the chooser.
      }
      stop();
    };
    // Iterate only the documented directory levels; never recurse into unrelated folders.
    const children = async function* (folder: string) {
      if (stop()) return;
      let dir;
      try { dir = await byDeadline(opendir(folder), deadline, dir => dir.close()); }
      catch (error) { if (error instanceof ScanTimeout) truncated = true; return; }
      try {
        while (!stop()) {
          const entry = await byDeadline(dir.read(), deadline);
          if (!entry) break;
          yield { name: entry.name, path: join(folder, entry.name) };
        }
      } catch (error) { if (error instanceof ScanTimeout) truncated = true; }
      finally { await byDeadline(dir.close(), deadline).catch(() => {}); }
    };
    if (explicit) await add(explicit, 'MEETING_MODEL_PATH');
    if (!explicit && options.savedPath) await add(options.savedPath, folderLabel(options.savedPath, home));
    if (!stop()) {
      try {
        const text = await readSmallFile(join(home, '.pi/agent/pi-voice.json'), 1024 * 1024, deadline);
        const voice = text === null ? null : JSON.parse(text);
        if (typeof voice?.model?.path === 'string' && voice.model.path) await add(voice.model.path, 'Pi Voice');
      } catch (error) { if (error instanceof ScanTimeout) truncated = true; /* Pi Voice is optional and read only. */ }
    }
    for await (const file of children(join(options.directory, 'models'))) {
      if (/\.gguf$/i.test(file.name)) await add(file.path, 'downloaded');
      if (stop()) break;
    }
    const hub = hfHome ? join(hfHome, 'hub') : join(home, '.cache/huggingface/hub');
    outer: for await (const repo of children(hub)) {
      if (!repo.name.startsWith('models--')) continue;
      for await (const snapshot of children(join(repo.path, 'snapshots'))) {
        for await (const file of children(snapshot.path)) {
          if (/\.gguf$/i.test(file.name)) await add(file.path, 'Hugging Face cache');
          if (stop()) break outer;
        }
      }
    }
    const selected = (path: string | null | undefined) => path ? paths.get(resolve(path)) : undefined;
    const env = selected(explicit), saved = explicit ? undefined : selected(options.savedPath);
    const missingPath = explicit ? (!env ? resolve(explicit) : undefined) : options.savedPath && !saved ? resolve(options.savedPath) : undefined;
    const automatic = models.find(m => m.streaming && m.family === 'parakeet') ?? models.find(m => m.streaming) ?? models[0];
    const chosen = env ?? saved ?? (automatic ? { model: automatic, file: automatic.chosenFile } : undefined);
    let config: ModelConfig;
    if (explicit && !env) config = { available: false, path: resolve(explicit), source: 'MEETING_MODEL_PATH', error: `The selected speech model is missing or unreadable: ${resolve(explicit)}` };
    else if (chosen) config = { available: true, path: chosen.file.path, source: chosen.file.source, bytes: chosen.file.bytes,
      error: null, name: chosen.model.name, streaming: this.cache.get(chosen.file.path)!.header!.streaming };
    else config = { available: false, path: null, source: '', error: 'No local speech model was found.' };
    return { models, truncated, config, ...(missingPath ? { missingPath } : {}) };
  }
}
