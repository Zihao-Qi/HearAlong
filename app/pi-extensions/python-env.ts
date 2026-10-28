/** The pinned Python environment for run_python, shared by the extension and the server's startup warm-up. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export const PACKAGES = ['numpy==2.2.6', 'scipy==1.15.3', 'sympy==1.14.0'];
export const UV_ARGS = ['run', '--no-config', '--no-project', '--quiet', '--python', '3.12', ...PACKAGES.flatMap(p => ['--with', p])];

/** Pin uv's runtime locations for preparation and execution alike; no user uv configuration is loaded. */
export function pythonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env.HOME || homedir();
  return { ...env,
    UV_CACHE_DIR: resolve(env.UV_CACHE_DIR || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'uv')),
    UV_PYTHON_INSTALL_DIR: resolve(env.UV_PYTHON_INSTALL_DIR || join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'uv', 'python')),
  };
}
