// The roots come from HearAlong at launch, never from tool input. Tool calls fail closed if that scope is missing or invalid.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { lstatSync, readdirSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { resolveReadPath, resolveToCwd } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js';

import { homedir } from 'node:os';
import { excluded } from './material-exclusions.ts';
import { safeWebUrl } from './web-url.ts';
import type { SearchEntry } from './node-search.ts';

export const READ_SCOPE_ENV = 'MEETING_READ_SCOPE';
export type ReadRoot = { path: string; directory: boolean; identity: string };
const identity = (info: Pick<BigIntStats, 'dev' | 'ino'>) => `${info.dev}:${info.ino}`;

/** Capture existing roots once, before the task starts. Inode comparisons respect the volume's case/Unicode semantics. */
export function readRoots(paths: string[]): ReadRoot[] {
  return paths.map(path => {
    const real = realpathSync.native(resolve(path));
    const info = statSync(real, { bigint: true });
    return { path: real, directory: info.isDirectory(), identity: identity(info) };
  });
}

/** Missing paths use their nearest existing parent; dangling symlinks and errors other than ENOENT are not bypasses. */
export function realPath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { lstatSync(path); throw new Error('Dangling symlink'); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realPath(parent), basename(path));
  }
}

export function scopeFromEnv(env: NodeJS.ProcessEnv): ReadRoot[] {
  const roots: unknown = JSON.parse(env[READ_SCOPE_ENV] ?? 'null');
  if (!Array.isArray(roots) || !roots.length || roots.some(r => !r || typeof r.path !== 'string' || typeof r.directory !== 'boolean' || typeof r.identity !== 'string')) {
    throw new Error('This task has no materials scope.');
  }
  return roots;
}

