import { accessSync, statSync, constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolEnv } from '../pi-extensions/tool-sandbox.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RECOMMENDED_LOCAL_MODEL = 'qwen3:8b';
export const LOCAL_MODELS_EXTENSION = join(ROOT, 'pi-extensions', 'local-models.ts');
export type AiMode = 'local' | 'cloud' | 'off';
export const isLocalModel = (id: string) => /^(ollama|lmstudio)\/.+/.test(id);

// Like saved keys, admission belongs to the one app server in this process. Recheck pinned task/plan models at every spawn.
let admission: ((model: string) => AiMode) | undefined;
const activeRuns = new Set<() => void>();
export function watchPiRun(stop: () => void): () => void { activeRuns.add(stop); return () => activeRuns.delete(stop); }
export function stopPiRuns() { for (const stop of [...activeRuns]) stop(); }
export function setPiAdmission(check: (model: string) => AiMode): () => void {
  admission = check;
  return () => { if (admission === check) admission = undefined; };
}

/** Shared launch boundary for listings, tasks and RPC. Refuse before resolving or spawning Pi. */
export function piLaunch(args: string[], options: { mode?: AiMode; model?: string; env?: NodeJS.ProcessEnv; cwd?: string; listing?: boolean; omit?: KeyProvider } = {}) {
  const base = options.env ?? process.env;
  const requested = options.mode ?? (options.model && isLocalModel(options.model) ? 'local' : 'cloud');
  const active = options.model ? admission?.(options.model) : undefined;
  const mode = base.MEETING_CLOUD === '0' || requested === 'off' || active === 'off' ? 'off' : requested === 'local' || active === 'local' ? 'local' : 'cloud';
  if (mode === 'off') throw new Error('AI is off for this start.');
  if (mode === 'local' && options.model && !isLocalModel(options.model)) throw new Error(`Only local models may run on this Mac: ${options.model}.`);
  const env = piEnv(base, options.omit, mode);
  // User models.json can contain credential commands and endpoint overrides. Local runs never load that configuration.
  if (mode === 'local' && options.cwd) env.PI_CODING_AGENT_DIR = join(options.cwd, '.pi-local');
  return { args: [
    ...(mode === 'local' ? ['--no-extensions', '--no-skills'] : []),
    ...(mode === 'local' || options.listing ? ['-e', LOCAL_MODELS_EXTENSION] : []), ...args.filter((arg, index) => mode !== 'local' || arg !== '--no-skills' || (args.indexOf('--') >= 0 && index > args.indexOf('--'))),
  ], env };
}
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
export function piEnv(base: NodeJS.ProcessEnv = process.env, omit?: KeyProvider, mode: AiMode = 'cloud'): NodeJS.ProcessEnv {
  const env = mode === 'local' ? toolEnv(base) : { ...base };
  if (mode === 'local') {
    for (const name of Object.keys(env)) if (/^(?:https?|all|no)_proxy$/i.test(name)) delete env[name];
    env.PI_OFFLINE = '1'; env.PI_TELEMETRY = '0'; env.PI_SKIP_VERSION_CHECK = '1';
    return env;
  }
  for (const [provider, key] of Object.entries(savedKeys) as [KeyProvider, string][]) {
    if (key && provider !== omit && !envProvides(base, provider)) env[KEY_PROVIDERS[provider].env] = key;
  }
  env.PI_TELEMETRY = '0'; env.PI_SKIP_VERSION_CHECK = '1';
  return env;
}
