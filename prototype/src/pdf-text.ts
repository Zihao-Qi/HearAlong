// PDF materials as text. Pi's read tool and the app's search see a PDF's compressed bytes, so each PDF is extracted once with
// macOS's PDFKit (native/pdf-text.swift, compiled with the Swift toolchain on first use, as the launcher is) and the text is
// kept in the app's data folder, never beside the PDF: <data>/pdf-text/files/<the PDF's absolute path>.txt. A text file is
// used while the PDF's size and modification time are the ones it was made from; a changed PDF is extracted again.
// Pi never reads this shared cache: each task gets its own view (copies of the validated text of its roots' PDFs only).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excluded, type Material } from './materials.ts';
import { tokens } from './notes.ts';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'pdf-text.swift');
/** Bumped when the text format changes, so older text files are made again. */
const FORMAT = 2;
const PAGE_LINE = /^--- page (\d+) of (\d+) ---$/;
export const isPdf = (path: string) => extname(path).toLowerCase() === '.pdf';

/**
 * What a text file was made from, kept beside it: the PDF's version, and the lines the app wrote itself (the header, the page
 * markers, a closing note), which are never evidence. `pageStarts` are the marker lines, so a page never comes from the text.
 */
type Meta = { version: string; pageStarts: number[]; generated: number[] };
export type PdfRead = { text: string; pageStarts: number[]; generated: number[] };
/** A root's PDFs in a task's view: `text` is the view folder (folder root) or file (file root) Pi is pointed at. */
export type PdfRoot = {
  rootId: string; text: string; ready: number; missing: { file: string; problem: string }[];
  /**
   * With a view: each copied PDF (its path in the root) with the version, page lines and app-written lines of exactly the text
   * copied, so a run never takes them later from the shared cache, which may have been made again or pruned since.
   */
  files?: { file: string; version: string; pageStarts: number[]; generated: number[] }[];
};
export type Wait = { waitMs?: number; signal?: AbortSignal };
type Outcome = { path: string; meta: Meta } | { problem: string };
/** The Swift toolchain failed: not the document's fault, so it is tried again later, not remembered per PDF. */
class ToolError extends Error {}

export class PdfText {
  readonly folder: string;
  private options: { maxPages: number; maxChars: number; maxBytes: number; timeoutMs: number; rebuildAfterMs: number; extractor?: string };
  private log: (message: string) => void;
  private compiled: Promise<string> | null = null;
  private buildFailed: { at: number; message: string } | null = null;
  /** One extraction at a time; a PDF asked for again while it waits joins the same work. */
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<Outcome>>();
  /** PDFs that could not be extracted, by version, so a broken file is tried (and logged) once per change. */
  private failed = new Map<string, string>();
  /** Text files being read or linked right now; the cleanup leaves them alone. */
  private reading = new Map<string, number>();
  private children = new Set<ChildProcess>();
  private closed = false;

  constructor(directory: string, options: {
    log?: (message: string) => void; maxPages?: number; maxChars?: number; maxBytes?: number; timeoutMs?: number;
    /** How long a failed build of the extractor is not tried again. */
    rebuildAfterMs?: number;
    /** Tests: a program to run instead of the compiled extractor (same arguments and output). */
    extractor?: string;
  } = {}) {
    this.folder = join(directory, 'pdf-text');
    this.log = options.log ?? (message => console.warn(message));
    // Hundreds of pages stay bounded: at most 1,000 pages, 4 million characters, a 300 MB file and 2 minutes per PDF.
    this.options = { maxPages: options.maxPages ?? 1_000, maxChars: options.maxChars ?? 4_000_000, maxBytes: options.maxBytes ?? 300 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 120_000, rebuildAfterMs: options.rebuildAfterMs ?? 300_000, extractor: options.extractor };
  }

  /** Where a PDF's text is kept (`pdf` is a real absolute path). */
  textPath(pdf: string) { return `${this.mirror(pdf)}.txt`; }
  private mirror(path: string) { return join(this.folder, 'files', path); }
  /** The PDF a text file of this cache stands for, or null when the path is not one. */
  pdfOf(path: string): string | null {
    const rel = relative(this.mirror(sep), resolve(path));
    return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && /\.pdf\.txt$/i.test(rel) ? `${sep}${rel.slice(0, -4)}` : null;
  }

