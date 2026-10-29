/** The pinned Python environment for run_python, shared by the extension and the server's startup warm-up. */
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const PACKAGES = ['numpy==2.2.6', 'scipy==1.15.3', 'sympy==1.14.0'];
export const UV_ARGS = ['run', '--no-config', '--no-project', '--quiet', '--python', '3.12', ...PACKAGES.flatMap(p => ['--with', p])];

/** Pin uv's runtime locations for preparation and execution alike; no user uv configuration is loaded. */
export function pythonEnv(env: NodeJS.ProcessEnv, cwd = process.cwd()): NodeJS.ProcessEnv {
  const at = cwd.lastIndexOf('/scratch/');
  const data = at > 0 ? cwd.slice(0, at) : env.MEETING_DATA_DIR;
  const base = data ? join(resolve(data), 'python') : join(env.HOME || homedir(), 'Library', 'Caches', 'HearAlong', 'python');
  const result: NodeJS.ProcessEnv = { ...env, UV_CACHE_DIR: join(base, 'cache'), UV_PYTHON_INSTALL_DIR: join(base, 'runtime'), UV_PYTHON_PREFERENCE: 'only-managed' };
  // Never let a user/parent virtualenv choose code outside the app-owned prepared runtime.
  delete result.VIRTUAL_ENV; delete result.UV_ACTIVE;
  return result;
}

const within = (path: string, root: string) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)); };
const preparedFile = (env: NodeJS.ProcessEnv, cwd: string) => join(dirname(pythonEnv(env, cwd).UV_CACHE_DIR!), 'prepared.json');

/** Only trusted preparation writes this manifest; both the environment and its real interpreter must stay app-owned. */
async function validatePrepared(prefix: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  if (typeof prefix !== 'string' || !prefix) throw new Error('Invalid prepared Python environment.');
  const locations = pythonEnv(env, cwd);
  const [cache, runtime, actual] = await Promise.all([realpath(locations.UV_CACHE_DIR!), realpath(locations.UV_PYTHON_INSTALL_DIR!), realpath(prefix)]);
  const interpreter = await realpath(join(actual, 'bin', 'python3'));
  if ((!within(actual, cache) && !within(actual, runtime)) || within(actual, join(cache, 'builds-v0')) || !within(interpreter, runtime)) {
    throw new Error('Prepared Python environment is outside the app-owned runtime/cache. Prepare it again.');
  }
  return actual;
}

export async function savePreparedPython(prefix: unknown, env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<void> {
  const environment = await validatePrepared(prefix, env, cwd), path = preparedFile(env, cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ environment }), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function preparedPython(env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<string | null> {
  let text: string;
  try { text = await readFile(preparedFile(env, cwd), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return validatePrepared(JSON.parse(text).environment, env, cwd);
}
