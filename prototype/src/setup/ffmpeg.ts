import { join } from 'node:path';
import { runBinary } from '../audio.ts';

export type FfmpegResult = { found: boolean; ffmpeg?: string; ffprobe?: string; error?: string };
export async function checkFfmpeg(options: {
  env?: NodeJS.ProcessEnv; fallbackFolders?: string[];
  run?: (command: string, args: string[]) => Promise<unknown>;
} = {}): Promise<FfmpegResult> {
  const env = options.env ?? process.env;
  const run = options.run ?? ((command, args) => runBinary(command, args, { timeoutMs: 5000 }));
  const folders = options.fallbackFolders ?? ['/opt/homebrew/bin', '/usr/local/bin'];
  const find = async (command: string) => {
    try { await run(command, ['-version']); return command; }
    catch (error) {
      // Only a bare name absent from PATH permits fallback; an explicit broken override stays broken.
      if (command.includes('/') || (error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      for (const folder of folders) {
        const path = join(folder, command);
        try { await run(path, ['-version']); return path; } catch { /* next conventional location */ }
      }
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([find(env.MEETING_FFMPEG ?? 'ffmpeg'), find(env.MEETING_FFPROBE ?? 'ffprobe')]);
  return { found: Boolean(ffmpeg && ffprobe), ...(ffmpeg ? { ffmpeg } : {}), ...(ffprobe ? { ffprobe } : {}),
    ...(!ffmpeg || !ffprobe ? { error: `${[!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' and ')} was not found or could not run.` } : {}) };
}
