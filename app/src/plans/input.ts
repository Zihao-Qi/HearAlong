// The plan pass's input file (M7b §2, §2b "Size budgets"): the meeting's notes with N-numbers, the transcript lines they cite
// with S-numbers, the project's memory (its open items and brief) and the material map, each root with a short id (R1, R2…).
// Only the meeting's own notes, items and cited lines go in. The input is data the model reads; the rules are in the prompt.
import { mergeGaps, clock as clockOf, type NotesRecord, type NoteItem } from '../notes.ts';
import type { Item } from '../memory.ts';
import type { Material } from '../materials.ts';
import type { PdfRoot } from '../pdf-text.ts';
import { entriesOf, type CheckedPlan, type EvidenceEntry, type Registry } from './validate.ts';

/** About 200 KB in all; above it the oldest memory items are left out first, and then the run is refused. */
export const INPUT_LIMIT = 200_000;
export const TOO_LONG = 'This meeting is too long to plan';

/** A material root as the run sees it: its short id in the input and in citations (`R1`), and the root itself. */
export type RootRef = { ref: string; id: string; path: string; kind: 'file' | 'folder'; label: string };
export type NoteSection = 'openQuestions' | 'actions' | 'decisions' | 'summary';
/** A note item by its number in the input. `owner` is the notes' verified owner only (notes.ts checks it against the lines). */
export type NoteRef = { ref: string; section: NoteSection; index: number; text: string; owner: string | null; cites: string[] };
/** A cited transcript line by its number in the input, as the notes pinned it. */
export type LineRef = { ref: string; segmentId: string; startMs: number; text: string; originalText: string };
export type InputRefs = { notes: NoteRef[]; lines: LineRef[]; roots: RootRef[] };
export type PlanInput = {
  text: string; bytes: number; refs: InputRefs;
  /** What the run must say about its input: memory items left out to fit. */
  warnings: string[]; omitted: { items: number; brief: boolean };
};
export type NotesLike = Pick<NotesRecord, 'notes' | 'sources'> & { title?: string };
export type MemoryInput = { brief: string | null; items: Item[] };

/** The order the notes are numbered in: what the plans answer first. */
const SECTIONS: [NoteSection, string][] = [['openQuestions', 'Open questions'], ['actions', 'Action items'], ['decisions', 'Decisions'], ['summary', 'Summary']];
const OPEN = new Set(['open', 'in force']);
const TYPE: Record<Item['type'], string> = { todo: 'to-do', decision: 'decision', question: 'question' };

/** Short ids for the roots that apply to the meeting, in their order. */
export function planRoots(roots: Material[]): RootRef[] {
  return roots.map((root, i) => ({ ref: `R${i + 1}`, id: root.id, path: root.path, kind: root.kind, label: root.label }));
}

/** The notes' own warnings, kept with the plans made from them (coverage, and notes older than the transcript). */
export function notesWarnings(record: Pick<NotesRecord, 'input'>, stale = false): string[] {
  const coverage = record.input.coverage;
  return [
    stale ? 'The transcript changed after the notes were written.' : null,
    coverage.pendingChunks ? `${coverage.pendingChunks} audio chunk(s) were still being transcribed when the notes were written.` : null,
    coverage.gaps.length ? `Missing speech: ${mergeGaps(coverage.gaps).map(g => `${clockOf(g.startMs)}–${clockOf(g.endMs)}`).join(', ')}.` : null,
    coverage.uncorrected ? `${coverage.uncorrected} line(s) had not been checked for misheard terms.` : null,
  ].filter((w): w is string => Boolean(w));
}

const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const bytes = (text: string) => Buffer.byteLength(text);

/**
 * The input, or the refusal when it cannot fit. `roots` are the meeting's material roots (or already numbered), `pdfs` where
 * the text of their PDFs is for this run (PdfText.prepare with a view), `memory` the project's memory when the meeting is in one.
 */
