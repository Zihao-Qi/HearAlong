import { paragraphsOf, stamp } from './live-shared.js';
import { composePreview, coversTime, overlapsTime, midpoint } from './preview-composition.js';
import { captureGapText, mergeCaptureGaps } from './capture-gaps.js';

const chunkOf = id => id.includes(':') ? id.slice(0, id.lastIndexOf(':')) : id;
/** Split only after ownership/composition. Gap boundaries are display barriers, never recognizer or seal boundaries. */
function gapBoundedPreviews(preview, gaps) {
  // A historical gap is not a boundary for an otherwise unrelated M9a lane. Only gaps that split word
  // ownership or clamp a straddling word can change this composed preview's identity/grouping.
  const affected = gaps.filter(g => preview.words.some(w => w.startMs < g.atMs)
    && preview.words.some(w => midpoint(w) >= g.atMs));
  if (!affected.length) return [preview];
  const runs = [];
  let previousGap, run;
  for (const word of preview.words) {
    const gap = affected.findLast(g => g.atMs <= midpoint(word));
    if (!run || gap !== previousGap) {
      // For an actually affected run only, the gap supersedes earlier post-lane boundaries.
      const key = gap && preview.part === 'post' && gap.atMs > preview.boundaryStartMs ? `post:${preview.source}:after:gap:${gap.atMs}`
        : gap && preview.part === 'before' ? `${preview.key}:gap:${gap.atMs}` : preview.key;
      run = { ...preview, key, gapAtMs: gap?.atMs,
        words: [], startMs: Math.max(word.startMs, gap?.atMs ?? -Infinity), endMs: word.endMs };
      runs.push(run); previousGap = gap;
    }
    run.words.push(word); run.endMs = Math.max(run.endMs, word.endMs);
  }
  for (const run of runs) run.text = run.words.map(w => w.text).join(' ');
  return runs;
}
/** Gap clamping can move several composed runs into one slot. Order words before regrouping so another source
 * (including a word inside its preview) is never swallowed by a same-slot merge. Unaffected M9a identities stay untouched. */
function coalesceGapRows(rows) {
  const pieces = rows.flatMap(row => {
    // Explicit provenance from splitting/clamping, not merely the existence of an earlier gap.
    const gapAtMs = row.preview?.gapAtMs;
    if (gapAtMs === undefined) return [{ row, slot: null }];
    return row.preview.words.map(word => {
      const key = `${row.key}:at:${word.startMs}`, startMs = Math.max(word.startMs, gapAtMs);
      return { slot: row.key, row: { ...row, key, startMs, endMs: word.endMs,
        preview: { ...row.preview, key, startMs, endMs: word.endMs, words: [word] } } };
    });
  });
  pieces.sort((a, b) => a.row.startMs - b.row.startMs || Number(b.row.kind === 'gap') - Number(a.row.kind === 'gap')
    || (a.slot && b.slot ? a.row.preview.words[0].startMs - b.row.preview.words[0].startMs : 0) || compareRows(a.row, b.row));
  const runs = [];
  for (const piece of pieces) {
    const last = runs.at(-1);
    if (piece.slot && last?.slot === piece.slot && last.row.preview.source === piece.row.preview.source) {
      last.row.preview.words.push(...piece.row.preview.words);
      last.row.endMs = last.row.preview.endMs = Math.max(last.row.endMs, piece.row.endMs);
      last.row.behind = last.row.preview.behind ||= piece.row.preview.behind;
    } else runs.push(piece);
  }
  for (const { row, slot } of runs) if (slot) row.text = row.preview.text = row.preview.words.map(w => w.text).join(' ');
  return runs.map(p => p.row);
}
/** Chunk boundaries are display boundaries: the pending row and its first final paragraph share one key. */
export function transcriptRows(snapshot) {
  const rows = [], groups = [];
  const gaps = mergeCaptureGaps(snapshot.captureGaps ?? []);
  for (const segment of snapshot.segments ?? []) {
    const chunkId = chunkOf(segment.id);
    const band = gaps.filter(g => g.atMs <= segment.startMs).length;
    if (groups.at(-1)?.chunkId !== chunkId || groups.at(-1)?.band !== band) groups.push({ chunkId, band, segments: [] });
    groups.at(-1).segments.push(segment);
  }
  const seen = new Set();
  for (const group of groups) for (const p of paragraphsOf(group.segments)) {
    const first = !seen.has(group.chunkId);
    rows.push({ ...p, key: first ? `chunk:${group.chunkId}` : `final:${p.key}`, chunkId: group.chunkId, kind: 'final' });
    seen.add(group.chunkId);
  }
  for (const composed of composePreview(snapshot.drafts, snapshot.pending, snapshot.segments)) for (const preview of gapBoundedPreviews(composed, gaps)) {
    rows.push({ ...preview, key: preview.part === 'before' && preview.key === `pending:${preview.chunkId}` ? `chunk:${preview.chunkId}` : preview.key,
      segments: [], preview, speaker: snapshot.labelled ? preview.speaker : undefined });
  }
  for (const gap of gaps) rows.push({ key: `gap:${gap.fromWallMs}`, kind: 'gap', gap, gapText: captureGapText(gap),
    startMs: gap.atMs, endMs: gap.atMs, segments: [] });
  const ordered = gaps.length ? coalesceGapRows(rows) : rows.sort(compareRows);
  for (const row of ordered) row.signature = JSON.stringify([row.signature, row.preview?.text, row.speaker, row.gapText]);
  return ordered;
}

