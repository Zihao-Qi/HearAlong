import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Called under the data-directory lock. A page's HttpOnly cookie must survive a recorder restart. */
export async function sessionToken(directory: string): Promise<string> {
  const path = join(directory, 'session-token');
  try {
    const saved = await readFile(path, 'utf8');
    if (/^[a-f0-9]{64}$/.test(saved)) return saved;
  } catch { /* Missing or unreadable: replace it, never publish a partially written token. */ }
  const token = randomBytes(32).toString('hex'), tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(token); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
    // Best effort for platforms that cannot sync directories; the token itself was synced before rename.
    const dir = await open(directory, 'r');
    try { await dir.sync(); } catch { /* directory sync unsupported */ } finally { await dir.close(); }
    return token;
  } finally { await rm(tmp, { force: true }); }
}
