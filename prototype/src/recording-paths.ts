// One read-only spelling/relocation rule for MeetingStore's repair and offline deletion decisions.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

const isDataRelative = (path: string) => Boolean(path) && !isAbsolute(path) && !path.split('/').includes('..');
export function dataRelativeRecordingPath(directory: string, path: string): string | null {
  const normalized = normalize(path);
  for (const root of new Set([resolve(directory), realpathSync(directory)])) {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!normalized.startsWith(prefix)) continue;
    const candidate = normalized.slice(prefix.length).split(sep).join('/');
    if (isDataRelative(candidate)) return candidate;
  }
  return null;
}
/** Outside references are NEVER probed. Only an exact audio/<owner>/file or imports/file tail at the new location is tried. */
export function repairedRecordingPath(directory: string, path: string, meetingId: string): string {
  if (!path || !isAbsolute(path)) return path;
  const relative = dataRelativeRecordingPath(directory, path);
  if (relative !== null) return relative;
  const parts = normalize(path).split(sep);
  const tail = parts.at(-3) === 'audio' && parts.at(-2) === meetingId ? parts.slice(-3)
    : parts.at(-2) === 'imports' ? parts.slice(-2) : null;
  const candidate = tail?.join('/');
  if (!candidate || !isDataRelative(candidate)) return path;
  try { return statSync(join(directory, candidate)).isFile() ? candidate : path; }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return path;
    throw error;
  }
}
