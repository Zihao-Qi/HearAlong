// What a plans run's tools returned, kept as the evidence its quotes are checked against (M7b §2b "Evidence is what the tools
// returned"). As each tool result streams in, a compact copy goes to the run's evidence.json, apart from the stream (whose size
// caps may drop details): reads and greps with the lines they returned, fetched pages, calculation calls. Quotes are checked
// against this only: the text Pi actually saw, at the lines its call returned. A result over its cap is saved cut and marked;
// a run over its cap stops saving, and a run whose evidence could not be saved cannot become complete.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { toolResultOf, type ToolResult } from '../pi-task.ts';
import { isPdf, type PdfRoot } from '../pdf-text.ts';
import type { RootRef } from './input.ts';
import { allowedPath, readRoots } from '../../pi-extensions/read-scope.ts';
import type { SearchEntry } from '../../pi-extensions/node-search.ts';

export const EVIDENCE_LIMITS = { resultBytes: 100_000, pageBytes: 50_000, runBytes: 4_000_000 };
/**
 * A PDF's text as Pi read it: its page lines and the app's own lines (never evidence), and the extraction's version, as they
 * were when the run's view was made. `missing`: none were recorded for this text, so none of its quotes count.
 */
export type PdfLines = { version: string | null; pageStarts: number[]; generated: number[]; missing?: true };
/** Lines as returned, from line `from` on (1-based). */
export type LineBlock = { from: number; lines: string[] };
export type MaterialEvidence = {
  id: string; tool: 'read' | 'grep'; call: string;
  /** The root's short id and the path inside it; for a PDF, the PDF's own path (Pi read its text). `abs` is the file read. */
  root: string; path: string; abs: string;
  /** What the call asked for: a read's offset and limit, a grep's pattern and context. */
  requested: Record<string, unknown>;
  blocks: LineBlock[]; hash: string; cut: boolean; pdf?: PdfLines;
  /** Lines a grep returned shortened ("... [truncated]"): only their start was seen. */
  cutLines?: number[];
};
export type WebEvidence = { id: string; tool: 'fetch'; call: string; url: string; title: string; text: string; hash: string; cut: boolean };
export type PythonEvidence = { id: string; tool: 'python'; call: string; run: number | null; script: string; output: string; stderr: string; status: string; ok: boolean; cut: boolean };
export type CalculationEvidence = Omit<PythonEvidence, 'tool'> & { tool: 'calc'; language: 'javascript' };
export type EvidenceItem = MaterialEvidence | WebEvidence | PythonEvidence | CalculationEvidence;
type Unsaved = Omit<MaterialEvidence, 'id'> | Omit<WebEvidence, 'id'> | Omit<PythonEvidence, 'id'> | Omit<CalculationEvidence, 'id'>;
export type EvidenceState = {
  items: number; bytes: number;
  /** Results saved cut (over their own cap), and results not saved at all once the run's cap was reached. */
  cut: number; dropped: number; full: boolean;
  /** The first save that failed; the evidence is then incomplete. */
  error: string | null;
};
export type SavedEvidence = { schema: 1; items: EvidenceItem[]; state: EvidenceState };
/** Where a file Pi read belongs: a root's short id and the path inside it, and for a PDF's text, its page lines. */
export type Located = { root: string; path: string; pdf?: PdfLines };
export type Locate = (absolute: string) => Promise<Located | null>;
/** Authenticates precisely the returned lines kept as evidence, never a later read of the file. */
export type MaterialEligibility = (path: string, blocks: LineBlock[]) => Promise<boolean>;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const size = (text: string) => Buffer.byteLength(text);
const cutTo = (text: string, max: number) => size(text) <= max ? text : Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, '');
export const normUrl = (url: string) => {
  try { const u = new URL(url.trim()); u.hash = ''; for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k); return u.toString().replace(/\/$/, ''); }
  catch { return url.trim().replace(/\/$/, ''); }
};
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
/** A path as Pi's tools resolve it: an "@" prefix dropped, "~" expanded, relative to the task's folder. */
const toolPath = (path: string, cwd: string) => {
  const p = path.replace(/^@/, '');
  return resolve(cwd, p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
};
const real = (path: string) => realpath(path).catch(() => path);

/**
 * Finds what a path Pi read stands for: a file in a material root, or the text of a root's PDF in this run's view of it
 * (<view>/<root id>/<path>.txt), with the page lines recorded when the view was made (`pdfs`, from PdfText.prepare). A PDF
 * text without them is marked `missing`, and none of its quotes count. The shared cache is not this run's view: not material.
 */
export function materialLocator(options: { roots: RootRef[]; view?: string; pdfs?: PdfRoot[] }): Locate {
  let ready: Promise<{ roots: (RootRef & { real: string })[]; view: string | null }> | null = null;
  const prepare = () => ready ??= (async () => ({
    roots: await Promise.all(options.roots.map(async r => ({ ...r, real: await real(r.path) }))),
    view: options.view ? await real(options.view) : null,
  }))();
  const recorded = new Map((options.pdfs ?? []).flatMap(p => (p.files ?? []).map(f => [`${p.rootId}\n${f.file}`, f] as const)));
  const inRoot = (roots: (RootRef & { real: string })[], file: string) => {
    for (const r of roots) {
      if (r.kind === 'file' ? file === r.real : within(r.real, file) && file !== r.real) return { root: r, path: r.kind === 'file' ? basename(r.real) : relative(r.real, file) };
    }
    return null;
  };
  return async absolute => {
    const { roots, view } = await prepare();
    const file = await real(absolute);
    if (view && within(view, file) && file !== view && /\.txt$/i.test(file)) {
      const [id, ...rest] = relative(view, file).split(sep);
      const root = roots.find(r => r.id === id);
      const path = rest.join(sep).slice(0, -4);
      if (!root || !path || (root.kind === 'file' && path !== basename(root.real))) return null;
      const meta = recorded.get(`${root.id}\n${path}`);
      return { root: root.ref, path, pdf: meta ? { version: meta.version, pageStarts: meta.pageStarts, generated: meta.generated } : { version: null, pageStarts: [], generated: [], missing: true } };
    }
    const found = inRoot(roots, file);
    if (!found || isPdf(file)) return null; // a PDF's bytes are not its text
    return { root: found.root.ref, path: found.path };
  };
}

/** A read's returned lines: Pi's own notices ("[Showing lines …]", "[N more lines …]") are not file text. */
function readLines(result: ToolResult): LineBlock | null {
  const args = (result.args ?? {}) as { offset?: unknown };
  const details = (result.details ?? {}) as { truncation?: { truncated?: boolean; firstLineExceedsLimit?: boolean; outputLines?: number } };
  if (result.isError || details.truncation?.firstLineExceedsLimit || /^Read image file \[/.test(result.text)) return null;
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1;
  let text = result.text;
  if (details.truncation?.truncated && typeof details.truncation.outputLines === 'number') {
    return { from: offset, lines: text.split('\n').slice(0, details.truncation.outputLines) };
  }
  text = text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, '');
  return { from: offset, lines: text.split('\n') };
}

/** A grep's output per file: its match lines ("path:12: text") and context lines ("path-11- text"), in order. */
function grepLines(text: string, snapshotLabels?: string[]): { file: string; line: number; text: string; cut: boolean }[] {
  const body = text.replace(/\n\n\[[^\n]*\]$/, '');
  if (body === 'No matches found') return [];
  const rows = body.split('\n');
  if (rows.at(-1) === '') rows.pop();
  const files = new Set<string>();
  for (const row of rows) { const m = /^(.*?):(\d+): /.exec(row); if (m) files.add(m[1]); }
  const labels = snapshotLabels?.slice().sort((a, b) => b.length - a.length);
  const out: { file: string; line: number; text: string; cut: boolean }[] = [];
  for (const row of rows) {
    let found: { file: string; line: number; text: string } | null = null;
    // Longest exact authorized label wins: ':' and '-N-' can legally occur inside a filename.
    for (const file of labels ?? []) {
      if (!row.startsWith(file)) continue;
      const m = /^(?::(\d+): |-(\d+)- )(.*)$/.exec(row.slice(file.length));
      if (m) { found = { file, line: Number(m[1] ?? m[2]), text: m[3] }; break; }
    }
    const match = /^(.*?):(\d+): (.*)$/.exec(row);
    if (!found && match && files.has(match[1])) found = { file: match[1], line: Number(match[2]), text: match[3] };
    if (!found) for (const file of files) {
      if (!row.startsWith(`${file}-`)) continue;
      const m = /^(\d+)- (.*)$/.exec(row.slice(file.length + 1));
      if (m) { found = { file, line: Number(m[1]), text: m[2] }; break; }
    }
    // Reject the whole ambiguous legacy result: a filename newline may have split one record into several.
    if (!found || !found.file || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(found.file)
      || !Number.isSafeInteger(found.line) || found.line < 1) return [];
    if (found.text === '(unable to read file)') continue;
    // Long lines come back cut, marked "... [truncated]": the part shown is all Pi saw of them.
    const cut = found.text.endsWith('... [truncated]');
    out.push({ ...found, text: cut ? found.text.slice(0, -'... [truncated]'.length) : found.text, cut });
  }
  return out;
}
/** Consecutive lines as blocks; a line seen twice keeps its first text. */
function blocksOf(lines: Map<number, string>): LineBlock[] {
  const blocks: LineBlock[] = [];
  for (const n of [...lines.keys()].sort((a, b) => a - b)) {
    const last = blocks.at(-1);
    if (last && last.from + last.lines.length === n) last.lines.push(lines.get(n)!);
    else blocks.push({ from: n, lines: [lines.get(n)!] });
  }
  return blocks;
}
/** Keeps whole lines within `max` bytes; whether any were left out. */
function capBlocks(blocks: LineBlock[], max: number): { blocks: LineBlock[]; cut: boolean; bytes: number } {
  const out: LineBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    const kept: string[] = [];
    for (const line of block.lines) {
      if (used + size(line) + 1 > max) { if (kept.length) out.push({ from: block.from, lines: kept }); return { blocks: out, cut: true, bytes: used }; }
      used += size(line) + 1;
      kept.push(line);
    }
    out.push({ from: block.from, lines: kept });
  }
  return { blocks: out, cut: false, bytes: used };
}
const blockText = (blocks: LineBlock[]) => blocks.map(b => `${b.from}\n${b.lines.join('\n')}`).join('\n');
/** The hash a read or grep's saved lines are kept with (also used to notice a change after the run). */
export const blockHash = (blocks: LineBlock[]) => hash(blockText(blocks));

