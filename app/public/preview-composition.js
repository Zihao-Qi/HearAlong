// Display-only timing. Nothing here is persisted or passed to a model.
import { paragraphsOf } from './live-shared.js';
/** Token text is detokenized by the binding (leading spaces mark word boundaries).
 * Keep a whole whitespace-delimited word together, including punctuation, at the union of its token times.
 * `words` are on the meeting clock; tokens are on the stream clock. */
export function timedWords(tokens, startMs = 0) {
  const words = [];
  for (const token of tokens) {
    if (!Number.isFinite(token.t0Ms) || !Number.isFinite(token.t1Ms) || token.t0Ms < 0 || token.t1Ms < token.t0Ms) continue;
    for (const part of token.text.match(/\s+|\S+/g) ?? []) {
      if (/^\s+$/.test(part)) { if (words.length) words.at(-1).complete = true; continue; }
      let word = words.at(-1);
      if (!word || word.complete) {
        word = { text: '', startMs: startMs + token.t0Ms, endMs: startMs + token.t1Ms, complete: false };
        words.push(word);
      }
      word.text += part;
      word.startMs = Math.min(word.startMs, startMs + token.t0Ms);
      word.endMs = Math.max(word.endMs, startMs + token.t1Ms);
    }
  }
  return words.map(({ complete, ...word }) => word);
}
export const midpoint = word => (word.startMs + word.endMs) / 2;
/** Nonempty intervals are half-open; an accepted zero-duration word owns its exact point. */
export const coversTime = (span, at) => span.startMs === span.endMs ? at === span.startMs : at >= span.startMs && at < span.endMs;
export const overlapsTime = (a, b) => a.startMs === a.endMs ? coversTime(b, a.startMs)
  : b.startMs === b.endMs ? coversTime(a, b.startMs) : a.startMs < b.endMs && b.startMs < a.endMs;
const covers = (preview, at) => at >= preview.windowStartMs && (at < (preview.committedUntilMs ?? preview.coveredUntilMs)
  || preview.words.some(w => coversTime(w, at)));

/** Per-source, interval ownership: final > active coverage > newest pending coverage.
 * Terminal chunks and committed audio retire pending words irreversibly; tentative masking is recomputed on every hypothesis.
 * A word straddling a boundary belongs to the interval containing its midpoint, never both intervals.
 * The before-cut row keeps its chunk's place; the tail is ordered by its first surviving word. */
