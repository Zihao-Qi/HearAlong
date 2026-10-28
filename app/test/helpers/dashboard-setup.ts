// Existing dashboard checks start after onboarding. Seed that state without bypassing the production redirect.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { model } from './gguf.ts';
import type { SetupOptions } from '../../src/setup/service.ts';
export async function dashboardSetup(directory: string, speechStandIn = false): Promise<SetupOptions> {
  const path = join(directory, 'settings.json');
  const settings = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
  if (speechStandIn) settings.speechModelPath = await model(join(directory, 'example-speech.gguf'), { name: 'Example dashboard speech' });
  await writeFile(path, JSON.stringify({ ...settings, setupSeen: true }));
  return {
    scan: { home: join(directory, 'empty-home'), envModelPath: null, hfHome: null },
    ffmpeg: async () => ({ found: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
  };
}