/**
 * The evidence of one run, saved in its folder as `evidence.json`. Tool results are taken in order (one chain), each turned
 * into items within its caps; the file is rewritten after each, atomically, so a crash keeps what was saved before.
 * Wiring: the run's work passes `onEvent: event => evidence.piEvent(event)` to `ctx.pi`, which hands on every Pi event after
 * its stream log has it; before checking, `await evidence.read()`, and the run may complete only while `complete` holds.
 */
export class EvidenceRecorder {
  readonly folder: string;
  private options: { cwd: string; locate: Locate; eligible?: MaterialEligibility; limits: typeof EVIDENCE_LIMITS };
  private items: EvidenceItem[] = [];
  private status: EvidenceState = { items: 0, bytes: 0, cut: 0, dropped: 0, full: false, error: null };
  private chain: Promise<void> = Promise.resolve();
  private starts = new Map<string, unknown>();
  private next = 0;
  constructor(folder: string, options: { cwd: string; locate: Locate; eligible?: MaterialEligibility; limits?: Partial<typeof EVIDENCE_LIMITS> }) {
    this.folder = folder;
    this.options = { cwd: options.cwd, locate: options.locate, eligible: options.eligible, limits: { ...EVIDENCE_LIMITS, ...options.limits } };
  }
  get state(): Readonly<EvidenceState> { return this.status; }
  /** Everything the run's tools returned was saved (within the per-result caps): the run may become complete. */
  get complete() { return !this.status.error && !this.status.full; }
  /** Takes Pi's JSON events (as ExplorationContext.pi passes them to `onEvent`): a finished tool call is recorded. */
  piEvent(event: any) {
    if (event?.type === 'tool_execution_start') this.starts.set(String(event.toolCallId), event.args);
    else if (event?.type === 'tool_execution_end') {
      const id = String(event.toolCallId);
      void this.record(toolResultOf(event, this.starts.get(id)));
      this.starts.delete(id);
    }
  }
  /**
   * Records one finished tool call; resolves once it is saved (or its save failed: see `state.error`). The call's evidence is
   * kept within resultBytes as written (ids, line numbers and a PDF's page lines included), cut at whole lines or characters;
   * the whole evidence.json within runBytes, or nothing more is saved and the run cannot complete.
   */
  record(result: ToolResult): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.status.error) return;
      let make: ((budget: number) => Unsaved[]) | null;
      try { make = await this.builderOf(result); }
      catch (error) { this.status.error = `Could not read a tool result: ${(error as Error).message}`; return; }
      if (!make) return;
      const cap = this.options.limits.resultBytes;
      const written = (items: Unsaved[]) => size(JSON.stringify(items.map((item, i) => ({ ...item, id: `e${this.next + 1 + i}` }))));
      // Over its cap as written: the longest run of whole items from the start that fits (a grep over many PDFs, whose page
      // lines alone may be large); if not even the first fits whole, the first with its content cut until it does.
      let items = make(cap), over = false;
      if (written(items) > cap) {
        over = true;
        const all = items;
        let keep = 0;
        while (keep < all.length && written(all.slice(0, keep + 1)) <= cap) keep++;
        items = all.slice(0, keep);
        for (let budget = cap, tries = 0; !items.length && budget > 0 && tries < 40; tries++) {
          const first = make(budget).slice(0, 1);
          if (written(first) <= cap) { items = first; break; }
          budget = Math.max(0, budget - (written(first) - cap) - 64);
        }
      }
      // Authenticate after capping: these exact blocks, at these line numbers, are what will be saved.
      // In particular, a queued tool result must never be authenticated using newer bytes on disk.
      if (this.options.eligible) {
        const eligible: Unsaved[] = [];
        try {
          for (const item of items) {
            if ((item.tool !== 'read' && item.tool !== 'grep') || await this.options.eligible(item.abs, item.blocks)) eligible.push(item);
          }
        } catch (error) { this.status.error = `Could not authenticate a tool result: ${(error as Error).message}`; return; }
        items = eligible;
      }
      if (over) items = items.map(i => ({ ...i, cut: true }));
      const cutNow = over || items.some(i => i.cut);
      if (!items.length) { if (over) { this.status.cut++; await this.save(); } return; }
      if (this.status.full) { this.status.dropped++; await this.save(); return; }
      const saved = items.map((item, i) => ({ ...item, id: `e${this.next + 1 + i}` }) as EvidenceItem);
      const state: EvidenceState = { ...this.status, items: this.items.length + saved.length, cut: this.status.cut + (cutNow ? 1 : 0) };
      // The run's cap counts the whole file as written.
      const text = () => JSON.stringify({ schema: 1, items: [...this.items, ...saved], state } satisfies SavedEvidence);
      state.bytes = size(text());
      state.bytes = size(text());
      if (state.bytes > this.options.limits.runBytes) { this.status.full = true; this.status.dropped++; await this.save(); return; }
      this.items.push(...saved);
      this.next += saved.length;
      this.status = state;
      await this.save();
    });
    return this.chain;
  }
  flush() { return this.chain; }
  async read(): Promise<SavedEvidence> { await this.flush(); return { schema: 1, items: this.items.map(i => ({ ...i })), state: { ...this.status } }; }
  static async read(folder: string): Promise<SavedEvidence | null> {
    try { return JSON.parse(await readFile(join(folder, 'evidence.json'), 'utf8')); } catch { return null; }
  }

  private async save() {
    const path = join(this.folder, 'evidence.json');
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ schema: 1, items: this.items, state: this.status } satisfies SavedEvidence), { mode: 0o600 });
      await rename(tmp, path);
    } catch (error) { this.status.error = `Could not save the evidence: ${(error as Error).message}`; }
  }
  /** What a tool call returned that is evidence, as a function of the bytes its content may take; null when nothing is. */
  private async builderOf(r: ToolResult): Promise<((budget: number) => Unsaved[]) | null> {
    const { pageBytes } = this.options.limits;
    const args = (r.args ?? {}) as Record<string, unknown>;
    if (r.name === 'read' && typeof args.path === 'string') {
      const block = readLines(r);
      if (!block) return null;
      const abs = toolPath(args.path, this.options.cwd);
      const at = await this.options.locate(abs);
      if (!at) return null;
      const file = await real(abs);
      return budget => {
        const capped = capBlocks([block], budget);
        return [{ tool: 'read', call: r.id, root: at.root, path: at.path, abs: file, requested: { offset: args.offset ?? null, limit: args.limit ?? null },
          blocks: capped.blocks, hash: blockHash(capped.blocks), cut: capped.cut, ...(at.pdf ? { pdf: at.pdf } : {}) }];
      };
    }
    if (r.name === 'grep' && !r.isError) {
      const base = toolPath(typeof args.path === 'string' ? args.path : '.', this.options.cwd);
      const folder = await stat(base).then(s => s.isDirectory(), () => false);
      const snapshot: unknown = (r.details as { searchFiles?: unknown } | undefined)?.searchFiles;
      const emitted = snapshot === undefined ? undefined : new Map<string, SearchEntry>();
      if (emitted) {
        if (!Array.isArray(snapshot)) return null;
        for (const entry of snapshot) {
          if (!entry || typeof entry.path !== 'string' || entry.directory !== false || typeof entry.identity !== 'string'
            || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(entry.path)) return null;
          emitted.set(entry.path, entry);
        }
      }
      const byFile = new Map<string, { lines: Map<number, string>; cutLines: Set<number> }>();
      const labels = emitted ? [...emitted.keys()].map(path => folder ? relative(base, path).split(sep).join('/') : basename(path)) : undefined;
      for (const row of grepLines(r.text, labels)) {
        const file = byFile.get(row.file) ?? { lines: new Map(), cutLines: new Set() };
        if (!file.lines.has(row.line)) { file.lines.set(row.line, row.text); if (row.cut) file.cutLines.add(row.line); }
        byFile.set(row.file, file);
      }
      const files: { at: Located; abs: string; lines: Map<number, string>; cutLines: Set<number> }[] = [];
      for (const [name, file] of byFile) {
        // A parsed label is not authority. It must name a file within this call's target and its emitted snapshot.
        const abs = folder ? resolve(base, name) : base;
        if (folder ? isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..') || !within(base, abs) || abs === base
          : name !== basename(base) && name !== base) continue;
        if (emitted) {
          if (!emitted.has(abs)) continue;
        } else {
          // Compatibility with old/text-only tools: require an existing regular, scope-allowed target (metadata only).
          try {
            const info = await lstat(abs);
            if (!info.isFile() || info.nlink > 1 || await realpath(abs) !== abs || !allowedPath(abs, this.options.cwd, readRoots([base]))) continue;
          } catch { continue; }
        }
        const at = await this.options.locate(abs);
        if (at) files.push({ at, abs: emitted ? abs : await real(abs), ...file });
      }
      if (!files.length) return null;
      return budget => {
        let left = budget;
        const out: Unsaved[] = [];
        for (const f of files) {
          const capped = capBlocks(blocksOf(f.lines), Math.max(0, left));
          left -= capped.bytes;
          if (!capped.blocks.length) continue;
          const kept = new Set(capped.blocks.flatMap(b => b.lines.map((_, i) => b.from + i)));
          const cutLines = [...f.cutLines].filter(n => kept.has(n));
          out.push({ tool: 'grep', call: r.id, root: f.at.root, path: f.at.path, abs: f.abs, requested: { pattern: args.pattern ?? null, path: args.path ?? null, context: args.context ?? null },
            blocks: capped.blocks, hash: blockHash(capped.blocks), cut: capped.cut || cutLines.length > 0, ...(cutLines.length ? { cutLines } : {}), ...(f.at.pdf ? { pdf: f.at.pdf } : {}) });
        }
        return out;
      };
    }
    if (r.name === 'fetch_content' || r.name === 'get_search_content') {
      const structured = (r.structured ?? {}) as { urls?: { url?: unknown; title?: unknown; content?: unknown; error?: unknown }[] };
      const details = (r.details ?? {}) as { url?: unknown };
      const pages: { url: string; title: string; text: string }[] = [];
      if (r.name === 'fetch_content' && Array.isArray(structured.urls)) {
        for (const u of structured.urls) if (typeof u?.url === 'string' && !u.error) pages.push({ url: u.url, title: String(u.title ?? ''), text: String(u.content ?? '') });
      } else if (!r.isError) {
        // Without structured data only a single page can be attributed.
        const urls = r.name === 'get_search_content' ? [details.url] : [args.url, ...(Array.isArray(args.urls) ? args.urls : [])];
        const named = urls.filter((u): u is string => typeof u === 'string');
        if (named.length === 1) pages.push({ url: named[0], title: '', text: r.text });
      }
      if (!pages.length) return null;
      return budget => {
        let left = budget;
        return pages.map(p => {
          const text = cutTo(p.text, Math.max(0, Math.min(pageBytes, left)));
          left -= size(text);
          return { tool: 'fetch' as const, call: r.id, url: normUrl(p.url), title: p.title.slice(0, 300), text, hash: hash(text), cut: text.length < p.text.length };
        });
      };
    }
    if (r.name === 'calculate' || r.name === 'run_python') {
      const d = (r.details ?? {}) as { runNumber?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown };
      const script = String(args.code ?? ''), output = String(d.stdout ?? r.text), stderr = String(d.stderr ?? '');
      const status = typeof d.status === 'string' ? d.status : r.isError ? 'error' : 'exit 0';
      return budget => {
        const third = Math.floor(budget / 3);
        const kept = { script: cutTo(script, third), output: cutTo(output, third), stderr: cutTo(stderr, third) };
        return [{ ...(r.name === 'calculate' ? { tool: 'calc' as const, language: 'javascript' as const } : { tool: 'python' as const }), call: r.id, run: typeof d.runNumber === 'number' ? d.runNumber : null, ...kept, status, ok: !r.isError && status === 'exit 0',
          cut: kept.script !== script || kept.output !== output || kept.stderr !== stderr }];
      };
    }
    return null;
  }
}
