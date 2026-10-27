import { accessSync, statSync, constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** One executable policy for tasks, RPC and setup probes. An explicit override is authoritative, even if broken. */
export function resolvePi(options: { env?: NodeJS.ProcessEnv; root?: string } = {}): string | null {
  const env = options.env ?? process.env;
  if (env.MEETING_PI) return env.MEETING_PI;
  const executable = (path: string) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
  for (const folder of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = resolve(folder, 'pi');
    if (executable(path)) return path;
  }
  const bundled = join(options.root ?? ROOT, 'node_modules', '.bin', 'pi');
  return executable(bundled) ? bundled : null;
}
export function piCommand(command?: string, env?: NodeJS.ProcessEnv): string {
  const found = command ?? resolvePi({ env });
  if (!found) throw new Error('Pi is not installed. Run npm ci.');
  return found;
}

/** Providers HearAlong can keep an API key for, and the variables Pi reads one from (Anthropic's tokens come before its key). */
export const KEY_PROVIDERS = {
  google: { env: 'GEMINI_API_KEY', vars: ['GEMINI_API_KEY'] },
  openai: { env: 'OPENAI_API_KEY', vars: ['OPENAI_API_KEY'] },
  anthropic: { env: 'ANTHROPIC_API_KEY', vars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] },
} as const;
export type KeyProvider = keyof typeof KEY_PROVIDERS;
export const isKeyProvider = (value: unknown): value is KeyProvider => typeof value === 'string' && Object.hasOwn(KEY_PROVIDERS, value);
/** A credential for this provider in HearAlong's own environment: it wins over a saved key. */
export const envProvides = (env: NodeJS.ProcessEnv, provider: KeyProvider) => KEY_PROVIDERS[provider].vars.some(name => Boolean(env[name]));
// The saved keys, from the Keychain. Process-wide like the Keychain itself: one server per process (the data-folder lock).
let savedKeys: Partial<Record<KeyProvider, string>> = {};
let keysVersion = 0;
export function setPiKeys(keys: Partial<Record<KeyProvider, string>>) { savedKeys = { ...keys }; keysVersion++; }
/** Changes whenever the saved keys do: a warm Pi started before then lacks them. */
export const piKeysVersion = () => keysVersion;
/**
 * The one environment for every Pi child (tasks, warm lanes, listings, auth checks): the saved keys as Pi's variables, unless the
 * base environment already has a credential for that provider, and Pi's own telemetry and version check off. `omit` leaves one
 * provider's saved key out (to ask Pi whether it has a sign-in of its own).
 */
export function piEnv(base: NodeJS.ProcessEnv = process.env, omit?: KeyProvider): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [provider, key] of Object.entries(savedKeys) as [KeyProvider, string][]) {
    if (key && provider !== omit && !envProvides(base, provider)) env[KEY_PROVIDERS[provider].env] = key;
  }
  env.PI_TELEMETRY = '0'; env.PI_SKIP_VERSION_CHECK = '1';
  return env;
}
