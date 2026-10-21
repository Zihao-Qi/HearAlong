import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { isPdf, searchForms, type PdfText } from './pdf-text.ts';

/** A read-only material root. `scope` is `project:<id>` or `meeting:<id>` (projects.ts keeps them). */
export type Material = { id: string; scope: string; path: string; kind: 'file' | 'folder'; label: string };
const TEXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.py', '.ipynb', '.ts', '.js', '.r', '.jl', '.yaml', '.yml']);
// project-memory/: the app's generated memory files (they may hold unapproved edits); memory reaches actions as a snapshot.
const EXCLUDED = new Set(['node_modules', '.git', '.ssh', '.aws', '.cache', '__pycache__', 'project-memory']);
export function excluded(name: string) {
  return name.startsWith('.') || EXCLUDED.has(name.toLowerCase()) || /(?:secret|credential|password|token)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
}
function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

/**
 * Searches the roots that apply to a meeting (local and read-only; nothing is sent to a model). A PDF is searched in its
 * extracted text (`pdf`), with the page of each hit; extraction is waited for at most `waitMs` in all.
 */
export async function searchRoots(roots: Material[], query: string, pdf?: PdfText, waitMs = 10_000) {
  const hits: { rootId: string; file: string; line: number | null; page?: number; text: string }[] = [];
  const deadline = Date.now() + waitMs;
  /** PDFs without text yet (or ever), with the reason. */
  const unread: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let visited = 0;
  const errors: { file: string; error: string }[] = [];
  // One unreadable or vanished file is reported, not allowed to fail the whole search.
  const visit = async (root: Material, path: string, depth: number): Promise<void> => {
    try { await visitPath(root, path, depth); }
    catch (error) {
      if (errors.length < 50) errors.push({ file: root.kind === 'folder' ? relative(root.path, path) : basename(path), error: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
    }
  };
  const visitPath = async (root: Material, path: string, depth: number): Promise<void> => {
    if (++visited > 1000 || scanned >= 500 || hits.length >= 50 || depth > 8) return;
    const actual = await realpath(path);
    if (root.kind === 'folder' ? !within(root.path, actual) : actual !== root.path) return;
    const info = await stat(actual);
    if (info.isDirectory()) {
      for (const entry of await readdir(actual, { withFileTypes: true })) {
        if (visited >= 1000 || scanned >= 500 || hits.length >= 50) break;
        if (!entry.isSymbolicLink() && !excluded(entry.name)) await visit(root, join(actual, entry.name), depth + 1);
      }
    } else if (info.isFile()) {
      scanned++;
      const file = root.kind === 'folder' ? relative(root.path, actual) : basename(actual);
      if (pdf && isPdf(actual)) {
        const read = await pdf.read(actual, { waitMs: deadline - Date.now() });
        if ('problem' in read) {
          skipped++;
          if (unread.length < 20) unread.push(`${file} (${read.problem})`);
          if (file.toLowerCase().includes(query.toLowerCase())) hits.push({ rootId: root.id, file, line: null, text: `Filename match only; ${read.problem}.` });
          return;
        }
        // A hit may run on to the next line, across a hyphenated word or a plain line break; it is shown at the line it starts on.
        // The app's own lines (header, page markers) are not searched; the page comes from the page lines kept with the text.
        // The query is read the same way as the text (a wrap copied into it counts both ways).
        const wanted = searchForms(query);
        const has = (text: string) => searchForms(text).some(form => wanted.some(w => form.includes(w)));
        const lines = read.text.split('\n');
        const generated = new Set(read.generated);
        let page = 0;
        for (let index = 0; index < lines.length && hits.length < 50; index++) {
          while (page < read.pageStarts.length && read.pageStarts[page] <= index + 1) page++;
          if (generated.has(index + 1) || !page) continue;
          const next = generated.has(index + 2) ? '' : lines[index + 1] ?? '';
          const own = has(lines[index]);
          const across = !own && next !== '' && !has(next) && has(`${lines[index]}\n${next}`);
          if (own || across) hits.push({ rootId: root.id, file, line: index + 1, page, text: (across ? `${lines[index]}\n${next}` : lines[index]).slice(0, 400) });
        }
        return;
      }
      if (!TEXT.has(extname(actual).toLowerCase()) || info.size > 512 * 1024) {
        skipped++;
        if (file.toLowerCase().includes(query.toLowerCase())) hits.push({ rootId: root.id, file, line: null, text: 'Filename match only; binary and large files are not searched.' });
        return;
      }
      const lines = (await readFile(actual, 'utf8')).split(/\r?\n/);
      for (let index = 0; index < lines.length && hits.length < 50; index++) {
        if (lines[index].toLowerCase().includes(query.toLowerCase())) {
          hits.push({ rootId: root.id, file, line: index + 1, text: lines[index].slice(0, 400) });
        }
      }
    }
  };
  for (const root of roots) {
    const path = await realpath(root.path).catch(() => root.path);
    await visit({ ...root, path }, path, 0);
  }
  return { hits, scanned, skipped, unread, errors, limited: visited >= 1000 || scanned >= 500 || hits.length >= 50 };
}
