/** Model-written code loses credentials and can read only task roots and its Python runtime. Metadata stays readable. */
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { pythonEnv } from './python-env.ts';
import { insideRoots, realPath, scopeFromEnv } from './read-scope.ts';

// Pi's documented credentials (*_API_KEY, *_TOKEN, AWS/Azure/Cloudflare/Google keys, Anthropic's tokens) and their usual shapes.
const CREDENTIAL = /(?:^|_)(?:KEY|API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)|^(?:ANTHROPIC|AWS|AZURE_OPENAI|CLOUDFLARE)_/i;
export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL.test(name)));
}
const real = (path: string) => realPath(resolve(path));
/** The system libraries/configuration used by uv, CPython, and native math packages (including Homebrew installations). */
const SYSTEM = ['/usr', '/System', '/Library', '/bin', '/sbin', '/opt/homebrew/Cellar', '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc', '/dev'];

/** Last matching Seatbelt rule wins. Data stays closed except explicitly supplied scratch roots; credential denies stay last. */
export function sandboxed(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const home = real(env.HOME || homedir()), folder = real(cwd);
  const at = folder.lastIndexOf('/scratch/');
  const data = at > 0 ? folder.slice(0, at) : join(folder, '.no-data-folder');
  const runtime = pythonEnv(env);
  const executable = command.includes('/') ? resolve(cwd, command) : (env.PATH ?? '').split(delimiter).map(dir => resolve(dir, command)).find(path => existsSync(path));
  if (!executable) throw new Error(`Cannot find ${command}.`);
  let roots: ReturnType<typeof scopeFromEnv> = [];
  try { roots = scopeFromEnv(env).filter(root => insideRoots(root.path, [root])); } catch { /* No scope means scratch only, never read-everything. */ }
  const params: Record<string, string> = {
    PI_HOME: join(home, '.pi'), PI_AGENT: real(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')),
    KEYCHAINS: join(home, 'Library', 'Keychains'), DATA: data, CWD: folder, CACHE: real(runtime.UV_CACHE_DIR!), CACHE_BUILDS: real(join(runtime.UV_CACHE_DIR!, 'builds-v0')),
  };
  let number = 0;
  const filter = (path: string, directory = true) => {
    const key = `READ_${number++}`;
    params[key] = real(path);
    return `(${directory ? 'subpath' : 'literal'} (param "${key}"))`;
  };
  const allowed = [filter('/', false), ...SYSTEM.map(path => filter(path)), filter(runtime.UV_CACHE_DIR!), filter(runtime.UV_PYTHON_INSTALL_DIR!),
    filter(realpathSync(executable), false), filter(process.execPath, false), ...roots.map(root => filter(root.path, root.directory))];
  const scratch = roots.filter(root => root.path.startsWith(join(data, 'scratch') + '/')).map(root => filter(root.path, root.directory));
  // Code cannot rewrite the policy, helper executables or installed packages. uv needs only its markers/locks and build temp.
  const profile = `(version 1)
(allow default)
(deny file-read-data)
(deny file-write*)
(allow file-write-data (literal "/dev/null"))
(allow file-write* (subpath (param "CACHE_BUILDS")) (require-all (subpath (param "CACHE")) (regex #"/([^/]*[.]lock|[.]git|[.]gitignore|CACHEDIR[.]TAG)$")))
(allow file-read-data ${allowed.join(' ')})
(deny network*)
(allow network* (local unix-socket) (remote unix-socket))
(deny network-outbound (literal "/private/var/run/mDNSResponder"))
(deny file-read* file-read-data file-write* (subpath (param "DATA")))
${scratch.length ? `(allow file-read-data ${scratch.join(' ')})` : ''}
(allow file-read* file-read-data file-write* (subpath (param "CWD")))
(deny process-exec file-read* file-read-data (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))
(deny file-read* file-read-data file-write* (subpath (param "PI_HOME")) (subpath (param "PI_AGENT")) (subpath (param "KEYCHAINS")))`;
  return ['/usr/bin/sandbox-exec', ['-p', profile, ...Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]), command, ...args]];
}