  /**
   * The PDF's validated text file, extracted first if missing or stale. Waits at most `waitMs` (and not past `signal`). An
   * extraction that was already running may have read an older version of the PDF: its text counts only if it is still the
   * PDF's current version, and otherwise the PDF is extracted once more.
   */
  async text(pdf: string, wait: Wait = {}): Promise<Outcome> {
    const deadline = Date.now() + (wait.waitMs ?? Infinity);
    for (let attempt = 0; ; attempt++) {
      const got = await this.current(pdf, { waitMs: deadline - Date.now(), signal: wait.signal });
      if ('problem' in got) return got;
      const now = await this.versionOf(pdf);
      if ('problem' in now) return now;
      if (now.version === got.meta.version) return got;
      if (attempt) return { problem: 'the PDF kept changing while it was read' };
    }
  }
  private async current(pdf: string, wait: Wait): Promise<Outcome> {
    const current = await this.versionOf(pdf);
    if ('problem' in current) return current;
    const path = this.textPath(pdf);
    const meta = await readMeta(path);
    if (meta?.version === current.version && await exists(path)) return { path, meta };
    const failure = this.failed.get(`${pdf}\n${current.version}`);
    if (failure) return { problem: failure };
    if (this.closed) return { problem: 'the app is closing' };
    let work = this.pending.get(pdf);
    if (!work) {
      work = this.chain.then(() => this.extract(pdf, path)).finally(() => this.pending.delete(pdf));
      this.chain = work.catch(() => {});
      this.pending.set(pdf, work);
    }
    return bounded(work, wait);
  }
  /**
   * What the kept text of a PDF was made from (its extraction's version, page lines and the app's own lines), without
   * extracting: null when there is none. The plans record it with what Pi read, and in their materials manifest.
   */
  async meta(pdf: string): Promise<{ version: string; pageStarts: number[]; generated: number[] } | null> { return readMeta(this.textPath(pdf)); }
  /** The PDF's text with its page lines, or why there is none; only a generation still current after reading counts. */
  async read(pdf: string, wait: Wait = {}): Promise<PdfRead | { problem: string }> {
    return this.use(pdf, wait, async path => ({ text: await readFile(path, 'utf8') }));
  }
  /**
   * Copies the PDF's validated text to `dest`, for a task's view: an independent copy (a clone where the disk can make one),
   * so a task that writes to its copy never changes the cache.
   */
  async publish(pdf: string, dest: string, wait: Wait = {}): Promise<{ ok: true; meta: Meta } | { problem: string }> {
    const done = await this.use(pdf, wait, async path => {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await copyFile(path, dest, constants.COPYFILE_FICLONE);
      return {};
    });
    if ('problem' in done) { await rm(dest, { force: true }); return done; }
    return { ok: true, meta: { version: done.version, pageStarts: done.pageStarts, generated: done.generated } };
  }
  /** Runs `act` on the text file, then checks that its version did not change meanwhile (an extraction replaces it first). */
  private async use<T extends object>(pdf: string, wait: Wait, act: (path: string) => Promise<T>): Promise<(T & Meta) | { problem: string }> {
    const got = await this.text(pdf, wait);
    if ('problem' in got) return got;
    this.reading.set(got.path, (this.reading.get(got.path) ?? 0) + 1);
    try {
      const value = await act(got.path);
      if ((await readMeta(got.path))?.version !== got.meta.version) return { problem: 'its text changed while it was read' };
      return { ...value, version: got.meta.version, pageStarts: got.meta.pageStarts, generated: got.meta.generated };
    } catch { return { problem: 'its text file could not be read' }; }
    finally {
      const left = (this.reading.get(got.path) ?? 1) - 1;
      if (left) this.reading.set(got.path, left); else this.reading.delete(got.path);
    }
  }