export function composePreview(drafts = [], pending = [], finals = []) {
  const active = drafts.map(d => ({ ...d, kind: 'active', key: `active:${d.window}` }));
  const waiting = pending.map(p => ({ ...p, kind: 'pending', key: `pending:${p.chunkId}` }));
  const bySource = new Map();
  // Resolve ownership first. Display grouping must never turn a tentative suffix into permanent coverage.
  for (const block of [...waiting, ...active]) for (const word of block.words ?? []) {
    const at = midpoint(word);
    if (block.kind === 'pending' && (active.some(a => a.source === block.source && covers(a, at))
      || waiting.some(p => p !== block && p.source === block.source && p.windowStartMs > block.windowStartMs && covers(p, at)))) continue;
    if (!bySource.has(block.source)) bySource.set(block.source, []);
    bySource.get(block.source).push({ row: block, word, before: block.kind === 'pending' && at < block.cutMs });
  }
  const before = [], post = [];
  for (const entries of bySource.values()) {
    entries.sort((a, b) => a.word.startMs - b.word.startMs || a.row.key.localeCompare(b.row.key));
    const used = new Set();
    let previous, run;
    for (const entry of entries) {
      const { row, word } = entry;
      if (!entry.before) { post.push(entry); previous = null; continue; }
      if (previous !== row) {
        run = { ...row, part: 'before', key: used.has(row.key) ? `${row.key}:at:${word.startMs}` : row.key,
          words: [], startMs: word.startMs, endMs: word.endMs };
        before.push(run); used.add(row.key); previous = row;
      }
      run.words.push(word); run.endMs = Math.max(run.endMs, word.endMs);
    }
  }
  const chunkKey = s => s.id?.includes(':') ? s.id.slice(0, s.id.lastIndexOf(':')) : s.id ?? `${s.source}:${s.startMs}`;
  const orderedFinals = [...finals].sort(compareDisplayOrder);
  const last = new Map(orderedFinals.map(s => [chunkKey(s), s]));
  // The last final of a chunk and its before-cut placeholder have the same boundary identity.
  // Thus replay advances and the final handoff do not replace the post-cut DOM node.
  const barriers = [
    ...orderedFinals.map(s => ({ ...s, key: last.get(chunkKey(s)) === s ? `chunk:${chunkKey(s)}` : `final:${s.id}` })),
    ...before.map(r => ({ ...r, key: r.key === `pending:${r.chunkId}` ? `chunk:${r.chunkId}` : r.key })),
  ].sort(compareDisplayOrder);
  const postRuns = new Map();
  for (const { row, word } of post) {
    const boundary = barriers.findLast(b => b.startMs <= word.startMs);
    const key = `post:${row.source}:after:${boundary?.key ?? 'start'}`;
    let run = postRuns.get(key);
    if (!run) {
      // 'active' denotes the display lane, not the recognizer: it also holds unreplayed pending tail words after Stop.
      run = { ...row, kind: 'active', part: 'post', key, window: key, boundaryStartMs: boundary?.startMs ?? -Infinity, words: [], behind: false,
        startMs: word.startMs, endMs: word.endMs };
      postRuns.set(key, run);
    }
    run.words.push(word); run.behind ||= row.behind;
    run.endMs = Math.max(run.endMs, word.endMs);
  }
  const runs = [...before, ...postRuns.values()];
  for (const run of runs) run.text = run.words.map(w => w.text).join(' ');
  return runs.sort((a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
}

/** Same composition for the mini view, including finals when no live preview has yet replaced them. */
function newest(source, finals, drafts, pending, limit) {
  const pieces = [
    ...finals.filter(s => s.source === source).map(s => ({ startMs: s.startMs, text: s.text, final: true, key: null })),
    ...composePreview(drafts, pending, finals).filter(p => p.source === source).flatMap(p => p.words.map(w => ({ ...w, final: false, key: p.key }))),
  ].sort((a, b) => a.startMs - b.startMs);
  return pieces.flatMap(p => p.text.split(/\s+/).filter(Boolean).map(text => ({ text, final: p.final, key: p.key }))).slice(-limit);
}
export function newestWords(source, finals, drafts, pending, limit = 20) {
  return newest(source, finals, drafts, pending, limit).map(w => w.text).join(' ');
}
/** One total order for mini line grouping, pending insertion and equal-time placements: finals first, then source/key. */
export function compareDisplayOrder(a, b) {
  return a.startMs - b.startMs || Number(a.kind === 'pending') - Number(b.kind === 'pending')
    || (a.source ?? '').localeCompare(b.source ?? '') || (a.key ?? a.id ?? '').localeCompare(b.key ?? b.id ?? '');
}
/** Pending stretches preceding the newest final belong inside the log, not after it in a preview slot. */
export function miniPendingRows(finals, drafts, pending) {
  const last = [...finals].sort(compareDisplayOrder).at(-1);
  return last ? composePreview(drafts, pending, finals).filter(p => p.part === 'before' && compareDisplayOrder(p, last) < 0) : [];
}
/** Insert pending markers before grouping finals, then use that identical order to assign their paragraph anchors. */
export function miniLog(finals, drafts, pending) {
  const pendingRows = miniPendingRows(finals, drafts, pending);
  const ordered = [...finals.map(s => ({ ...s, kind: 'final' })), ...pendingRows].sort(compareDisplayOrder);
  const paragraphs = [];
  let run = [];
  for (const row of ordered) {
    if (row.kind === 'pending') { paragraphs.push(...paragraphsOf(run)); run = []; }
    else run.push(row);
  }
  paragraphs.push(...paragraphsOf(run));
  const placements = pendingRows.map(p => ({ key: p.key, chunkId: p.chunkId, source: p.source, startMs: p.startMs,
    text: p.text, speaker: p.speaker ?? null, beforeKey: paragraphs.find(f => compareDisplayOrder(p, f.segments[0]) < 0)?.key ?? null }));
  return { paragraphs, placements };
}
/** Budget from the same newest 20, excluding only pending rows that have a log placement. */
export function miniPreviewWords(source, finals, drafts, pending, limit = 20, placed = miniPendingRows(finals, drafts, pending)) {
  const inLog = new Set(placed.map(p => p.key));
  return composePreview(drafts, pending, finals).filter(p => p.source === source && !inLog.has(p.key))
    .flatMap(p => p.words).sort((a, b) => a.startMs - b.startMs)
    .flatMap(w => w.text.split(/\s+/).filter(Boolean)).slice(-limit).join(' ');
}
