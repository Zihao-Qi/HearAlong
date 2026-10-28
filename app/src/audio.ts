import { spawn } from 'node:child_process';

export const SAMPLE_RATE = 16_000;
export const CHUNK_SECONDS = 20;

/** Bounded subprocess output, timeout, no shell, and cancellation. */
export async function runBinary(command: string, args: string[], options: {
  input?: Buffer; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const buffers: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error(`${command} timed out.`)), options.timeoutMs ?? 30_000);
    const abort = () => fail(new Error('Operation cancelled.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) return fail(new Error(`${command} output exceeded its limit.`));
      buffers.push(part);
    });
    child.stderr.on('data', (part: Buffer) => { stderr = (stderr + part.toString()).slice(-4000); });
    child.stdin.on('error', () => {}); // An early decoder exit is reported by close.
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`));
      else resolve(Buffer.concat(buffers));
    });
    child.stdin.end(options.input);
  });
}

export async function probeDuration(path: string): Promise<number> {
  const output = await runBinary(process.env.MEETING_FFPROBE ?? 'ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path,
  ]);
  const probe = JSON.parse(output.toString());
  const seconds = Number(probe.format?.duration);
  if (!probe.streams?.length || !Number.isFinite(seconds) || seconds <= 0 || seconds > 8 * 3600) {
    throw new Error('Provide media with an audio track and a known duration between 0 and 8 hours.');
  }
  return seconds;
}

export async function decodeChunk(path: string, startSeconds: number, seconds: number, sampleRate?: number, signal?: AbortSignal): Promise<Float32Array> {
  const args = ['-nostdin', '-v', 'error'];
  if (sampleRate) args.push('-f', 'f32le', '-ar', String(sampleRate), '-ac', '1');
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', path, '-t', String(seconds), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
  const pcm = await runBinary(process.env.MEETING_FFMPEG ?? 'ffmpeg', args, { maxBytes: (seconds + 1) * SAMPLE_RATE * 4, signal });
  if (!pcm.length || pcm.length % 4) throw new Error('The decoder returned no usable audio.');
  // slice gives an aligned, exclusively owned ArrayBuffer for the native library.
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
}