  /**
   * The PDFs of these roots (a bounded walk that skips what the search skips), each extracted if needed, waiting at most
   * `waitMs` in all and not past `signal`. With `view`, that folder is made afresh and holds the validated text of exactly
   * these PDFs, at <view>/<rootId>/<path in the root>.txt; text files of PDFs that are gone are removed from the cache.
   */
  async prepare(roots: Material[], options: Wait & { view?: string } = {}): Promise<PdfRoot[]> {
    const deadline = Date.now() + (options.waitMs ?? Infinity);
    const wait = () => ({ waitMs: deadline - Date.now(), signal: options.signal });
    if (options.view) { await rm(options.view, { recursive: true, force: true }); await mkdir(options.view, { recursive: true, mode: 0o700 }); }
    const out: PdfRoot[] = [];
    for (const root of roots) {
      if (options.signal?.aborted) break;
      const path = await realpath(root.path).catch(() => root.path);
      const files = root.kind === 'file' ? (isPdf(path) ? [path] : []) : await pdfsIn(path);
      if (root.kind === 'folder') await this.prune(this.mirror(path));
      if (!files.length) continue;
      const name = (pdf: string) => root.kind === 'folder' ? relative(path, pdf) : basename(pdf);
      const outcomes = await Promise.all(files.map(pdf => options.view ? this.publish(pdf, join(options.view, root.id, `${name(pdf)}.txt`), wait()) : this.text(pdf, wait())));
      const missing = outcomes.flatMap((o, i) => 'problem' in o ? [{ file: name(files[i]), problem: o.problem }] : []);
      const text = options.view ? join(options.view, root.id, ...(root.kind === 'file' ? [`${basename(path)}.txt`] : [])) : root.kind === 'folder' ? this.mirror(path) : this.textPath(path);
      const copied = options.view ? outcomes.flatMap((o, i) => 'meta' in o ? [{ file: name(files[i]), ...o.meta }] : []) : undefined;
      out.push({ rootId: root.id, text, ready: files.length - missing.length, missing, ...(copied ? { files: copied } : {}) });
    }
    return out;
  }
  /** Extracts every PDF of these roots in the background (after a root is attached, and at startup). */
  warm(roots: Material[]) {
    void this.prepare(roots, { waitMs: 0 }).catch(error => this.log(`PDF text: ${(error as Error).message}`));
  }
  /** Server shutdown: nothing new starts, a running extraction is stopped, and this waits until the extractor work is over. */
  async close() {
    this.closed = true;
    for (const child of this.children) child.kill('SIGKILL');
    await this.chain;
  }

