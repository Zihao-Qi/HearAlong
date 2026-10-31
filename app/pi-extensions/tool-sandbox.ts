/** Calculation code loses credentials; Seatbelt confines reads to the selected runtime. Metadata stays readable. */
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { excludedDescendants } from './material-exclusions.ts';
import { insideRoots, realPath, scopeFromEnv } from './read-scope.ts';

// Pi's documented credentials (*_API_KEY, *_TOKEN, AWS/Azure/Cloudflare/Google keys, Anthropic's tokens) and their usual shapes.
const CREDENTIAL = /(?:^|_)(?:KEY|API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)|^(?:ANTHROPIC|AWS|AZURE_OPENAI|CLOUDFLARE)_/i;
export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL.test(name) && !/^(NODE_|LD_|DYLD_)/.test(name)));
}
const real = (path: string) => realPath(resolve(path));
const CALCULATION_SYSTEM = ['/usr/lib', '/System/Library', '/Library/Apple', '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc/localtime', '/dev/null', '/dev/urandom', '/dev/random'];

/** Calculations inherit locale only, never shell configuration, home/scope paths or credential-shaped variables. */
export function calculationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => /^(?:LANG|LC_[A-Z_]+|TZ)$/.test(name)));
}

/** Last matching Seatbelt rule wins. Data stays closed except selected runtime reads; credential denies stay last. */
export function sandboxed(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, runtimeReads: string[] = []): [string, string[]] {
  const home = real(env.HOME || homedir()), folder = real(cwd);
  const at = folder.lastIndexOf('/scratch/');
  const data = at > 0 ? folder.slice(0, at) : join(folder, '.no-data-folder');
  const executable = command.includes('/') ? resolve(cwd, command) : (env.PATH ?? '').split(delimiter).map(dir => resolve(dir, command)).find(path => existsSync(path));
  if (!executable) throw new Error(`Cannot find ${command}.`);
  let roots: ReturnType<typeof scopeFromEnv> = [];
  try { roots = scopeFromEnv(env).filter(root => insideRoots(root.path, [root])); } catch { /* No scope adds no exclusions; it never grants reads. */ }
  for (const path of [folder, ...roots.flatMap(root => [root.path, real(root.path)])]) {
    if (/["\\\r\n]/.test(path)) throw new Error("This folder's name can't be used for calculations because its real path contains a quote, backslash or newline. Rename or detach the folder.");
  }
  const params: Record<string, string> = {
    PI_HOME: join(home, '.pi'), PI_AGENT: real(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')),
    HOME: home, KEYCHAINS: join(home, 'Library', 'Keychains'), DATA: data, CWD: folder,
    PROJECT_PI: join(folder, '.pi'), PROJECT_AGENTS: join(folder, '.agents'), AGENTS: join(folder, 'AGENTS.md'), CLAUDE: join(folder, 'CLAUDE.md'),
    EXECUTABLE: real(executable),
  };
  let number = 0;
  const filter = (path: string, directory = true) => {
    const key = `READ_${number++}`;
    params[key] = real(path);
    return `(${directory ? 'subpath' : 'literal'} (param "${key}"))`;
  };
  const executableRead = filter(realpathSync(executable), false);
  // The child uses this same Node binary. Permit its loaded shared libraries individually, never the whole Cellar.
  const nodeLibraries = ((process.report.getReport() as { sharedObjects?: string[] }).sharedObjects ?? [])
    .filter(path => path.endsWith('.dylib')).map(path => filter(path, false));
  const allowed = [filter('/', false), ...CALCULATION_SYSTEM.map(path => filter(path))];
  const runtime = runtimeReads.map(path => filter(path));
  const snapshots = roots.filter(root => root.path.startsWith(join(data, 'scratch', 'memory-snapshots') + '/'));
  const excluded = roots.filter(root => root.directory && root.path !== folder).map(root => `(regex #${JSON.stringify(excludedDescendants(root.path))})`);
  const exclusions = excluded.length ? `(deny file-read-data file-read-xattr ${excluded.join(' ')})` : '';
  const snapshotExclusions = snapshots.length ? `(deny file-read-data file-read-xattr ${snapshots.map(root => `(regex #${JSON.stringify(excludedDescendants(root.path))})`).join(' ')})` : '';
  // Code cannot rewrite the policy, runtime or installed packages.
  const profile = `(version 1)
(allow default)
(deny file-read-data file-read-xattr)
(deny user-preference-read user-preference-write appleevent-send)
(deny signal)
(allow signal (target self))
(deny process-exec)
(allow process-exec (literal (param "EXECUTABLE")))
(deny file-link)
(deny file-write-create (vnode-type SYMLINK))
(deny file-write*)
(allow file-write-data (literal "/dev/null"))
(allow file-read-data file-read-xattr ${allowed.join(' ')})
(deny network*)
(deny network-outbound (literal "/private/var/run/mDNSResponder"))
(deny file-read* file-read-data file-read-xattr file-write* (subpath (param "DATA")))
${exclusions}
(allow file-read-metadata (literal (param "DATA")))
(deny file-read-data file-read-xattr (subpath (param "HOME")) (subpath (param "CWD")))
${snapshotExclusions}
(allow file-read-data file-read-xattr ${[...runtime, executableRead, ...nodeLibraries].join(' ')})
(deny file-link)
(deny file-write-create (vnode-type SYMLINK))
(deny file-write* (subpath (param "PROJECT_PI")) (subpath (param "PROJECT_AGENTS")) (literal (param "AGENTS")) (literal (param "CLAUDE")))
(deny process-exec file-read* file-read-data (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.pasteboard.1") (global-name-prefix "com.apple.metadata.mds") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))
(deny file-read* file-read-data file-read-xattr file-write* (subpath (param "PI_HOME")) (subpath (param "PI_AGENT")) (subpath (param "KEYCHAINS")))`;
  return ['/usr/bin/sandbox-exec', ['-p', profile, ...Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]), command, ...args]];
}
