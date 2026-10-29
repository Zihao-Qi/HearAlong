// Progress is provisional: completed streamed objects are counted, never published as checked content.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { notesDiagnosticsRows, type NotesDiagnostics } from './notes-diagnostics.ts';

/** Scan root-array objects in one pass across arbitrary deltas. Non-JSON preambles are
 * discarded; a fence or an invalid root candidate lets a subsequent payload start afresh.
 */
export class ItemScanner {
  private stack: string[] = [];
  private string = false;
  private escaped = false;
  private token = '';
  private key = '';
  private array = '';
  private object: string | null = null;
  private rootStart = false;
  private ticks = 0;
  private arrays: readonly string[];
  private item: (section: string, value: any) => void;
  constructor(arrays: readonly string[], item: (section: string, value: any) => void) { this.arrays = arrays; this.item = item; }
  private reset() {
    this.stack = []; this.string = false; this.escaped = false; this.token = ''; this.key = ''; this.array = ''; this.object = null; this.rootStart = false;
  }
  push(delta: string) {
    for (const c of delta) {
      // Raw line breaks cannot occur in a JSON string (escaped \n can). Recover from a broken preamble quote.
      if (this.string && (c === '\n' || c === '\r')) this.reset();
      if (!this.string) {
        this.ticks = c === '`' ? this.ticks + 1 : 0;
        if (this.ticks === 3) { this.reset(); continue; }
      }
      if (!this.stack.length) {
        if (c === '{') { this.stack.push(c); this.rootStart = true; }
        continue;
      }
      if (this.rootStart) {
        if (/\s/.test(c)) continue;
        this.rootStart = false;
        if (c !== '"' && c !== '}') { this.reset(); if (c === '{') { this.stack.push(c); this.rootStart = true; } continue; }
      }
      if (this.object !== null) this.object += c;
      if (this.string) {
        this.token += c;
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') {
          this.string = false;
          if (this.stack.length === 1) {
            try { this.key = JSON.parse(this.token); } catch { this.key = ''; }
          }
        }
        continue;
      }
      if (c === '"') { this.string = true; this.token = '"'; continue; }
      if (c === '{' || c === '[') {
        if (c === '[' && this.stack.length === 1) this.array = this.key;
        if (c === '{' && this.stack.length === 2 && this.stack[1] === '[' && this.arrays.includes(this.array)) this.object = '{';
        this.stack.push(c);
      } else if (c === '}' || c === ']') {
        if ((c === '}' ? '{' : '[') !== this.stack.at(-1)) { this.reset(); continue; }
        if (c === '}' && this.stack.length === 3 && this.object !== null) {
          const raw = this.object; this.object = null;
          try { this.item(this.array, JSON.parse(raw)); } catch { /* A malformed item cannot provide progress. */ }
        }
        this.stack.pop();
        if (this.stack.length === 1) this.array = '';
        if (!this.stack.length) this.reset();
      }
    }
  }
}