export function buildPlanInput(options: { notes: NotesLike; title?: string; roots: (Material | RootRef)[]; pdfs?: PdfRoot[]; memory?: MemoryInput | null; limit?: number }):
  PlanInput | { refused: string; bytes: number } {
  const limit = options.limit ?? INPUT_LIMIT;
  const record = options.notes;
  const roots = options.roots.map((r, i) => 'ref' in r ? r : { ref: `R${i + 1}`, id: r.id, path: r.path, kind: r.kind, label: r.label });
  // The cited lines, numbered in time order.
  const lines: LineRef[] = Object.entries(record.sources).sort((a, b) => a[1].startMs - b[1].startMs || a[0].localeCompare(b[0]))
    .map(([segmentId, s], i) => ({ ref: `S${i + 1}`, segmentId, startMs: s.startMs, text: s.text, originalText: s.originalText }));
  const lineRef = new Map(lines.map(l => [l.segmentId, l.ref]));
  const notes: NoteRef[] = [];
  const noteLines: string[] = [];
  for (const [section, title] of SECTIONS) {
    const list = (record.notes[section] ?? []) as NoteItem[];
    if (!list.length) continue;
    noteLines.push(`## ${title}`);
    list.forEach((item, index) => {
      const ref = `N${notes.length + 1}`;
      const owner = section === 'actions' && item.owner ? item.owner : null;
      notes.push({ ref, section, index, text: item.text, owner, cites: item.cites });
      noteLines.push(`${ref} ${item.text}${owner ? ` (owner: ${owner})` : ''} [cites ${item.cites.map(c => lineRef.get(c)).filter(Boolean).join(', ')}]`);
    });
  }
  const pdfLines = (rootId: string) => (options.pdfs ?? []).filter(p => p.rootId === rootId).flatMap(p => [
    ...(p.ready ? [`  Text of its PDF${p.ready > 1 ? 's' : ''}: ${p.text}`] : []),
    ...(p.missing.length ? [`  No text for: ${p.missing.slice(0, 10).map(m => `${m.file} (${m.problem})`).join('; ')}${p.missing.length > 10 ? `; and ${p.missing.length - 10} more` : ''}`] : []),
  ]);
  const hasPdfs = (options.pdfs ?? []).some(p => p.ready);
  const materials = roots.length ? [
    '# Materials (read-only)',
    'Each root has an id. Cite a file by its root id and its path inside that root ("R1/folder/file.md"; for a root that is one file, "R2/<its name>").',
    ...(hasPdfs ? ['PDF files cannot be read directly: read and grep their text (one .txt per PDF, at the PDF\'s path plus .txt, pages marked "--- page N of M ---"). Cite the PDF itself with the line numbers of its text.'] : []),
    ...roots.flatMap(r => [`${r.ref}: ${r.path} (${r.kind})`, ...pdfLines(r.id)]),
  ] : ['# Materials', 'None attached.'];
  const head = [`# Meeting: ${options.title ?? record.title ?? 'untitled'}`];
  const rest = ['', ...materials, '', '# Notes (N-numbers)', ...noteLines, '', '# Transcript lines the notes cite (S-numbers)',
    ...lines.map(l => `${l.ref} [${clock(l.startMs)}] ${l.text}`)];
  // Project memory: the brief, then the open items in id order. Left out to fit: the least recently changed items first, then the brief.
  const open = (options.memory?.items ?? []).filter(i => OPEN.has(i.status));
  const itemLine = (i: Item) => `- ${i.id} (${TYPE[i.type]}${i.owner ? `, owner: ${i.owner}` : ''}${i.confirmed ? '' : ', unconfirmed'}) ${i.text}`;
  const brief = options.memory?.brief?.trim() || null;
  const memoryBlock = (items: Item[], withBrief: boolean) => options.memory ? ['', '# Project memory (read-only)',
    ...(withBrief && brief ? ['Brief:', brief, ''] : []), ...(items.length ? ['Open items:', ...items.map(itemLine)] : ['No open items.'])] : [];
  const compose = (items: Item[], withBrief: boolean) => [...head, ...rest, ...memoryBlock(items, withBrief)].join('\n');
  const byAge = [...open].sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt);
  const byId = (items: Item[]) => [...items].sort((a, b) => a.type.localeCompare(b.type) || Number(a.id.slice(2)) - Number(b.id.slice(2)));
  let keep = byAge;
  let withBrief = true;
  let text = compose(byId(keep), withBrief);
  if (bytes(text) > limit) {
    // Each item's line is counted once, so leaving items out is linear.
    const without = bytes(compose([], true));
    let size = without + keep.reduce((n, i) => n + bytes(itemLine(i)) + 1, 0);
    let drop = 0;
    while (drop < keep.length && size > limit) size -= bytes(itemLine(keep[drop++])) + 1;
    // The estimate's headings differ by a few bytes from the text's: keep one more item back where it still fits.
    while (drop > 0 && bytes(compose(byId(keep.slice(drop - 1)), true)) <= limit) drop--;
    keep = keep.slice(drop);
    text = compose(byId(keep), withBrief);
    if (bytes(text) > limit) { withBrief = false; text = compose(byId(keep), false); }
  }
  if (bytes(text) > limit) return { refused: TOO_LONG, bytes: bytes(text) };
  const omittedItems = open.length - keep.length;
  const warnings = [
    ...(omittedItems ? [`${omittedItems} older project-memory item${omittedItems > 1 ? 's were' : ' was'} left out to keep the input within ${Math.round(limit / 1000)} KB.`] : []),
    ...(!withBrief && brief ? ['The project brief was left out to keep the input within its size.'] : []),
  ];
  return { text, bytes: bytes(text), refs: { notes, lines, roots }, warnings, omitted: { items: omittedItems, brief: !withBrief && Boolean(brief) } };
}

