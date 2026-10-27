// Stand-ins for saved API keys: a fake `security` (no Keychain) and fake provider model lists on 127.0.0.1.
import { mkdtemp, realpath, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function fakeSecurity(t: { after(fn: () => unknown): void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fake-security-')));
  const command = join(dir, 'security');
  await copyFile(new URL('../fixtures/fake-security.mjs', import.meta.url), command); await chmod(command, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = async (): Promise<{ args: string[]; stdin: string }[]> => (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const store = async (): Promise<Record<string, string>> => JSON.parse(await readFile(join(dir, 'store.json'), 'utf8').catch(() => '{}'));
  return { dir, command, calls, store, env: { MEETING_SECURITY: command, FAKE_SECURITY_DIR: dir } };
}

/** Accepts the keys in `good` (by provider); Google answers others with 400, the rest with 401. `status` forces an answer. */
export async function fakeProviders(t: { after(fn: () => unknown): void }, good: Record<string, string>) {
  const requests: { url: string; headers: IncomingMessage['headers'] }[] = [];
  const state = { status: 0, delayMs: 0 };
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const [provider, key] = url.pathname === '/google/v1beta/models' ? ['google', req.headers['x-goog-api-key']]
      : url.pathname === '/openai/v1/models' ? ['openai', String(req.headers.authorization ?? '').replace(/^Bearer /, '')]
      : url.pathname === '/anthropic/v1/models' && req.headers['anthropic-version'] ? ['anthropic', req.headers['x-api-key']] : ['', ''];
    const ok = provider && key === good[provider];
    const status = state.status || (ok ? 200 : provider === 'google' ? 400 : provider ? 401 : 404);
    // A real provider may echo part of a bad key back; HearAlong must never show it.
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(status === 200 ? { data: [] } : { error: { message: `Invalid key ${key}` } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = (server.address() as { port: number }).port;
  const env = { MEETING_GOOGLE_API_BASE: `http://127.0.0.1:${port}/google`, MEETING_OPENAI_API_BASE: `http://127.0.0.1:${port}/openai`, MEETING_ANTHROPIC_API_BASE: `http://127.0.0.1:${port}/anthropic` };
  return { requests, state, env, port };
}
