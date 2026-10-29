// Trusted launcher compiled outside the calculation's sandbox, like the PDFKit helper. Versioned under app-owned data.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pythonEnv } from './python-env.ts';
const exec = promisify(execFile);
const source = fileURLToPath(new URL('../native/python-owner.c', import.meta.url));
const compiling = new Map<string, Promise<string>>();
export async function pythonOwner(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16);
  const path = join(dirname(pythonEnv(env, cwd).UV_CACHE_DIR!), 'owner', hash);
  let ready = compiling.get(path);
  if (!ready) {
    ready = (async () => {
      if (await stat(path).then(s => s.isFile(), () => false)) return path;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        await exec('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', source, '-o', temporary], { timeout: 120_000, env });
        await rename(temporary, path);
        return path;
      } finally { await rm(temporary, { force: true }); }
    })();
    compiling.set(path, ready);
    ready.catch(() => compiling.delete(path));
  }
  return ready;
}
