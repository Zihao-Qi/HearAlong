/** The pinned Python environment for run_python, shared by the extension and the server's startup warm-up. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export const PACKAGES = ['numpy==2.2.6', 'scipy==1.15.3', 'sympy==1.14.0'];
export const UV_ARGS = ['run', '--no-config', '--no-project', '--quiet', '--python', '3.12', ...PACKAGES.flatMap(p => ['--with', p])];

/** Pin uv's runtime locations for preparation and execution alike; no user uv configuration is loaded. */
export function pythonEnv(env: NodeJS.ProcessEnv, cwd = process.cwd()): NodeJS.ProcessEnv {
  const at = cwd.lastIndexOf('/scratch/');
  const data = at > 0 ? cwd.slice(0, at) : env.MEETING_DATA_DIR;
  const base = data ? join(resolve(data), 'python') : join(env.HOME || homedir(), 'Library', 'Caches', 'HearAlong', 'python');
  return { ...env, UV_CACHE_DIR: join(base, 'cache'), UV_PYTHON_INSTALL_DIR: join(base, 'runtime'), UV_PYTHON_PREFERENCE: 'only-managed' };
}
