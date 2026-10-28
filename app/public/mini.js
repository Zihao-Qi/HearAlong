// The mini view (M7, mockup A; docs/design/M7-native-mini.md): one page, shown in the helper's native floating window or, without
// the helper (npm start), in Chrome's Picture-in-Picture window. Drawn only from the server (GET /api/live), so it stays current
// while the app's page is hidden; Stop and cards reach the app's page through the server.
import { TYPE_LABELS, stamp, signatureLines } from '/live-shared.js';
import { compareDisplayOrder } from '/preview-composition.js';

const $ = id => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
// Where the page is shown: the helper's window gives a message handler; Chrome's window holds it in a frame of the app's page.
const native = window.webkit?.messageHandlers?.mini;
const host = native ? 'native' : window.parent !== window ? 'frame' : 'page';
document.documentElement.dataset.host = host;
/** Brings HearAlong forward: the helper opens the installed app; Chrome's window asks the app's page to focus itself. */
function activate() {
  if (native) native.postMessage({ type: 'activate' });
  else if (host === 'frame') parent.miniBridge?.activate(); // set by the app's page on Chrome's window, called inside the click
}
// Errors of this page, kept for the checks (the native window's page has no console to read).
window.miniErrors = [];
addEventListener('error', event => window.miniErrors.push(String(event.message)));
addEventListener('unhandledrejection', event => window.miniErrors.push(String(event.reason)));
const post = (path, data) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// paragraphs: the meeting's, as the server sent them in parts; tag: which of them it may skip next time; earlier: the keys of
// those there before the recording's first reply (shown above the log), null until that reply.
// follow: the lines follow the newest one (the user is at the bottom); setTop: where this page itself last scrolled them;
// reading: the line at the top of the view and where it is on screen, kept while the lines do not follow.
const view = { model: null, receivedAt: 0, shownMs: 0, session: null, confirming: false, stopAsked: false, statusKey: '', cardKey: '', noticesKey: '',
  rows: new Map(), paragraphs: [], tag: '', earlier: null, follow: true, setTop: 0, reading: null, draftKey: '' };

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const get = async have => { const response = await fetch(have ? `/api/live?have=${encodeURIComponent(have)}` : '/api/live'); return response.ok ? response.json() : null; };
    let model = await get(view.tag);
    // A reply that builds on paragraphs this page does not hold (another recording's): the whole meeting instead.
    const from = model?.recording?.paragraphsFrom ?? 0;
    if (from > 0 && (model.recording.session !== view.session || from > view.paragraphs.length)) model = await get('');
    if (!model) return;
    const recording = model.recording;
    // A new recording (or none): nothing carries over from the last one, not even a selection or its lines.
    if ((recording?.session ?? null) !== view.session) {
      Object.assign(view, { session: recording?.session ?? null, shownMs: 0, confirming: false, stopAsked: false, paragraphs: [], tag: '', earlier: null, draftKey: '' });
      getSelection()?.removeAllRanges();
      for (const node of view.rows.values()) node.remove();
      view.rows.clear();
      follow(true);
    }
    // The paragraphs it already had are kept; the server sends the rest.
    if (recording) {
      view.paragraphs = [...view.paragraphs.slice(0, recording.paragraphsFrom), ...recording.paragraphs];
      view.tag = recording.paragraphsTag;
      // Those in the first reply, but the last three, were said before this window showed them: the log announces only the rest.
      view.earlier ??= new Set(view.paragraphs.slice(0, -3).map(p => p.key));
    }
    view.model = model;
    view.receivedAt = performance.now();
    render();
  } catch { /* the server is restarting or has quit; the window closes with it */ }
  finally { busy = false; }
}
window.miniRefresh = refresh; // the helper calls it when its window shows (a hidden web view may have been slowed)

