import { mkdtemp, realpath, copyFile, chmod, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const table = (rows = ['example example-main 128K 8K yes yes', 'example example-quick:0 32K 4K no no']) =>
  'provider  model  context  max-out  thinking  images\n' + rows.map(row => row.split(' ').join('  ')).join('\n') + '\n';
export async function fakePi(t: { after(fn: () => unknown): void }, initial: Record<string, unknown> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'setup-ai-')));
  const command = join(directory, 'pi'), state = join(directory, 'state.json'), log = join(directory, 'calls.jsonl');
  await copyFile(new URL('../fixtures/setup-pi.mjs', import.meta.url), command); await chmod(command, 0o755);
  await mkdir(join(directory, 'scratch'));
  const configure = (change: Record<string, unknown>) => writeFile(state, JSON.stringify({ table: table(), log, ...change }));
  await configure(initial);
  const calls = async (): Promise<{ args: string[]; pid: number; model: string; cwd: string }[]> => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, MEETING_PI: command, FAKE_PI_STATE: state, PI_CODING_AGENT_DIR: join(directory, 'agent') };
  return { directory, command, state, log, configure, calls, env, cwd: join(directory, 'scratch') };
}
export async function until(check: () => Promise<boolean> | boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fake Pi.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
