/**
 * What model-written code may touch (run_python). Its environment loses every credential: Pi keeps the provider keys and tokens
 * it needs, and any a user's shell holds, but code a model wrote (perhaps steered by meeting or material text) never sees them.
 * It runs under macOS Seatbelt: everything is allowed except the network (DNS too), the Keychain (the `security` tool, also as a
 * copy, and the Security server), Pi's own sign-ins (~/.pi and PI_CODING_AGENT_DIR), and HearAlong's data folder, of which only
 * the task's own scratch folder stays open. Seatbelt applies the last matching rule, so that folder's allow comes last.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

// Pi's documented credentials (*_API_KEY, *_TOKEN, AWS/Azure/Cloudflare/Google keys, Anthropic's tokens) and their usual shapes.
const CREDENTIAL = /(?:^|_)(?:KEY|API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)|^(?:ANTHROPIC|AWS|AZURE_OPENAI|CLOUDFLARE)_/i;
export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL.test(name)));
}
const PROFILE = `(version 1)
(allow default)
(deny network*)
(allow network* (local unix-socket) (remote unix-socket))
(deny network-outbound (literal "/private/var/run/mDNSResponder"))
(deny process-exec file-read* (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))
(deny file-read* file-write* (subpath (param "PI_HOME")) (subpath (param "PI_AGENT")) (subpath (param "KEYCHAINS")) (subpath (param "DATA")))
(allow file-read* file-write* (subpath (param "CWD")))`;
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
/**
 * The command and arguments that run `command args` in the sandbox, for a task whose scratch folder is `cwd`. HearAlong's data
 * folder is the one holding that scratch folder (every task's cwd is `<data>/scratch/…`); elsewhere nothing extra is closed.
 */
export function sandboxed(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const home = real(env.HOME || homedir()), folder = real(cwd);
  const at = folder.lastIndexOf('/scratch/');
  const params = { PI_HOME: join(home, '.pi'), PI_AGENT: real(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')), KEYCHAINS: join(home, 'Library', 'Keychains'),
    DATA: at > 0 ? folder.slice(0, at) : join(folder, '.no-data-folder'), CWD: folder };
  return ['/usr/bin/sandbox-exec', ['-p', PROFILE, ...Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]), command, ...args]];
}