export function textDelta(event: any): string | null {
  if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') return event.assistantMessageEvent.delta ?? '';
  return event?.type === 'text_delta' ? event.delta ?? '' : null;
}
export type Duration = { ms: number; lines?: number };
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
function durations(value: unknown): Duration[] {
  return Array.isArray(value) ? value.filter((r): r is Duration => r !== null && typeof r === 'object' && !Array.isArray(r) && positive(r.ms) && (r.lines === undefined || positive(r.lines)))
    .map(r => ({ ms: r.ms, ...(r.lines === undefined ? {} : { lines: r.lines }) })).slice(-10) : [];
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : sorted[m - 1] / 2 + sorted[m] / 2; };
/** Rounded estimate in milliseconds, at least one minute; null means there is no usable history. */
export function estimate(rows: Duration[], lines?: number): number | null {
  const valid = durations(rows);
  if (!valid.length) return null;
  let ms = median(valid.map(r => r.ms));
  const counts = valid.flatMap(r => r.lines === undefined ? [] : [r.lines]);
  if (positive(lines) && counts.length) ms *= Math.max(0.5, Math.min(2, lines / median(counts)));
  return Number.isFinite(ms) ? Math.max(60_000, Math.round(ms / 30_000) * 30_000) : null;
}
const queues = new Map<string, Promise<void>>();
export class DurationHistory {
  private path: string;
  constructor(directory: string) { this.path = join(directory, 'job-durations.json'); }
  private async load(): Promise<Record<'notes' | 'plans', Duration[]> & { notesParts: NotesDiagnostics[] }> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      const data = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      return { notes: durations(data.notes), plans: durations(data.plans), notesParts: notesDiagnosticsRows(data.notesParts) };
    } catch { return { notes: [], plans: [], notesParts: [] }; }
  }
  async estimate(kind: 'notes' | 'plans', lines?: number): Promise<number | null> {
    try { return estimate((await this.load())[kind], lines); } catch { return null; }
  }
  async record(kind: 'notes' | 'plans', ms: number, lines?: number) {
    if (!durations([{ ms, lines }]).length) return;
    await this.update(data => { data[kind] = [...data[kind], { ms, ...(lines === undefined ? {} : { lines }) }].slice(-10); });
  }
  /** Separate from successful duration samples: includes failed, cancelled and timed-out jobs. */
  async recordNotesParts(row: NotesDiagnostics) {
    const snapshot = notesDiagnosticsRows([row])[0];
    await this.update(data => { data.notesParts = [...data.notesParts, snapshot].slice(-10); });
  }
  private async update(change: (data: Awaited<ReturnType<DurationHistory['load']>>) => void) {
    const pending = (queues.get(this.path) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const data = await this.load();
      change(data);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      const saved = { notes: data.notes, plans: data.plans, ...(data.notesParts.length ? { notesParts: data.notesParts } : {}) };
      try { await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 }); await rename(tmp, this.path); }
      finally { await rm(tmp, { force: true }).catch(() => {}); }
    });
    queues.set(this.path, pending);
    try { await pending; } finally { if (queues.get(this.path) === pending) queues.delete(this.path); }
  }
}
export type NotesProgress = {
  phase: 'read' | 'write' | 'check'; startedAt: number; lines: number; minutes: number;
  parts: Record<'project' | 'tasks' | 'other', { count: number; done: boolean }>;
  latest: string | null; estimate: number | null;
};
export type PlanProgress = {
  phase: 'notes' | 'materials' | 'write' | 'check'; startedAt: number;
  materials: string[]; files: number; pages: number; checks: number; written: number; latest: string | null;
  expected: number | null; exact?: boolean; questions: number; estimate: number | null;
};
export function planProgress(startedAt: number, questions: number): PlanProgress {
  return { phase: 'notes', startedAt, materials: [], files: 0, pages: 0, checks: 0, written: 0, latest: null,
    expected: questions > 0 ? Math.min(8, questions) : null, questions, estimate: null };
}
export function updatePlanProgress(p: PlanProgress, event: any, scanner: ItemScanner) {
  const delta = textDelta(event);
  if (delta !== null) { p.phase = 'write'; scanner.push(delta); }
  if (event?.type === 'tool_execution_start') {
    if (p.phase === 'notes') p.phase = 'materials';
    if (event.toolName === 'read' || event.toolName === 'grep') {
      const path = event.args?.path ?? event.args?.file;
      if (typeof path === 'string') { const name = basename(path); if (!p.materials.includes(name)) p.materials.push(name); }
    }
  }
  if (event?.type === 'tool_execution_end') {
    if (p.phase === 'notes') p.phase = 'materials';
    if (event.toolName === 'read' || event.toolName === 'grep') p.files++;
    else if (event.toolName === 'fetch_content' || event.toolName === 'get_search_content') p.pages++;
    else if (event.toolName === 'calculate') p.checks++;
  }
}
