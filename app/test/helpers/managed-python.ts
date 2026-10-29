// Controlled system-runtime copy for offline fixtures; never use or modify the user's uv cache.
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pythonEnv } from '../../pi-extensions/python-env.ts';
const exec = promisify(execFile);
export async function managedPython(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const source = (await exec('/usr/bin/which', ['python3'], { env })).stdout.trim();
  const home = (await exec(source, ['-I', '-c', 'import sys; print(sys.base_prefix)'], { env })).stdout.trim();
  const runtime = pythonEnv(env, cwd).UV_PYTHON_INSTALL_DIR!;
  await mkdir(join(runtime, 'bin'), { recursive: true });
  const python = join(runtime, 'bin', 'python3');
  const framework = join(home, 'Resources', 'Python.app', 'Contents', 'MacOS', 'Python');
  const actual = await access(framework).then(() => framework, () => source);
  await copyFile(await realpath(actual), python);
  return { python, env: { ...env, PYTHONHOME: home } };
}