/**
 * Explore further's addition to the input (M7b §2): the plan to explore as its pass left it, and what that pass found with its
 * sources, so the run knows where to look again. Data the model reads, like the rest of the input: the plan's own words only.
 */
export function exploreInput(plan: CheckedPlan, registry: Registry): string {
  const where = (e: EvidenceEntry) => {
    const s = e.source;
    if (!s) return e.pythonRun ? `quick check ${e.pythonRun} of that run` : 'no source';
    if (s.type === 'transcript') return `transcript: "${s.quote}"`;
    const line = e.result.line ?? (s.type === 'file' ? s.line : null);
    if (s.type === 'file') return `${s.root ? `${s.root}/` : ''}${s.path}${line ? `, line ${line}` : ''}: "${s.quote}"`;
    return `${s.url}: "${s.quote}"`;
  };
  const found = Object.values(entriesOf(plan, registry));
  const next = plan.steps.find(s => s.kind === 'next');
  const f = plan.further;
  return [
    '# The plan to explore further',
    `Question: ${plan.question}`,
    `It came from these notes: ${plan.fromItems.map(i => `"${i.text}"`).join('; ') || plan.from.join(', ')}`,
    ...(plan.answer ? [`Answer so far (${plan.answer.complete ? 'complete' : 'partial'}): ${plan.answer.text}${plan.answer.open ? ` Still open: ${plan.answer.open}` : ''}`] : []),
    ...(next ? [`Next step: ${next.text}`] : []),
    ...plan.steps.filter(s => s.kind === 'follow').map(s => `Then, if ${s.if}: ${s.text}`),
    ...(plan.waitingOn.length ? [`Waiting on: ${plan.waitingOn.join('; ')}`] : []),
    ...(plan.decideAfter.length ? [`Decide after: ${plan.decideAfter.join('; ')}`] : []),
    ...(plan.changeIf ? [`Would change the plan: ${plan.changeIf}`] : []),
    `Further (this run's deliverable): ${f?.what || 'not given'}${f?.why ? ` (${f.why})` : ''}${f?.minutes ? `, estimated at ${f.minutes} min` : ''}`,
    ...(found.length ? ['What the earlier run found (checked in that run; read it again before citing it):',
      ...found.map(e => `- ${e.kind === 'check' ? 'Check' : 'State'}: ${e.text} (${where(e)})${e.result.ok ? '' : ' [did not check out]'}`)] : []),
  ].join('\n');
}
