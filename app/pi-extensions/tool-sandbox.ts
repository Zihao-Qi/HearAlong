/** Model-written code loses credentials and can read only task roots and its Python runtime. Metadata stays readable. */
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs';
import { pythonEnv } from './python-env.ts';
import { excludedDescendants } from './material-exclusions.ts';
import { insideRoots, realPath, scopeFromEnv } from './read-scope.ts';

// Pi's documented credentials (*_API_KEY, *_TOKEN, AWS/Azure/Cloudflare/Google keys, Anthropic's tokens) and their usual shapes.
const CREDENTIAL = /(?:^|_)(?:KEY|API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)|^(?:ANTHROPIC|AWS|AZURE_OPENAI|CLOUDFLARE)_/i;
export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL.test(name)));
}
const real = (path: string) => realPath(resolve(path));
/** The system libraries/configuration used by uv, CPython, and native math packages (including Homebrew installations). */
const SYSTEM = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/System', '/Library/Apple', '/Library/Developer/CommandLineTools', '/bin', '/sbin', '/opt/homebrew/Cellar', '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc', '/dev'];

/** Last matching Seatbelt rule wins. Data stays closed except explicitly supplied scratch roots; credential denies stay last. */
export function sandboxed(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const home = real(env.HOME || homedir()), folder = real(cwd);
  const at = folder.lastIndexOf('/scratch/');
  const data = at > 0 ? folder.slice(0, at) : join(folder, '.no-data-folder');
  const runtime = pythonEnv(env, folder);
  const executable = command.includes('/') ? resolve(cwd, command) : (env.PATH ?? '').split(delimiter).map(dir => resolve(dir, command)).find(path => existsSync(path));
  if (!executable) throw new Error(`Cannot find ${command}.`);
  // Only a trusted fake-uv shebang needs Node; production uv is native and must not grant unrelated interpreters.
  const header = Buffer.alloc(512), fd = openSync(executable, 'r');
  let nodeInterpreter = false;
  try { nodeInterpreter = header.subarray(0, readSync(fd, header, 0, header.length, 0)).toString().split('\n')[0] === `#!${process.execPath}`; }
  finally { closeSync(fd); }
  let roots: ReturnType<typeof scopeFromEnv> = [];
  try { roots = scopeFromEnv(env).filter(root => insideRoots(root.path, [root])); } catch { /* No scope means scratch only, never read-everything. */ }
  const params: Record<string, string> = {
    PI_HOME: join(home, '.pi'), PI_AGENT: real(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')),
    KEYCHAINS: join(home, 'Library', 'Keychains'), DATA: data, CWD: folder, CACHE: real(runtime.UV_CACHE_DIR!), CACHE_BUILDS: real(join(runtime.UV_CACHE_DIR!, 'builds-v0')), PYTHON: real(runtime.UV_PYTHON_INSTALL_DIR!), PYTHON_PARENT: real(dirname(runtime.UV_PYTHON_INSTALL_DIR!)),
    PROJECT_PI: join(folder, '.pi'), PROJECT_AGENTS: join(folder, '.agents'), AGENTS: join(folder, 'AGENTS.md'), CLAUDE: join(folder, 'CLAUDE.md'),
    EXECUTABLE: real(executable), NODE: real(process.execPath),
  };
  let number = 0;
  const filter = (path: string, directory = true) => {
    const key = `READ_${number++}`;
    params[key] = real(path);
    return `(${directory ? 'subpath' : 'literal'} (param "${key}"))`;
  };
  const allowed = [filter('/', false), ...SYSTEM.map(path => filter(path)), filter(runtime.UV_CACHE_DIR!), filter(runtime.UV_PYTHON_INSTALL_DIR!),
    filter(realpathSync(executable), false), filter(process.execPath, false), ...roots.map(root => filter(root.path, root.directory))];
  const scratch = roots.filter(root => root.path.startsWith(join(data, 'scratch', 'memory-snapshots') + '/')).map(root => filter(root.path, root.directory));
  const excluded = roots.filter(root => root.directory && root.path !== folder).map(root => `(regex #${JSON.stringify(excludedDescendants(root.path))})`);
  // Code cannot rewrite the policy, helper executables or installed packages. uv needs only its markers/locks and build temp.
  const profile = `(version 1)
(allow default)
(deny file-read-data file-read-xattr)
(deny user-preference-read user-preference-write appleevent-send)
(deny signal)
(allow signal (target self))
(deny process-exec)
(allow process-exec (literal (param "EXECUTABLE")) ${nodeInterpreter ? '(literal (param "NODE"))' : ''} (subpath (param "PYTHON")) (literal "/bin/sh") (literal "/bin/bash"))
(deny file-link)
(deny file-write-create (vnode-type SYMLINK))
(deny file-write*)
(allow file-write-data (literal "/dev/null"))
(allow file-write* (subpath (param "CACHE_BUILDS")) (require-all (subpath (param "CACHE")) (regex #"/([^/]*[.]lock|[.]git|[.]gitignore|CACHEDIR[.]TAG)$")))
(allow file-read-data file-read-xattr ${allowed.join(' ')})
(deny network*)
(deny network-outbound (literal "/private/var/run/mDNSResponder"))
(deny file-read* file-read-data file-read-xattr file-write* (subpath (param "DATA")))
${excluded.length ? `(deny file-read-data file-read-xattr ${excluded.join(' ')})` : ''}
; uv canonicalizes its minor-version interpreter alias through these parents. Metadata only: no directory listing or sibling reads.
(allow file-read-metadata (literal (param "DATA")) (literal (param "PYTHON_PARENT")))
(allow file-read* file-read-data file-read-xattr (subpath (param "CACHE")) (subpath (param "PYTHON")))
(allow file-write* (subpath (param "CACHE_BUILDS")) (require-all (subpath (param "CACHE")) (regex #"/([^/]*[.]lock|[.]git|[.]gitignore|CACHEDIR[.]TAG)$")))
${scratch.length ? `(allow file-read-data ${scratch.join(' ')})` : ''}
(allow file-read* file-read-data file-read-xattr file-write* (subpath (param "CWD")))
(deny file-link)
(deny file-write-create (vnode-type SYMLINK))
(deny file-write* (subpath (param "PROJECT_PI")) (subpath (param "PROJECT_AGENTS")) (literal (param "AGENTS")) (literal (param "CLAUDE")))
(deny process-exec file-read* file-read-data (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.pasteboard.1") (global-name-prefix "com.apple.metadata.mds") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))
(deny file-read* file-read-data file-read-xattr file-write* (subpath (param "PI_HOME")) (subpath (param "PI_AGENT")) (subpath (param "KEYCHAINS")))`;
  return ['/usr/bin/sandbox-exec', ['-p', profile, ...Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]), command, ...args]];
}
