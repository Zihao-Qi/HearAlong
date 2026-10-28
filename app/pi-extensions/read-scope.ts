// The roots come from HearAlong at launch, never from tool input. Tool calls fail closed if that scope is missing or invalid.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveReadPath, resolveToCwd } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js';

export const READ_SCOPE_ENV = 'MEETING_READ_SCOPE';
export type ReadRoot = { path: string; directory: boolean; identity: string };
const identity = (path: string) => { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };

/** Capture existing roots once, before the task starts. Inode comparisons respect the volume's case/Unicode semantics. */
export function readRoots(paths: string[]): ReadRoot[] {
  return paths.map(path => {
    const real = realpathSync.native(resolve(path));
    return { path: real, directory: statSync(real).isDirectory(), identity: identity(real) };
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
export function insideRoots(path: string, roots: ReadRoot[]): boolean {
  let current: string;
  try { current = realPath(path); } catch { return false; }
  const target = current;
  for (;;) {
    try {
      const id = identity(current);
      if (roots.some(root => root.identity === id && (root.directory || (current === target && current === root.path)))) return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

const PATH_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write']);
const selectedPath = (tool: string, path: string, cwd: string) => tool === 'read' ? resolveReadPath(path, cwd) : resolveToCwd(path, cwd);
export function pathDecision(tool: string, input: Record<string, unknown>, cwd: string, roots: ReadRoot[]): { block: true; reason: string } | undefined {
  if (tool === 'bash' || tool === 'powershell') return { block: true, reason: `${tool} is outside this task's materials.` };
  if (!PATH_TOOLS.has(tool)) return;
  const path = typeof input.path === 'string' && input.path ? input.path : '.';
  try {
    const selected = selectedPath(tool, path, cwd);
    if (insideRoots(selected, roots)) return;
  } catch { /* A failed authorization never falls through to execution. */ }
  return { block: true, reason: `${path} is outside this task's materials.` };
}

export default function readScope(pi: ExtensionAPI) {
  // rg must not pick up user-supplied --follow or --pre flags from a configuration file.
  delete process.env.RIPGREP_CONFIG_PATH;
  let roots: ReadRoot[] = [];
  try { roots = scopeFromEnv(process.env); } catch { /* Register the blocking hook even with a broken launch scope. */ }
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
}
