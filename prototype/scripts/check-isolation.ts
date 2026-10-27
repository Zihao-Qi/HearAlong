// Node-side boundary for tests and checks; subprocess fixtures inherit isolated state, not a global preload.
import '../test/helpers/pi-env.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'check-env-'));
const home = join(directory, 'home');
mkdirSync(join(home, 'hf'), { recursive: true });
process.env.HOME = home;
process.env.HF_HOME = join(home, 'hf');
process.env.XDG_CACHE_HOME = join(home, '.cache');
process.env.MEETING_TEST_NO_MODELS = '1';
for (const name of ['MEETING_MODEL_PATH', 'MEETING_DATA_DIR', 'MEETING_CLOUD', 'PROGRESS_PUBLIC_ROOT', 'MEETING_PROCESS_DIR']) delete process.env[name];
// A real provider key in the owner's shell never reaches a fixture, and only a test's own fake can stand in for the Keychain.
for (const name of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN']) delete process.env[name];
process.env.MEETING_SECURITY = '/usr/bin/false';
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

export function piPackages(web = false) {
  writeFileSync(process.env.MEETING_PI!, `#!/bin/sh
case "$*" in
  '--no-context-files --list-models') printf 'No models available. Use /login to log into a provider.\\n' ;;
  list) printf '${web ? 'User packages:\\n  npm:pi-web-access\\n    /fictional/web\\n' : 'No packages installed.\\n'}' ;;
  *) echo 'Unexpected Pi model call in check: inject a scripted runner.' >&2; exit 95 ;;
esac
`);
}
piPackages();

const fetch = globalThis.fetch;
const loopback = (url: URL) => { if (url.hostname !== '127.0.0.1') throw new Error(`Non-loopback fetch blocked: ${url.origin}`); };
globalThis.fetch = (input, options) => {
  loopback(new URL(typeof input === 'string' || input instanceof URL ? input : input.url));
  const redirect = options?.redirect ?? (typeof input === 'string' || input instanceof URL ? 'follow' : input.redirect);
  if (redirect !== 'follow') return fetch(input, options);
  return follow(new Request(input, options));
};
// Follow local onboarding redirects, but validate each Location before making its request.
async function follow(request: Request): Promise<Response> {
  for (let hop = 0; hop <= 20; hop++) {
    const response = await fetch(request.clone(), { redirect: 'manual' });
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      if (hop) Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }
    await response.body?.cancel();
    if (hop === 20) throw new Error('Too many loopback redirects in check.');
    const url = new URL(location, request.url);
    loopback(url);
    const headers = new Headers(request.headers);
    if (url.origin !== new URL(request.url).origin) for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
    const get = ((response.status === 301 || response.status === 302) && request.method === 'POST')
      || (response.status === 303 && request.method !== 'GET' && request.method !== 'HEAD');
    if (get) for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
    const init = { method: get ? 'GET' : request.method, body: get ? null : request.body, headers, signal: request.signal, redirect: request.redirect, duplex: 'half' };
    request = new Request(url, init);
  }
  throw new Error('Unreachable redirect limit.');
}
