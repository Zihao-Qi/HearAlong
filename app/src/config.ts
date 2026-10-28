import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Read only the existing model selection; never change Pi's configuration. */
export async function discoverModel(explicit = process.env.MEETING_MODEL_PATH) {
  let path = explicit;
  let source = 'MEETING_MODEL_PATH';
  if (!path) {
    source = 'Pi Voice settings';
    try {
      const config = JSON.parse(await readFile(join(homedir(), '.pi/agent/pi-voice.json'), 'utf8'));
      path = config.model?.path;
    } catch {
      return { available: false, path: null, source, error: 'Select a model in Pi /voice-settings or set MEETING_MODEL_PATH.' };
    }
  }
  if (typeof path !== 'string' || !path) {
    return { available: false, path: null, source, error: 'No local model was selected.' };
  }
  path = resolve(path);
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Model path is not a file.');
    return { available: true, path, source, bytes: info.size, error: null };
  } catch {
    return { available: false, path, source, error: 'The selected model file is missing or unreadable.' };
  }
}

export function numberInRange(value: unknown, min: number, max: number, name: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return n;
}
