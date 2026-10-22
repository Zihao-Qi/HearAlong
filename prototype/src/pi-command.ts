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