const compareRows = (a, b) => a.startMs - b.startMs || (Number(b.kind === 'gap') - Number(a.kind === 'gap')) || a.key.localeCompare(b.key);

/** Keyed, synchronous handoffs. A drag holds the render; a lingering selection holds only its intersecting rows. */
export function createTranscriptView(box, { segmentNode, listen = () => {}, changed = () => {}, emptyText = () => 'Waiting for transcribed speech…' }) {
  const view = { paragraphs: new Map(), following: true };
  const displayed = new Map();
  const originalBottom = box.style.paddingBottom, bottom = parseFloat(getComputedStyle(box).paddingBottom);
  let heightFloor = 0, extraBottom = 0;
  const reserveHeight = extra => {
    if (extra === extraBottom) return;
    box.style.paddingBottom = extra ? `${bottom + extra}px` : originalBottom;
    extraBottom = extra;
  };
  let snapshot, down = false, pointer = null, draftDrag = null, setTop = box.scrollTop, selectionAnchor = null;
  let draftNote = null, noteTimer, transcriptSelected = false, heardMs = null, userScrolledAt = 0;
  const selectionRanges = () => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) return [];
    return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)).filter(range => range.intersectsNode(box));
  };
  const selected = () => selectionRanges().length > 0;
  const blocked = () => down || selected();
  const scrollTo = top => { box.scrollTop = top; setTop = box.scrollTop; };
  const visible = () => Boolean(box.offsetParent) && box.clientHeight > 0;
  const atBottom = () => visible() && box.scrollHeight - box.clientHeight - box.scrollTop < 48;
  function anchor() {
    const rect = box.getBoundingClientRect();
    const y = pointer && pointer.y > rect.top && pointer.y < rect.bottom ? pointer.y : rect.top + 12;
    const x = pointer?.x ?? rect.left + Math.min(140, rect.width / 2);
    const caret = document.caretRangeFromPoint?.(x, y);
    if (caret && box.contains(caret.startContainer) && caret.startContainer.nodeType === Node.TEXT_NODE) {
      const range = caret.cloneRange();
      range.setEnd(range.startContainer, Math.min(range.startOffset + 1, range.startContainer.length));
      return { range, y: range.getBoundingClientRect().top };
    }
    const node = [...box.children].find(n => n.getBoundingClientRect().bottom > y);
    return node ? { node, y: node.getBoundingClientRect().top } : null;
  }
  function noteAt(draft, event) {
    const row = displayed.get(draft.closest('.para').dataset.key);
    let index = 0;
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret && draft.contains(caret.startContainer)) {
      const prefix = document.createRange(); prefix.selectNodeContents(draft); prefix.setEnd(caret.startContainer, caret.startOffset);
      const text = prefix.toString();
      index = Math.max(0, text.split(/\s+/).filter(Boolean).length - (/\s$/.test(text) ? 0 : 1));
    }
    const word = row.preview.words[Math.min(index, row.preview.words.length - 1)];
    return { key: row.key, source: row.preview.source, at: (word.startMs + word.endMs) / 2, until: Infinity };
  }
  function syncDraftNote() {
    const showing = draftNote && ((down && draftDrag?.moved && draftDrag.inside)
      || (Number.isFinite(draftNote.until) && Date.now() < draftNote.until));
    let target;
    if (showing) {
      const row = [...displayed.values()].find(r => r.preview?.source === draftNote.source
        && r.preview.words.some(w => coversTime(w, draftNote.at)))
        ?? displayed.get(draftNote.key)
        ?? [...displayed.values()].find(r => r.segments.some(s => (!s.source || s.source === draftNote.source)
          && coversTime(s, draftNote.at)));
      if (row) { draftNote.key = row.key; target = view.paragraphs.get(row.key)?.querySelector('p'); }
    }
    for (const note of box.querySelectorAll('.draft-selection-note')) if (note.parentElement !== target) note.remove();
    if (target && !target.querySelector('.draft-selection-note')) {
      const note = document.createElement('span'); note.className = 'draft-selection-note small';
      note.setAttribute('aria-hidden', 'true');
      note.textContent = 'Still being written: select it in a few seconds'; target.append(note);
    }
  }
  function fill(node, row) {
    const time = document.createElement('time');
    if (row.kind === 'final' && row.segments.length) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'listen-time';
      button.textContent = stamp(row.startMs); button.setAttribute('aria-label', `Listen from ${stamp(row.startMs)}`);
      button.onclick = () => listen(row.startMs); time.append(button);
    } else time.textContent = stamp(row.startMs);
    if (row.speaker) { const who = document.createElement('span'); who.className = 'speaker'; who.textContent = row.speaker; time.append(who); }
    const text = document.createElement('p');
    for (const segment of row.segments) text.append(segmentNode(segment));
    if (row.kind === 'gap') text.textContent = row.gapText;
    if (row.preview) {
      const preview = document.createElement('span');
      preview.className = 'live-draft preview-text';
      preview.setAttribute('aria-hidden', 'true');
      preview.textContent = `${row.segments.length ? ' ' : ''}${row.preview.text}`;
      text.append(preview);
    }
    node.className = `para${row.kind === 'gap' ? ' capture-gap' : ''}${row.speaker === 'Me' ? ' me' : row.speaker === 'Them' ? ' them' : ''}`;
    node.setAttribute('aria-hidden', row.segments.length || row.kind === 'gap' ? 'false' : 'true');
    node.dataset.kind = row.kind;
    node.dataset.ids = row.segments.map(s => s.id).join(' ');
    node.dataset.start = String(row.startMs);
    node.dataset.end = String(row.endMs);
    node.dataset.signature = row.signature;
    node.replaceChildren(time, text);
  }
  function aroundSelection(rows, held) {
    const ids = new Set(held.flatMap(r => r.segments.map(s => s.id)));
    const claims = held.filter(r => r.preview).map(r => r.preview);
    // Protect this composed run's displayed words, not its parent stream's committed interval.
    // A merged post-cut lane may contain words from several owners, each with gaps elsewhere on screen.
    const coversWord = (p, at) => p.words.some(w => coversTime(w, at));
    const owns = (source, at) => claims.some(p => p.source === source && coversWord(p, at));
    const sameSource = (preview, segment) => !segment.source || preview.source === segment.source;
    const chunks = new Set(claims.filter(p => p.part === 'before').map(p => p.chunkId));
    for (const row of rows) for (const segment of row.segments) {
      if (claims.some(p => sameSource(p, segment) && p.words.some(w => overlapsTime(segment, w)))) chunks.add(chunkOf(segment.id));
    }
    const deferred = rows.flatMap(r => r.segments).filter(s => chunks.has(chunkOf(s.id)));
    const heldKeys = new Set(held.map(r => r.key));
    const remaining = [];
    for (const row of rows) {
      if (row.kind === 'gap') {
        // A second source may widen a gap (and change its key) while a spanning selection holds the old row.
        // Keep one immutable notice until release, just as we keep the surrounding selected speech.
        const heldGap = held.some(r => r.gap && r.gap.fromWallMs < row.gap.toWallMs && row.gap.fromWallMs < r.gap.toWallMs);
        if (!heldGap) remaining.push(row);
        continue;
      }
      const segments = row.segments.filter(s => !ids.has(s.id) && !chunks.has(chunkOf(s.id)));
      const words = row.preview?.words.filter(w => !owns(row.preview.source, (w.startMs + w.endMs) / 2));
      if (!segments.length && !words?.length) continue;
      if (segments.length === row.segments.length && (!words || words.length === row.preview.words.length) && !heldKeys.has(row.key)) { remaining.push(row); continue; }
      const preview = words?.length ? { ...row.preview, words, text: words.map(w => w.text).join(' '), startMs: words[0].startMs, endMs: words.at(-1).endMs } : null;
      // Approved selection exception: an immutable held lane gets one temporary growth row.
      // Ordinary reconciliation merges it into that same lane node when the selection clears.
      remaining.push({ ...row, segments, preview,
        key: heldKeys.has(row.key) ? `growth:${row.key}:${segments[0]?.id ?? words[0].startMs}` : row.key,
        startMs: Math.min(...segments.map(s => s.startMs), preview?.startMs ?? Infinity),
        endMs: Math.max(...segments.map(s => s.endMs), preview?.endMs ?? -Infinity),
        signature: JSON.stringify([row.signature, segments.map(s => s.id), preview?.text]) });
    }
    // If a held tail blocks a whole final segment, keep the other, previously visible words of that handoff too.
    // They can still be superseded by a new preview; only the indivisible final waits for the selection to clear.
    for (const old of displayed.values()) if (old.preview && !heldKeys.has(old.key)) {
      const p = old.preview;
      const words = p.words.filter(w => {
        const at = (w.startMs + w.endMs) / 2;
        return !owns(p.source, at) && deferred.some(s => sameSource(p, s) && coversTime(s, at))
          && !remaining.some(r => r.preview?.source === p.source && coversWord(r.preview, at));
      });
      if (words.length) remaining.push({ ...old, key: old.key.startsWith('held-handoff:') ? old.key : `held-handoff:${old.key}`, startMs: words[0].startMs,
        preview: { ...p, words, text: words.map(w => w.text).join(' ') }, signature: JSON.stringify(words) });
    }
    const planned = [...remaining, ...held].sort(compareRows);
    const first = planned.findIndex(r => heldKeys.has(r.key)), last = planned.findLastIndex(r => heldKeys.has(r.key));
    // Never insert fresh text *inside* a multi-row range: that would change its selected words even without moving its nodes.
    return first < 0 ? planned : [...planned.slice(0, first), ...held,
      ...planned.slice(first, last + 1).filter(r => !heldKeys.has(r.key)), ...planned.slice(last + 1)];
  }
  function render(next, preserve = false, released = false) {
    snapshot = next;
    if (down) return;
    const ranges = selectionRanges();
    if (ranges.length) transcriptSelected = true;
    const frozen = new Set([...view.paragraphs].filter(([, node]) => ranges.some(range => range.intersectsNode(node))).map(([key]) => key));
    const node = [...box.children].find(n => ranges.some(range => range.intersectsNode(n)));
    const model = node && displayed.get(node.dataset.key);
    const word = model?.preview?.words[0];
    const reading = ranges.length ? { range: ranges[0].cloneRange(), y: ranges[0].getBoundingClientRect().top,
      node, nodeY: node?.getBoundingClientRect().top, ids: model?.segments.map(s => s.id),
      at: word && (word.startMs + word.endMs) / 2, source: model?.preview?.source } : selectionAnchor ?? anchor();
    const oldHeight = box.scrollHeight, oldTop = box.scrollTop;
    const incoming = transcriptRows(next);
    const rows = frozen.size ? aroundSelection(incoming, [...box.children].filter(node => frozen.has(node.dataset.key)).map(node => displayed.get(node.dataset.key))) : incoming;
    const wanted = new Set(rows.map(r => r.key));
    box.querySelector('.empty')?.remove();
    for (const [key, node] of view.paragraphs) if (!wanted.has(key)) { node.remove(); view.paragraphs.delete(key); displayed.delete(key); }
    let previous = null, firstActive = ![...frozen].some(key => view.paragraphs.get(key).id === 'live-draft');
    for (const row of rows) {
      let node = view.paragraphs.get(row.key);
      if (!node) { node = document.createElement('div'); node.dataset.key = row.key; view.paragraphs.set(row.key, node); }
      if (!frozen.has(row.key)) {
        if (node.dataset.signature !== row.signature) fill(node, row);
        displayed.set(row.key, row);
        node.id = row.kind === 'active' && firstActive ? 'live-draft' : '';
        let nextNode = previous ? previous.nextSibling : box.firstChild;
        if (nextNode !== node && ranges.length) {
          // A container-level selection may end after trailing whitespace, beyond the last held row.
          // Insert growth outside that boundary too, or the range would absorb (and freeze) the new row.
          let offset = previous ? [...box.childNodes].indexOf(previous) + 1 : 0;
          while (offset < box.childNodes.length && ranges.some(range => range.comparePoint(box, offset) === 0
            && !(range.endContainer === box && range.endOffset === offset))) offset++;
          nextNode = box.childNodes[offset] ?? null;
        }
        if (nextNode !== node) box.insertBefore(node, nextNode);
      }
      if (row.kind === 'active') firstActive = false;
      previous = node;
    }
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = emptyText(); box.append(empty); }
    syncDraftNote();
    // A shorter preview below a selection must not let the browser clamp scrollTop and move the selected line.
    // Keep that room through the clear/flush; later text consumes it, or an explicit scroll/follow releases it.
    if (ranges.length || selectionAnchor) heightFloor = Math.max(heightFloor, oldHeight);
    reserveHeight(Math.max(0, heightFloor - (box.scrollHeight - extraBottom)));
    if (!extraBottom) heightFloor = 0;
    let anchored = false;
    if (reading) {
      const rangeLive = reading.range?.startContainer.isConnected && reading.range.startContainer.nodeType === Node.TEXT_NODE;
      const replacement = !reading.node?.isConnected && rows.find(r => r.segments.some(s => reading.ids?.includes(s.id)
        || (reading.at !== undefined && coversTime(s, reading.at) && (!s.source || s.source === reading.source))));
      const target = rangeLive ? reading.range : reading.node?.isConnected ? reading.node : replacement ? view.paragraphs.get(replacement.key) : null;
      if (target) { scrollTo(box.scrollTop + target.getBoundingClientRect().top - (rangeLive ? reading.y : reading.nodeY ?? reading.y)); anchored = true; }
    }
    if (heardMs === null && view.following && !preserve && !ranges.length) scrollTo(box.scrollHeight - box.clientHeight);
    else if (!anchored) scrollTo(oldTop);
    // Only a transcript interaction release may reconsider following; hidden geometry and timer renders cannot.
    if (released && !ranges.length && visible()) view.following = atBottom();
    selectionAnchor = ranges.length ? { ...reading, y: reading.range.getBoundingClientRect().top, nodeY: reading.node?.getBoundingClientRect().top } : null;
    // Release flushes at the anchor. It follows again only if the reader is still at the actual bottom.
    if (heardMs !== null) view.hear(heardMs);
    if (oldHeight !== box.scrollHeight || rows.length) changed();
  }
  box.addEventListener('scroll', () => {
    if (!visible() || Math.abs(box.scrollTop - setTop) < 1) return;
    setTop = box.scrollTop;
    userScrolledAt = Date.now();
    if (blocked()) { changed(); return; }
    heightFloor = 0; reserveHeight(0); setTop = box.scrollTop;
    view.following = atBottom(); changed();
  });
  box.addEventListener('pointerdown', event => {
    down = true; pointer = { x: event.clientX, y: event.clientY };
    const draft = event.target.closest('.live-draft');
    draftDrag = draft ? { note: noteAt(draft, event), x: event.clientX, y: event.clientY, moved: false, inside: true } : null;
  });
  document.addEventListener('pointermove', event => {
    if (!down && !box.contains(event.target)) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (!down || !draftDrag || (!draftDrag.moved && Math.hypot(event.clientX - draftDrag.x, event.clientY - draftDrag.y) < 3)) return;
    draftDrag.moved = true;
    draftDrag.inside = box.contains(event.target) && Boolean(event.target.closest('.live-draft, .draft-selection-note'));
    clearTimeout(noteTimer);
    draftNote = { ...draftDrag.note, until: Infinity };
    syncDraftNote();
  });
  const release = () => {
    if (!down) return;
    if (draftDrag?.moved && draftNote) {
      draftNote.until = Date.now() + 3000;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        draftNote = null;
        if (snapshot && !down) render(snapshot, true); else syncDraftNote();
      }, 3000);
    }
    down = false; draftDrag = null;
    if (snapshot) render(snapshot, true, true);
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  document.addEventListener('selectionchange', () => {
    const inside = selected(), released = transcriptSelected && !inside;
    transcriptSelected = inside;
    if (!down && snapshot && (inside || released)) render(snapshot, true, released);
  });
  Object.defineProperty(view, 'paused', { get: blocked });
  view.render = render;
  // Share M9a's drag/selection guard, visibility check and tracked programmatic scrolls.
  view.hear = ms => {
    heardMs = ms;
    const heard = ms === null ? null : [...view.paragraphs.values()].findLast(n => n.dataset.kind === 'final'
      && Number(n.dataset.start) <= ms && ms < Number(n.dataset.end));
    for (const node of view.paragraphs.values()) node.classList.toggle('heard', node === heard);
    if (!heard || blocked() || !visible() || Date.now() - userScrolledAt < 4000) return;
    const rect = heard.getBoundingClientRect(), pane = box.getBoundingClientRect();
    if (rect.top < pane.top || rect.bottom > pane.bottom) {
      scrollTo(box.scrollTop + rect.top - pane.top - Math.max(0, (box.clientHeight - rect.height) / 2));
      view.following = atBottom(); changed();
    }
  };
  view.follow = () => { if (blocked()) return; heightFloor = 0; reserveHeight(0); view.following = true; scrollTo(box.scrollHeight); changed(); };
  view.reset = () => { clearTimeout(noteTimer); draftNote = null; draftDrag = null; transcriptSelected = false; snapshot = null; down = false; heardMs = null; userScrolledAt = 0; heightFloor = 0; reserveHeight(0); selectionAnchor = null; displayed.clear(); view.following = true; view.paragraphs.clear(); box.replaceChildren(); setTop = 0; };
  return view;
}