function keepRecording() {
  if (!view.confirming) return;
  view.confirming = false;
  render();
  document.querySelector('.stop')?.focus();
}
function stopNow() {
  const recording = view.model?.recording;
  if (!recording) return;
  view.stopAsked = true;
  view.confirming = false;
  render();
  activate(); // in the click, before any network work: Chrome honours a focus request only then
  // If the request does not get through, Stop comes back, so it can be tried again (the app's own Stop works as well).
  const undo = () => { if (view.session === recording.session) { view.stopAsked = false; render(); } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  fetch('/api/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: recording.session }), signal: controller.signal })
    .then(response => response.ok ? response.json() : { stopping: false }).then(reply => { if (!reply.stopping) undo(); }, undo)
    .finally(() => clearTimeout(timer));
}

function render() {
  const recording = view.model?.recording;
  const stopping = Boolean(recording?.stopping || view.stopAsked);
  // Status: recording time and Stop; the one confirmation (the window floats over the call, so a misclick is likelier);
  // or, once Stop has begun from either window, only that: nothing that looks like it could still cancel it.
  if (stopping || !recording) view.confirming = false;
  // Unless the lines follow the newest one, the line the user reads stays where it is on screen through this update (a notice
  // coming above them, new lines, a paragraph above changing). A selection in the lines holds them too.
  const selection = selected();
  if (Math.abs($('m-scroll').scrollTop - view.setTop) >= 1) follow(atBottom()); // the user scrolled; its event has not come yet
  const reading = view.follow && !selection ? null : topLine();
  const statusKey = !recording ? 'none' : stopping ? 'stopping' : String(view.confirming);
  if (view.statusKey !== statusKey) {
    const status = $('m-status');
    const hadFocus = status.contains(document.activeElement);
    view.statusKey = statusKey;
    const dot = el('span', undefined, 'dot');
    if (!recording || stopping) {
      dot.setAttribute('aria-hidden', 'true');
      status.replaceChildren(...(recording ? [dot] : []), el('span', recording ? 'Stopping…' : 'Not recording', recording ? 'rec' : 'idle'));
      $('m-announce').textContent = recording ? 'Stopping the recording' : '';
      if (hadFocus) status.focus();
    } else if (view.confirming) {
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Recording');
      const now = el('button', 'Stop recording', 'stop-now');
      now.type = 'button';
      now.onclick = stopNow;
      const keep = el('button', 'Keep recording', 'keep');
      keep.type = 'button';
      keep.onclick = keepRecording;
      status.replaceChildren(dot, now, keep);
      now.focus();
    } else {
      dot.setAttribute('aria-hidden', 'true');
      const stop = el('button', 'Stop', 'stop');
      stop.type = 'button';
      stop.onclick = () => { if (view.model?.recording && !view.model.recording.stopping && !view.stopAsked) { view.confirming = true; render(); } };
      status.replaceChildren(dot, el('span', 'Recording', 'rec'), el('span', '', 'clock'), el('span', undefined, 'fill'), stop);
    }
  }
  tick();
  // Notices: only problems. One box, at most two lines, so the transcript and the card always keep their room; the rest is in its title.
  // One problem in full; several in their short forms, so all of them fit.
  const notices = recording?.notices ?? [];
  const noticesKey = notices.length === 1 ? notices[0].text : notices.map(n => n.short).join(' · ').replace(/^./, c => c.toUpperCase());
  if (view.noticesKey !== noticesKey) {
    view.noticesKey = noticesKey;
    const box = el('div', undefined, 'notice');
    box.append(el('span', noticesKey));
    box.title = notices.map(n => n.text).join('\n');
    $('m-notices').replaceChildren(...(notices.length ? [box] : []));
  }
  // Lines selected in the window are not redrawn under the selection, and do not move; new lines still arrive below them.
  if (recording) renderLines(recording, selection);
  // The newest card, as the app's pinned card; a click brings the app forward with it open on the Board.
  const card = $('m-card');
  const newest = recording?.card;
  const cardKey = newest ? JSON.stringify([newest.id, newest.text, newest.type, newest.firstMs]) : '';
  if (view.cardKey !== cardKey) {
    view.cardKey = cardKey;
    card.hidden = !newest;
    if (newest) {
      const tag = `${TYPE_LABELS[newest.type]} · ${stamp(newest.firstMs)}`;
      card.replaceChildren(el('span', tag, 'tag'), el('span', newest.text, 'text'));
      card.setAttribute('aria-label', `Newest card, ${tag}: ${newest.text.replace(/[.\s]+$/, '')}. Opens it in the app.`);
      const meetingId = recording.meetingId;
      card.onclick = () => { activate(); void post('/api/live/reveal', { meetingId, cardId: newest.id }).catch(() => {}); };
    }
  }
  settle(reading, selection);
}
/** The clock runs on between polls from the server's last word, and never goes backwards. */
function tick() {
  const clock = document.querySelector('.clock');
  const recording = view.model?.recording;
  if (!clock || !recording) return;
  view.shownMs = Math.max(view.shownMs, recording.clockMs + performance.now() - view.receivedAt);
  const text = stamp(view.shownMs);
  if (clock.textContent !== text) clock.textContent = text;
}
/**
 * The meeting's paragraphs (as in the transcript), updated in place by paragraph, so the log announces only what is new; below them
 * one preview line per recording source, always there and one line high (its newest words), so the text above never moves as it grows.
 */
function lineRow(speaker, label, text, className) {
  const node = el('div', undefined, 'ln');
  const who = el('span', label, `who${speaker === 'Them' ? ' them' : ''}`);
  who.setAttribute('aria-hidden', label ? 'false' : 'true');
  node.append(who, el('span', text, className));
  return node;
}
function renderLines(recording, selection) {
  $('m-lines').classList.toggle('plain', !recording.labelled);
  let previous;
  const pending = (recording.pending ?? []).flatMap(p => p.placements ?? [])
    .map(p => ({ ...p, kind: 'pending', pending: true, signature: `pending#${p.key}:${encodeURIComponent(p.text)}` })).sort(compareDisplayOrder);
  const keys = new Set(view.paragraphs.map(p => p.key));
  const ordered = [...view.paragraphs.flatMap(p => [...pending.filter(w => w.beforeKey === p.key), p]),
    ...pending.filter(w => w.beforeKey === null || !keys.has(w.beforeKey))];
  const wanted = ordered.map((p, index) => {
    // Pending holes sit before their later finals, never after them in a preview slot.
    const label = p.speaker && (index === 0 || p.speaker !== previous) ? p.speaker : '';
    previous = p.speaker;
    return { ...p, label };
  });
  renderFinals(wanted, selection);
  renderDrafts(recording, previous, wanted.length > 0);
}
/** The selection, if it takes in any of the lines: a drag inside them, one across the window, or Select All. */
function selected() {
  const selection = getSelection();
  if (!selection || selection.isCollapsed) return null;
  for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode($('m-scroll'))) return selection;
  return null;
}
/** The first line showing at the top of the lines, and where its top is on screen. */
function topLine() {
  const top = $('m-scroll').getBoundingClientRect().top;
  for (const node of $('m-scroll').querySelectorAll('.ln')) {
    const box = node.getBoundingClientRect();
    if (box.bottom > top) return { key: node.dataset.key, y: box.top };
  }
  return null;
}
/**
 * After an update or a resize: following, the newest line in view; otherwise the line read put back where it was on screen
 * (anything above it may have changed height: a notice, a paragraph, lines rewrapped to a new width).
 */
function settle(reading, selection) {
  if (!reading) toBottom();
  else {
    const node = view.rows.get(reading.key);
    if (node) setTop($('m-scroll').scrollTop + node.getBoundingClientRect().top - reading.y);
  }
  view.reading = view.follow && !selection ? null : topLine();
  edges();
}
function renderFinals(wanted, selection) {
  // Rows under a selection are left as they are (replacing or moving them would lose it); so are rows the server no longer
  // sends. A paragraph sharing lines with any of them (the server regrouped them: a late line from the other side splits one)
  // waits too, so no words show twice. All of them catch up once the selection is gone.
  const held = node => Boolean(selection?.containsNode(node, true));
  const keep = new Set(wanted.map(w => w.key));
  const frozen = new Set();
  for (const [key, node] of view.rows) {
    if (selection && (held(node) || !keep.has(key))) for (const id of signatureLines(node.dataset.signature)) frozen.add(id);
    else if (!keep.has(key)) { node.remove(); view.rows.delete(key); }
  }
  const earlier = $('m-earlier'), log = $('m-finals');
  // The paragraphs said before the window first showed this recording go above the log, so it announces only new lines.
  const old = key => Boolean(view.earlier?.has(key));
  let before = null;
  wanted.forEach(w => {
    let node = view.rows.get(w.key);
    if (node && held(node)) { before = node; return; }
    if (frozen.size && signatureLines(w.signature).some(id => frozen.has(id))) { if (node) before = node; return; }
    if (!node || node.dataset.signature !== w.signature) {
      const fresh = lineRow(w.speaker, w.label, w.text, w.pending ? 'pending-preview' : 'final');
      if (w.pending) { fresh.className = 'pending-ln'; fresh.setAttribute('aria-hidden', 'true'); }
      Object.assign(fresh.dataset, { key: w.key, signature: w.signature, speaker: w.speaker ?? '' });
      if (node) node.replaceWith(fresh);
      view.rows.set(w.key, fresh);
      node = fresh;
    }
    // A paragraph that becomes the first one gains its speaker's name without being re-added to the log.
    if (node.firstChild.textContent !== w.label) { node.firstChild.textContent = w.label; node.firstChild.setAttribute('aria-hidden', w.label ? 'false' : 'true'); }
    // In order, right after the one before it; a line newer than all those the window opened with goes to the log.
    const next = before ? before.nextSibling ?? (before.parentNode === earlier ? log.firstChild : null) : earlier.firstChild ?? log.firstChild;
    if (node !== next) {
      if (!before) (old(w.key) || earlier.firstChild ? earlier : log).prepend(node);
      else if (before.parentNode === earlier && !before.nextSibling && !old(w.key)) log.prepend(node);
      else before.after(node);
    }
    before = node;
  });
}
/** Whether the lines are scrolled to their end (within 2 px: the browser may stop a fraction short). */
function atBottom() {
  const scroll = $('m-scroll');
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2;
}
function setTop(top) {
  const scroll = $('m-scroll');
  if (Math.abs(scroll.scrollTop - top) >= 1) scroll.scrollTop = top; // otherwise left alone, so a scroll under way goes on
  view.setTop = scroll.scrollTop; // as the browser took it (it stops at the ends)
}
function toBottom() { setTop($('m-scroll').scrollHeight - $('m-scroll').clientHeight); }
/**
 * Following the newest line, with the previews below; or, once the user scrolls up, staying where they read, with the way back
 * to the latest in the previews' place.
 */
function follow(on) {
  if (view.follow === on) return;
  view.follow = on;
  // The way back is at least as high as the previews it replaces, so the lines' view never grows then: it would pull them back
  // to the end, as if the user had scrolled there.
  if (!on) $('m-latest').style.flexBasis = `${Math.max(32, $('m-drafts').offsetHeight)}px`;
  $('m-drafts').hidden = !on;
  $('m-latest').hidden = on;
  if (on) toBottom();
  else view.setTop = $('m-scroll').scrollTop;
}
/** One preview line per recording source in a stable order (Me, then Them), its newest words kept when it is too long. */
function renderDrafts(recording, previous, hasLines) {
  const slots = recording.drafts.map(d => ({ speaker: d.speaker, text: d.text }));
  if (!hasLines && !slots.some(s => s.text)) slots.unshift({ speaker: null, text: 'Listening…', empty: true });
  const draftKey = JSON.stringify([previous, slots]);
  if (view.draftKey === draftKey) return;
  view.draftKey = draftKey;
  let shown = previous;
  $('m-drafts').replaceChildren(...slots.map(s => {
    const label = s.speaker && s.text && s.speaker !== shown ? s.speaker : '';
    if (s.text) shown = s.speaker;
    const node = lineRow(s.speaker, label, '', s.empty ? 'empty' : 'draft');
    // Right-to-left box, left-to-right text: an overlong line is cut at its start, so the words just said stay visible.
    node.lastChild.append(el('bdi', s.text));
    return node;
  }));
}

/** A short fade where lines go on past the top or the bottom of the view. */
function edges() {
  const scroll = $('m-scroll');
  scroll.classList.toggle('above', scroll.scrollTop > 0);
  scroll.classList.toggle('below', !atBottom());
}
/** The line read now, for a resize to keep in place (none while the lines follow the newest one). */
function noteReading() { view.reading = view.follow && !selected() ? null : topLine(); }
$('m-scroll').addEventListener('scroll', () => {
  edges();
  if (Math.abs($('m-scroll').scrollTop - view.setTop) >= 1) follow(atBottom()); // the user's scroll, not this page's own
  noteReading();
});
document.addEventListener('selectionchange', noteReading);
// The window resized, or a notice came or went: lines that follow stay at the newest one, and the line read stays where it was.
new ResizeObserver(() => { const selection = selected(); settle(view.follow && !selection ? null : view.reading ?? topLine(), selection); }).observe($('m-scroll'));
$('m-back').onclick = () => {
  follow(true);
  $('m-scroll').focus({ preventScroll: true }); // the button has gone; the keyboard stays with the lines
};
document.addEventListener('keydown', event => { if (event.key === 'Escape' && view.confirming) { event.preventDefault(); keepRecording(); } });
$('m-status').focus(); // in the window, before Stop: the next Tab reaches Stop, without a ring drawing the eye to it
void refresh();
setInterval(refresh, 1000);
setInterval(tick, 250);