/** Check ancestors by filesystem identity, not by lowercasing (which would be unsafe on case-sensitive volumes). */
export function insideRoots(path: string, roots: ReadRoot[], targetInfo?: BigIntStats): boolean {
  let current: string;
  try { current = realPath(path); } catch { return false; }
  const target = current;
  for (;;) {
    try {
      const id = identity(current === target && targetInfo ? targetInfo : statSync(current, { bigint: true }));
      if (roots.some(root => root.identity === id && (root.directory || (current === target && current === root.path)))) return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

const TOOL_KEYS: Record<string, string[]> = {
  read: ['path', 'offset', 'limit'], grep: ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'],
  find: ['pattern', 'path', 'limit'], ls: ['path', 'limit'], edit: ['path', 'edits'], write: ['path', 'content'],
  calculate: ['code'], web_search: ['query', 'queries', 'numResults', 'recency', 'domain', 'domains', 'maxResults'],
  fetch_content: ['url', 'urls', 'prompt', 'forceClone', 'maxLength'],
  get_search_content: ['responseId', 'queryIndex', 'resultIndex', 'url', 'urls', 'offset', 'limit'],
};
export function explicitTools(tools: string | null | undefined): tools is string {
  return typeof tools === 'string' && tools.length > 0 && tools.split(',').every(name => Object.hasOwn(TOOL_KEYS, name));
}
const PATH_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write']);
export function dataFolder(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const at = cwd.lastIndexOf('/scratch/');
  return at > 0 ? cwd.slice(0, at) : env.MEETING_DATA_DIR;
}
export function protectedPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  return [join(home, '.pi'), env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), join(home, 'Library', 'Keychains'), dataFolder(cwd, env)].filter((p): p is string => Boolean(p)).map(path => realPath(resolve(path)));
}
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
export function allowedPath(path: string, cwd: string, roots: ReadRoot[], env: NodeJS.ProcessEnv = process.env, targetInfo?: BigIntStats): boolean {
  const target = realPath(path), scratch = realPath(cwd), data = dataFolder(scratch, env);
  for (const blocked of protectedPaths(scratch, env)) {
    if (!within(target, blocked)) continue;
    const snapshot = data && roots.some(root => within(root.path, join(data, 'scratch', 'memory-snapshots')) && within(target, root.path));
    if (blocked !== data || (!within(target, scratch) && !snapshot)) return false;
  }
  let info = targetInfo;
  try {
    info ??= statSync(target, { bigint: true });
    // Private file names stay private even when explicitly attached as single-file roots.
    if (info.isFile() && (info.nlink > 1n || excluded(basename(target)))) return false;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return roots.some(root => insideRoots(target, [root], info) && !relative(root.path, target).split(sep).filter(Boolean).some(excluded));
}
const selectedPath = (tool: string, path: string, cwd: string) => tool === 'read' ? resolveReadPath(path, cwd) : resolveToCwd(path, cwd);
export function pathDecision(tool: string, input: Record<string, unknown>, cwd: string, roots: ReadRoot[], entries?: SearchEntry[]): { block: true; reason: string } | undefined {
  const path = typeof input.path === 'string' && input.path ? input.path : '.';
  const block = { block: true as const, reason: `${PATH_TOOLS.has(tool) ? path : tool} is outside this task's materials.` };
  if (!Object.hasOwn(TOOL_KEYS, tool) || Object.keys(input).some(key => !TOOL_KEYS[tool].includes(key))) return block;
  if (!PATH_TOOLS.has(tool)) {
    if (input.urls !== undefined && (!Array.isArray(input.urls) || input.urls.length === 0)) return block;
    const urls = [...(input.url === undefined ? [] : [input.url]), ...(Array.isArray(input.urls) ? input.urls : [])];
    if (urls.some(value => !safeWebUrl(value)) || (tool === 'fetch_content' && urls.length === 0)) return block;
    return;
  }
  try {
    const selected = selectedPath(tool, path, cwd);
    if (allowedPath(selected, cwd, roots) && (!['edit', 'write'].includes(tool) || insideRoots(selected, readRoots([cwd])))) {
      if (['grep', 'find'].includes(tool) && !cleanSearchTree(realPath(selected), cwd, roots, entries)) return { block: true, reason: 'This folder contains excluded or sensitive paths. Search a smaller permitted folder, or read a permitted file.' };
      return;
    }
  } catch { /* A failed authorization never falls through to execution. */ }
  return block;
}

/** Refuse recursion that could include an excluded descendant. Metadata only; bounded. Optional manifest uses the same checks. */
function cleanSearchTree(path: string, cwd: string, roots: ReadRoot[], entries?: SearchEntry[]): boolean {
  let visited = 0;
  const visit = (current: string): boolean => {
    if (++visited > 20_000) return false;
    let info;
    try { info = lstatSync(current, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    // Authorize and seal this same metadata result, never a second lookup after a possible swap.
    if (info.isSymbolicLink() || !allowedPath(current, cwd, roots, process.env, info)) return false;
    entries?.push({ path: current, directory: info.isDirectory(), identity: identity(info) });
    if (!info.isDirectory()) return true;
    return readdirSync(current, { withFileTypes: true }).every(entry => !excluded(entry.name) && visit(join(current, entry.name)));
  };
  try { return visit(path); } catch { return false; }
}

export default async function readScope(pi: ExtensionAPI) {
  // rg must not pick up user-supplied --follow or --pre flags from a configuration file.
  delete process.env.RIPGREP_CONFIG_PATH;
  let roots: ReadRoot[] = [];
  try { roots = scopeFromEnv(process.env); } catch { /* Register the blocking hook even with a broken launch scope. */ }
  // Policy helpers are also imported by calculations/server code; only a loaded Pi extension needs search schemas.
  const { registerNodeSearch } = await import('./node-search.ts');
  registerNodeSearch(pi, (name, input, cwd) => {
    const entries: SearchEntry[] = [];
    const block = pathDecision(name, input, cwd, roots, entries);
    if (block) throw new Error(block.reason);
    return entries;
  });
  pi.on('tool_call', (event, ctx) => {
    const block = pathDecision(event.toolName, event.input, ctx.cwd, roots);
    if (block || !PATH_TOOLS.has(event.toolName)) return block;
    const input = event.input as Record<string, unknown>;
    const path = typeof input.path === 'string' && input.path ? input.path : '.';
    try {
      const canonical = realPath(selectedPath(event.toolName, path, ctx.cwd));
      // Execute the checked target, not the original symlink. Check Pi's normalization of that spelling too.
      if (!pathDecision(event.toolName, { path: canonical }, ctx.cwd, roots)) { input.path = canonical; return; }
    } catch { /* A target that disappeared after the check stays closed. */ }
    return { block: true, reason: `${path} is outside this task's materials.` };
  });
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'ls' || event.isError) return;
    const path = selectedPath('ls', typeof event.input.path === 'string' ? event.input.path : '.', ctx.cwd);
    return { content: event.content.map(part => part.type !== 'text' ? part : { ...part, text: part.text.split('\n').filter(line => {
      if (!line || line.startsWith('[') || line === '(empty directory)') return true;
      const name = line.replace(/\/$/, '');
      try { return !excluded(name) && allowedPath(join(path, name), ctx.cwd, roots); } catch { return false; }
    }).join('\n') || '(no permitted entries)' }) };
  });
}