  private async versionOf(pdf: string): Promise<{ version: string } | { problem: string }> {
    try {
      const info = await stat(pdf);
      if (!info.isFile()) return { problem: 'not a file' };
      if (info.size > this.options.maxBytes) return { problem: `larger than ${Math.round(this.options.maxBytes / 1024 / 1024)} MB` };
      return { version: `${FORMAT}:${info.size}:${info.mtimeMs}` };
    } catch { return { problem: 'not found' }; }
  }
  /** Extracts the PDF; its size and time are checked before and after, and a PDF that changed meanwhile is read once more. */
  private async extract(pdf: string, path: string): Promise<Outcome> {
    const name = basename(pdf);
    let version = '';
    try {
      for (let attempt = 0; ; attempt++) {
        const before = await this.versionOf(pdf);
        if ('problem' in before) return before;
        version = before.version;
        const binary = this.options.extractor ?? await this.binary();
        const raw = await this.run(binary, [pdf, String(this.options.maxPages), String(this.options.maxChars)], this.options.timeoutMs, this.options.maxChars * 4 + 1_000_000);
        const after = await this.versionOf(pdf);
        if ('problem' in after) return after;
        if (after.version !== version) {
          if (attempt) return { problem: 'the PDF kept changing while it was read' };
          continue;
        }
        const { pageCount, pages } = JSON.parse(raw) as { pageCount: number; pages: string[] };
        if (!pages.some(page => page.trim())) throw new Error('no text layer (a scanned PDF?)');
        const made = formatText(name, pageCount, pages);
        const meta: Meta = { version, pageStarts: made.pageStarts, generated: made.generated };
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${randomUUID()}.tmp`;
        await writeFile(tmp, made.text, { mode: 0o600 });
        // The old version's key goes first and the new one comes last: a text file is taken as current only with its own key.
        await rm(keyPath(path), { force: true });
        await rename(tmp, path);
        await writeFile(`${keyPath(path)}.tmp`, JSON.stringify(meta), { mode: 0o600 });
        await rename(`${keyPath(path)}.tmp`, keyPath(path));
        return { path, meta };
      }
    } catch (error) {
      const problem = (error as Error).message.slice(0, 200) || 'extraction failed';
      if (this.closed) return { problem: 'the app is closing' };
      if (error instanceof ToolError) return { problem };
      this.failed.set(`${pdf}\n${version}`, problem);
      this.log(`PDF text: ${name} could not be extracted: ${problem}`);
      return { problem };
    }
  }
  /** The extractor, compiled once per version of its source into the data folder; a failed build is retried after a while. */
  private binary(): Promise<string> {
    if (this.buildFailed && Date.now() - this.buildFailed.at < this.options.rebuildAfterMs) return Promise.reject(new ToolError(this.buildFailed.message));
    this.compiled ??= (async () => {
      const source = await readFile(SOURCE);
      const bin = join(this.folder, '.bin', `pdf-text-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`);
      if (await exists(bin)) return bin;
      await mkdir(dirname(bin), { recursive: true, mode: 0o700 });
      const tmp = `${bin}.${randomUUID()}.tmp`;
      await this.run('swiftc', ['-O', '-o', tmp, SOURCE], 180_000, 1_000_000);
      await rename(tmp, bin);
      return bin;
    })().catch(error => {
      const message = `the PDF text tool could not be built (${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'swiftc was not found: install the Xcode command line tools' : (error as Error).message})`;
      this.compiled = null;
      if (!this.closed) { this.buildFailed = { at: Date.now(), message }; this.log(`PDF text: ${message}`); }
      throw new ToolError(message);
    });
    return this.compiled;
  }
  /** Runs a program with a time limit and an output limit; rejects with its error text. Never starts after shutdown. */
  private run(command: string, args: string[], timeoutMs: number, maxBytes: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error('the app is closing'));
    return new Promise((done, fail) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      const out: Buffer[] = [];
      let bytes = 0, err = '', reason = '';
      const timer = setTimeout(() => { reason = `took longer than ${Math.round(timeoutMs / 1000)} s`; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout!.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > maxBytes) { reason = 'its output was too large'; child.kill('SIGKILL'); } else out.push(part);
      });
      child.stderr!.on('data', part => { err = (err + part).slice(-500); });
      child.on('error', error => { clearTimeout(timer); this.children.delete(child); fail(error); });
      child.on('close', code => {
        clearTimeout(timer);
        this.children.delete(child);
        if (code === 0 && !reason) done(Buffer.concat(out).toString('utf8'));
        // The last line is the program's own message (PDFKit may log a CoreGraphics notice before it).
        else fail(new Error(reason || err.trim().split('\n').at(-1) || `exit ${code}`));
      });
    });
  }
  /**
   * Removes text files (and keys) in a cache folder whose PDF is gone (only "no such file": an unreadable PDF keeps its
   * text), unless that PDF is being extracted or its text is being read. Bounded like the walk.
   */
  private async prune(mirror: string) {
    let visited = 0;
    const walk = async (folder: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > 2_000 || depth > 8) return;
        const path = join(folder, entry.name);
        const pdf = entry.isFile() && entry.name.endsWith('.txt') ? this.pdfOf(path) : null;
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (pdf && !this.pending.has(pdf) && !this.reading.has(path) && await stat(pdf).then(() => false, error => error.code === 'ENOENT')) {
          await rm(keyPath(path), { force: true });
          await rm(path, { force: true });
        }
      }
    };
    await walk(mirror, 0);
  }
}

/** A text file's metadata sits beside it as a hidden file, which Pi's grep skips. */
const keyPath = (path: string) => join(dirname(path), `.${basename(path)}.key`);
const exists = (path: string) => stat(path).then(s => s.isFile(), () => false);
async function readMeta(path: string): Promise<Meta | null> {
  try { const meta = JSON.parse(await readFile(keyPath(path), 'utf8')); return typeof meta?.version === 'string' ? meta : null; } catch { return null; }
}
/** The work's outcome, or a problem once `waitMs` has passed or `signal` aborted; the work itself goes on. */
function bounded(work: Promise<Outcome>, { waitMs = Infinity, signal }: Wait): Promise<Outcome> {
  if (signal?.aborted) return Promise.resolve({ problem: 'cancelled' });
  if (waitMs === Infinity && !signal) return work;
  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  const late = new Promise<Outcome>(done => {
    if (waitMs !== Infinity) timer = setTimeout(() => done({ problem: 'its text is still being extracted' }), Math.max(0, waitMs));
    onAbort = () => done({ problem: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, late]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
}

/** The PDFs in a folder root: real files inside it, no symlinks or excluded names, at most 200 PDFs in 2,000 entries. */
async function pdfsIn(folder: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > 2_000 || found.length >= 200 || depth > 8) return;
      if (entry.isSymbolicLink() || excluded(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && isPdf(entry.name)) found.push(await realpath(child).catch(() => child));
    }
  };
  await walk(folder, 0);
  return found;
}

/**
 * The text file: a header line, then each page after a marker line ("--- page 3 of 12 ---"), so Pi can locate a quote.
 * A line of the PDF that looks like a marker is escaped. LaTeX accents that PDFKit gives as a separate mark before the
 * letter ("pr´esident") are put back on it ("président").
 */
export function formatText(name: string, pageCount: number, pages: string[]): { text: string; pageStarts: number[]; generated: number[] } {
  const ACCENTS: Record<string, string> = { '´': '́', '`': '̀', '¨': '̈', 'ˆ': '̂', '˜': '̃', '¸': '̧', 'ˇ': '̌', '˚': '̊' };
  const clean = (page: string) => page.replace(/\r\n?/g, '\n').replace(/[\f\0]/g, '').replace(/([´`¨ˆ˜¸ˇ˚])(\p{L})/gu, (_, mark, letter) => (letter + ACCENTS[mark]).normalize('NFC'))
    .split('\n').map(line => PAGE_LINE.test(line) ? `\\${line}` : line);
  // The name is written as JSON, so a line break or other control character in it cannot add a line.
  const lines = [`[Text of the PDF ${JSON.stringify(name)} (${pageCount} pages), extracted by the app. Cite the PDF with this file's line numbers.]`];
  const generated = [1], pageStarts: number[] = [];
  pages.forEach((page, i) => {
    lines.push(`--- page ${i + 1} of ${pageCount} ---`);
    pageStarts.push(lines.length);
    generated.push(lines.length);
    lines.push(...clean(page));
  });
  if (pages.length < pageCount) { lines.push(`[The text stops after page ${pages.length} of ${pageCount}: the size limit was reached.]`); generated.push(lines.length); }
  return { text: lines.join('\n'), pageStarts, generated };
}
/** The page a line of a text file is on (1-based line numbers), from the page lines kept beside it; null before page 1. */
export function pageAt(pageStarts: number[], line: number): number | null {
  let page = 0;
  while (page < pageStarts.length && pageStarts[page] <= line) page++;
  return page || null;
}

/**
 * PDF text as one token stream that keeps each token's place. A word hyphenated across a line break ("stor-\nage"), after
 * a soft hyphen, or as "stor- age" (wrapped text a model may copy) is one token that matches either reading: the joined
 * word ("storage") or the hyphenated one ("stor-age"), so "well-\nlabelled" still matches "well-labelled". A hyphen
 * with no space after it (an operator in "x-y") is kept as it is, and a minus sign ("x − y") is never a word break.
 */
type Token = {
  forms: string[][]; start: number; end: number;
  /** A word broken across a line ("un-" / "packed"): its part before the break, and where that part ends (after the hyphen). */
  head?: string[]; headEnd?: number;
};
const TOKEN = /[\p{L}\p{N}]+(?:['.,][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}.,;:?"'…]/gu;
function pdfTokens(text: string): Token[] {
  // Character for character, as tokens() maps them, so the places stay those of the text.
  const plain = text.replace(/[‘’ʼ`]/g, "'").replace(/[‒–—−]/g, '-');
  const raw = [...plain.matchAll(TOKEN)].map(m => ({ s: m[0], start: m.index!, end: m.index! + m[0].length }));
  const out: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const [a, hyphen, b] = [raw[i], raw[i + 1], raw[i + 2]];
    // The glyph as written, not as folded: only a hyphen or a soft hyphen breaks a word.
    const glyph = hyphen ? text[hyphen.start] : '';
    const soft = glyph === '\u00AD';
    const broken = b && hyphen.start === a.end && /\p{L}$/u.test(a.s) && /^\p{L}/u.test(b.s)
      && (soft || /^[-‐‑]$/.test(glyph)) && (soft ? /^\s*$/ : /^\s+$/).test(text.slice(hyphen.end, b.start));
    if (broken) { out.push({ forms: [tokens(a.s + b.s), [...tokens(a.s), '-', ...tokens(b.s)]], start: a.start, end: b.end, head: tokens(a.s), headEnd: hyphen.end }); i += 2; continue; }
    if (a.s === '\u00AD') continue;
    const form = tokens(a.s);
    if (form.length) out.push({ forms: [form], start: a.start, end: a.end });
  }
  return out;
}
/**
 * A quote's readings for matching PDF text: a wrapped word in it ("stor- age", "stor-\nage", a soft hyphen) is read
 * both ways, as in the text, so a quote copied with a wrap still matches the word written whole. At most 16 readings.
 */
export function quoteReadings(quote: string): string[][] {
  let readings: string[][] = [[]];
  for (const token of pdfTokens(quote)) {
    const forms = readings.length * token.forms.length > 16 ? token.forms.slice(0, 1) : token.forms;
    readings = readings.flatMap(reading => forms.map(form => [...reading, ...form]));
  }
  return readings;
}
/**
 * The smallest span of lines from..to (1-based) of PDF text that contains the quote as whole tokens, or null. The app's own
 * lines (`generated`: header, page markers) are left out, so they are never evidence and a quote may run across a page break.
 * A quote may end on a word broken across a line, copied up to its break with the hyphen ("… is un-" for "un-" / "packed");
 * the span then ends at the break. Anywhere else, half a word is not a quote.
 */
export function pdfQuoteSpan(lines: string[], generated: Set<number>, from: number, to: number, readings: string[][]): [number, number] | null {
  const starts: { offset: number; line: number }[] = [];
  let text = '';
  for (let line = from; line <= to; line++) {
    if (generated.has(line)) continue;
    starts.push({ offset: text.length, line });
    text += `${lines[line - 1]}\n`;
  }
  const lineOf = (offset: number) => { let i = 0; while (i + 1 < starts.length && starts[i + 1].offset <= offset) i++; return starts[i].line; };
  const toks = pdfTokens(text);
  // Consumes the quote from token i on; a token is matched whole in one of its readings, or, as the quote's last words, up to
  // its break. Returns where the match ends in the text (exclusive), or -1.
  const end = (quote: string[], i: number, j: number): number => {
    if (j === quote.length) return toks[i - 1].end;
    if (i >= toks.length) return -1;
    const token = toks[i];
    for (const form of token.forms) {
      if (form.every((t, k) => quote[j + k] === t)) { const e = end(quote, i + 1, j + form.length); if (e >= 0) return e; }
    }
    const head = token.head;
    if (head && quote.length - j === head.length + 1 && quote[quote.length - 1] === '-' && head.every((t, k) => quote[j + k] === t)) return token.headEnd!;
    return -1;
  };
  let best: [number, number] | null = null;
  for (const quote of readings) for (let i = 0; quote.length && i < toks.length; i++) {
    const e = end(quote, i, 0);
    if (e < 0) continue;
    const span: [number, number] = [lineOf(toks[i].start), lineOf(e - 1)];
    if (!best || span[1] - span[0] < best[1] - best[0]) best = span;
  }
  return best;
}
/**
 * The search's view of a line or two of PDF text, or of a query: whitespace runs as one space, soft hyphens dropped, and a
 * hyphen followed by a line break or space read both ways (joined and kept), so "storage" and "well-labelled" are found
 * across a break, and a query copied with a wrap ("stor- age") finds the word written whole. A minus sign is left alone.
 */
export function searchForms(text: string): string[] {
  const plain = text.replace(/\u00AD\s*/g, '').toLowerCase();
  return [plain.replace(/(\p{L})[-‐‑]\s+(?=\p{L})/gu, '$1'), plain.replace(/(\p{L})([-‐‑])\s+(?=\p{L})/gu, '$1$2')].map(t => t.replace(/\s+/g, ' '));
}
