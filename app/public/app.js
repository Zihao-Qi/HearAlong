import { stamp, TYPE_LABELS, NOTICES, SAVING_BEHIND_FRAMES } from '/live-shared.js';
import { transcriptionStorageMessage } from '/storage-error.js';
import { choosePlansApi, createPlansView, progressCard } from '/plans.js';
import { createTranscriptView } from '/transcript-view.js';
import { createListenPlayer } from '/listen.js';
import { createSegmentsPoll } from '/segments-poll.js';
import { CaptureSuspension } from '/capture-clock.js';
import { uploadWithRetry } from '/upload-retry.js';
import { createRecordingEnds } from '/recording-end.js';
import { SetupUI, setupRequest, aiDialog } from '/setup-ui.js';
import { pageId, pageRequest as api, startPageSession } from '/page-session.js';

const $ = id => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};
let meetingId = store.get('meeting-id') || null;
let status;
let detail;
let capture;
let lastSnapshot;
let requestingMic = false;
let busy = false;
let glossaryOwner = null; // the meeting whose glossary is open in the editor
let selectionGeneration = 0;
let statusSequence = 0;
const view = createTranscriptView($('transcript'), { segmentNode, listen: ms => listen.open(ms), changed: updateJump,
  emptyText: () => meetingId ? 'Waiting for transcribed speech…' : 'Create a meeting, then start the microphone or replay a recording.' });
const listen = createListenPlayer($('transcript-pane'), { owner: () => meetingId,
  recording: () => Boolean(capture || requestingMic || micTest || status?.recordingAnywhere),
  request: api, hear: ms => view.hear(ms) });
// The mini view (M7): the helper's native floating window, or without the helper Chrome's Picture-in-Picture window; see openMini.
const mini = { win: null, revealed: 0, byItself: false, saves: 0 }; // byItself: the user's setting, open it when they leave the app; saves: changes saved here
const miniSupported = () => 'documentPictureInPicture' in window;
/** The helper's native window is there (the installed app): the mini view is its window, not Chrome's. */
const nativeMini = () => Boolean(lastSnapshot?.mini?.native);
// Dismissal belongs to this page load, not localStorage. Restart owns the strip until navigation or its failure line.
const updateView = { dismissed: false, phase: 'ready', accepted: false };
const quitView = { seen: false }; // a quit has begun (see quitting)
const boardView = { owner: null, data: null, sort: store.get('board-sort') === 'type' ? 'type' : 'time', stage: 'all', showDismissed: false, nodes: new Map(), groups: new Map(), seen: new Set(), unread: new Set(), away: new Set(), undo: new Map(), sequence: 0, initialised: false };
const actionsView = { owner: null, jobs: [], materials: false, web: null, enabled: false, sequence: 0, cards: new Map(), forms: new Map(), expanded: new Map(), seenDone: new Set(), unseen: false, initialised: false };
// Plans (M7b): its own meeting tab, and the API object it uses (the real routes, or fixtures with ?plans-fixture=).
let plansApi = null;
let plansView = null;
const notesView = { tab: ['notes', 'plans', 'project'].includes(store.get('right-tab')) ? store.get('right-tab') : 'board', data: null, owner: null, busy: false, sequence: 0 };
// Project memory (M6): the project of the shown meeting, what the Project tab shows, and rows resolved in the last 15 s.
const projectView = { owner: null, project: null, data: null, run: null, filter: null, expanded: new Map(), editing: null, resolved: new Map(), resolvedEdits: new Map(), sources: new Map(), wordings: new Map(), commits: null, commitsFor: null, menu: null, sequence: 0, tell: null, menuProject: undefined, projects: [] };

navigator.serviceWorker?.register('/sw.js').catch(() => {}); // only for the "Starting…" page of the installed app
/** An API call that gives up after `ms` (a stalled request must not hang recording or stopping). */
function apiWithin(ms, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return api(path, { ...options, signal: controller.signal })
    .catch(error => { throw controller.signal.aborted ? new Error(`no reply within ${ms / 1000} s`) : error; })
    .finally(() => clearTimeout(timer));
}
const send = (path, method, data = {}) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const post = (path, data) => send(path, 'POST', data);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function log(message, error = false) {
  const line = el('div', `${new Date().toLocaleTimeString()} · ${message}`, `log-line${error ? ' error' : ''}`);
  $('log').prepend(line);
  while ($('log').children.length > 40) $('log').lastChild.remove();
  if (error) console.warn(message);
}
const base = () => { if (!meetingId) throw new Error('Create or select a meeting first.'); return `/api/meetings/${meetingId}`; };
/**
 * Runs an action: a second click while it runs does nothing, and an error is shown next to the control that started it
 * (and kept in Activity), not only in Settings.
 */
const guarded = fn => async (...args) => {
  const control = args[0]?.currentTarget instanceof HTMLElement ? args[0].currentTarget : null;
  if (control?.dataset.running) return;
  if (control) { control.dataset.running = '1'; control.setAttribute('aria-busy', 'true'); }
  try { await fn(...args); inlineError(control, null); }
  catch (error) { log(error.message, true); inlineError(control, error.message); }
  finally { if (control) { delete control.dataset.running; control.removeAttribute('aria-busy'); } }
};
/** One error line inside the closest row, form or section of a control; cleared by its next success. */
function inlineError(control, message) {
  const place = control?.isConnected ? control.closest('.ok-row, .mem-edit, .mem-actions, .lists-bar, .brief-meta, .brief-edit, .tell-result, form, .settings-section, dialog, section') : null;
  if (!place) return;
  place.querySelector(':scope > .inline-error')?.remove();
  if (!message) return;
  const line = el('p', message, 'inline-error error small');
  line.setAttribute('role', 'alert');
  place.append(line);
}

// ---------- Transcript: keyed paragraphs, never re-rendered under the user's selection ----------

function segmentNode(segment) {
  const span = el('span');
  span.dataset.id = segment.id;
  span.id = `transcript-${segment.id}`;
  let at = 0;
  for (const edit of [...segment.edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < at || edit.end > segment.text.length) continue;
    span.append(segment.text.slice(at, edit.start));
    const fixed = el('span', segment.text.slice(edit.start, edit.end), 'fix');
    fixed.title = `Heard: “${edit.from}” — corrected from the project glossary`;
    span.append(fixed);
    at = edit.end;
  }
  span.append(`${segment.text.slice(at)} `);
  return span;
}
function activeRange() {
  const selection = window.getSelection();
  return selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
}
function renderTranscript(segments, snapshot = {}) { view.render({ ...snapshot, segments }); }
// Following is held during a drag or a transcript selection; deferred updates flush at the reading anchor.
function updateJump() {
  const box = $('transcript');
  $('jump').hidden = !view.paragraphs.size || box.scrollHeight - box.clientHeight - box.scrollTop < 48;
  $('jump').textContent = capture || (lastSnapshot?.replay && lastSnapshot.replay.positionMs < lastSnapshot.replay.durationMs) ? 'Jump to live ↓' : 'Jump to end ↓';

}
$('jump').onclick = () => view.follow();


// Selection menu (M3): compact, beside the selection (never over it), clamped to the pane; copy is unaffected.
let menuSelection = null; // {owner, text, segmentIds} captured when the menu opened
let menuTimer;
function selectedSegments(range) {
  return [...$('transcript').querySelectorAll('span[data-id]')].filter(span => range.intersectsNode(span)).map(span => span.dataset.id);
}
function closeSelectionMenu() {
  $('selection-menu').hidden = true;
  $('selection-other').hidden = true;
  $('selection-hint').hidden = true;
  menuSelection = null;
}
function renderSelectionActions() {
  $('selection-menu').querySelector('[data-action="lookUp"]').hidden = actionsView.web !== true;
}
function placeSelectionMenu() {
  const menu = $('selection-menu');
  if (menu.contains(document.activeElement)) return; // typing in "Other…" must not close the menu
  const range = activeRange();
  const box = $('transcript');
  if (!range || !box.contains(range.commonAncestorContainer)) { closeSelectionMenu(); return; }
  if ([...box.querySelectorAll('.live-draft')].some(draft => range.intersectsNode(draft))) { closeSelectionMenu(); return; } // Preliminary words never reach an action.
  const ids = selectedSegments(range);
  // Spoken words only: times and speaker labels are not part of what was said.
  const fragment = range.cloneContents();
  fragment.querySelectorAll('time, .capture-gap, .draft-selection-note').forEach(n => n.remove());
  const text = fragment.textContent.replace(/\s+/g, ' ').trim();
  if (!ids.length || !text) { closeSelectionMenu(); return; }
  menuSelection = { owner: meetingId, text, segmentIds: ids };
  renderSelectionActions();
  const rect = range.getBoundingClientRect();
  const pane = box.parentElement.getBoundingClientRect();
  const boxTop = box.getBoundingClientRect().top - pane.top;
  menu.hidden = false;
  const left = Math.min(Math.max(8, rect.left - pane.left), pane.width - menu.offsetWidth - 8);
  const above = rect.top - pane.top - menu.offsetHeight - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${above >= boxTop ? above : rect.bottom - pane.top + 8}px`;
}
document.addEventListener('selectionchange', () => {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(placeSelectionMenu, 150);
});
// Keep the transcript selection when a menu button is pressed.
$('selection-menu').addEventListener('mousedown', event => { if (event.target.tagName !== 'INPUT') event.preventDefault(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('selection-menu').hidden) { closeSelectionMenu(); return; }
  const buttons = [...$('selection-menu').querySelectorAll('.selection-actions button')].filter(button => !button.hidden && !button.disabled);
  const index = buttons.indexOf(document.activeElement);
  if (index >= 0 && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault();
    buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus();
  }
});
const MATERIAL_ACTIONS = new Set(['answer', 'findSource']);
for (const button of $('selection-menu').querySelectorAll('.selection-actions button')) {
  button.onclick = guarded(async () => {
    const action = button.dataset.action;
    if (!menuSelection) return;
    if (MATERIAL_ACTIONS.has(action) && !actionsView.materials) {
      $('selection-hint').textContent = 'This needs your project files: add them under Materials (the chip next to the meeting name).';
      $('selection-hint').hidden = false;
      return;
    }
    if (action === 'lookUp' && actionsView.web !== true) return;
    if (action === 'other') { $('selection-other').hidden = false; $('selection-prompt').focus(); return; }
    await startAction(action, menuSelection);
  });
}
$('selection-other').onsubmit = guarded(async event => {
  event.preventDefault();
  if (!menuSelection) return;
  await startAction('other', menuSelection, $('selection-prompt').value);
  $('selection-prompt').value = '';
});


// ---------- Polling ----------

function renderLive(snapshot) {
  // Shown only while something is happening (recording, a replay playing); otherwise the Start button says it all.
  const chip = $('live-chip');
  chip.className = 'chip';
  chip.hidden = false;
  if (capture) {
    chip.classList.add('recording');
    // This recording's own drafts: another source may hold the preview slots, and a window may have fallen behind.
    // Per source: one channel's healthy preview must not hide that the other has none.
    const mine = (snapshot?.drafts ?? []).filter(d => sourceIds().includes(d.source));
    capture.lastDraftAt ??= {};
    for (const d of mine) capture.lastDraftAt[d.source] = Date.now();
    const missing = [...capture.sources.values()].filter(src => Date.now() - (capture.lastDraftAt[src.sourceId] ?? src.addedAt ?? capture.startedAt) > 10_000);
    const off = snapshot && (!snapshot.draftsAvailable || missing.length === capture.sources.size);
    const partly = !off && missing.length ? ` · no preview for ${missing.map(src => src.kind === 'app' ? src.app.name : src.kind === 'tab' ? 'the tab' : 'the mic').join(', ')}` : '';
    const remote = capture.sources.get('app')?.app.name ?? (capture.sources.has('tab') ? 'tab' : null);
    const what = remote ? (capture.sources.has('mic') ? ` · mic + ${remote}` : ` · ${remote} only`) : '';
    // A problem comes first and replaces the routine source detail, so a narrow chip that cuts its end never hides it.
    const notices = captureNotices(snapshot);
    const problems = notices.map(n => ` · ${n.short}`).join('');
    // In an inner span: a chip that is too narrow ends in "…" (the full text is in its title) instead of cutting a letter.
    chip.replaceChildren(el('span', notices.length ? `Recording${problems}` : `Recording${what}${off ? ' · no live preview' : partly || (mine.some(d => d.behind) ? ' · live preview behind' : '')}`, 'chip-text'));
    chip.title = notices.length ? notices.map(n => n.text).join('\n') : `${chip.textContent}. The final transcript arrives in 16–24 s pieces; the grey live preview fills in until then.`;
  }
  else if (snapshot?.replay && snapshot.replay.positionMs < snapshot.replay.durationMs) {
    const r = snapshot.replay;
    chip.classList.add('replay');
    chip.replaceChildren(el('span', `Replay ×${r.speed} · ${stamp(r.positionMs)} / ${stamp(r.durationMs)}`, 'chip-text'));
  } else { chip.hidden = true; chip.textContent = ''; }
  const c = snapshot?.correction;
  let text = '';
  if (c && !c.enabled) text = 'Corrections off (AI models disabled)';
  else if (c?.building && !c.building.error) text = 'Building glossary…';
  else if (c?.building?.error) text = `Glossary build failed: ${c.building.error}`;
  else if (c?.glossary) {
    const stats = c.state?.stats;
    text = `Glossary v${c.glossary.version} · ${c.glossary.terms} terms · ${stats?.accepted ?? 0} corrections`;
    if (c.state?.lastError) text += ' · last call failed';
  } else if (c) text = 'No glossary — attach materials and build one to correct technical terms';
  // Shown in the This meeting panel only (the transcript has no status row).
  controls();
  $('glossary-status').textContent = c?.glossary ? `Version ${c.glossary.version} (${c.glossary.origin === 'user' ? 'edited by you' : 'generated'}), ${c.glossary.terms} terms.` : text;
  // A build that cannot run is not offered as if it could; the reason sits beside it.
  $('build-glossary').disabled = Boolean(c?.canBuild);
  $('build-glossary-note').textContent = c?.canBuild === 'Needs cloud models (they are off).' ? 'Needs AI models (they are off).' : c?.canBuild ?? '';
}

/** The launcher's Quit (or SIGTERM): a recording stops as if Stop were clicked, then the page says the app has quit. */
function quitting() {
  // Every shutdown signal (status, transcript, upload reply) passes here. A deliberate restart owns its strip even on failure.
  if (quitView.seen || updateView.phase === 'restarting' || updateView.accepted) return;
  quitView.seen = true;
  listen.close();
  captureGeneration++; // a recording still starting (a permission prompt, the tab picker) is cancelled when it resumes
  closeMini();
  $('quit-text').textContent = 'HearAlong is quitting…';
  $('quit-banner').hidden = false;
  // Nothing behind the banner can be reached or started any more.
  for (const node of document.body.children) if (node.id !== 'quit-banner') node.inert = true;
  $('quit-banner').focus();
  if (capture && !capture.stopping) { log('HearAlong is quitting: the recording was stopped.'); void stopCapture(); }
}
const segmentsPoll = createSegmentsPoll();
let segmentsBusy = false;
async function refreshSegments() {
  if (segmentsBusy || !meetingId) { if (!meetingId) renderTranscript([]); return; }
  segmentsBusy = true;
  const requested = meetingId, generation = selectionGeneration;
  const savesBefore = mini.saves;
  try {
    const have = segmentsPoll.have(requested);
    const reply = await api(`/api/meetings/${requested}/segments${have ? `?have=${encodeURIComponent(have)}` : ''}`);
    if (requested !== meetingId || generation !== selectionGeneration) { segmentsPoll.reset(); return; }
    const snapshot = segmentsPoll.merge(requested, reply);
    if (!snapshot) return; // a stale answer for another meeting
    lastSnapshot = snapshot;
    if (listen.opened) void refreshStatus();
    // The mini window's setting as saved now (it may have been changed in another app page), unless a change here is saving
    // or was saved after this answer was asked for (a late answer must not undo it).
    if (typeof snapshot.mini?.opensItself === 'boolean' && !$('mini-by-itself').dataset.running && mini.saves === savesBefore) $('mini-by-itself').checked = mini.byItself = snapshot.mini.opensItself;
    if (snapshot.shuttingDown) quitting();
    renderTranscript(snapshot.segments, snapshot);
    renderLive(snapshot);
    // A Stop asked from the mini view, also here in case this page's uploads are stuck (normally it comes with a frame's reply).
    if (capture && !capture.stopping && snapshot.stopSources?.some(id => sourceIds().includes(id))) void stopCapture();
    // A card clicked in the mini view: opened once, here, if this page shows its meeting (after loading the board if the card is
    // newer than this page's copy of it).
    // Consumed only once the card is in this page's copy of the board; until then (10 s) each poll loads the board again.
    if (snapshot.reveal && snapshot.reveal.n > mini.revealed) {
      const { cardId, n } = snapshot.reveal;
      if (boardView.owner === requested && boardView.data?.cards?.some(c => c.id === cardId)) { mini.revealed = n; revealCard(requested, cardId); }
      else void refreshBoard();
    }
  } catch (error) {
    segmentsPoll.reset();
    if (quitView.seen) { $('quit-text').textContent = 'HearAlong has quit. You can close this window.'; return; }
    $('connection').textContent = 'Server unavailable';
    if (/local session/.test(error.message)) $('connection').textContent = 'Server restarted — reload this page';
    renderLive(lastSnapshot);
  } finally { segmentsBusy = false; }
}

function renderUpdate(force = false) {
  const restarting = updateView.phase === 'restarting', failed = updateView.phase === 'failed';
  const canRestart = Boolean(status?.update?.canRestart);
  $('update-bar').hidden = !restarting && !failed && (updateView.dismissed || !status?.update?.ready || (!force && status?.working));
  $('update-text').textContent = failed ? "Couldn’t restart. Close HearAlong and open it again."
    : restarting ? 'Restarting HearAlong…'
    : canRestart ? 'HearAlong was updated.' : 'HearAlong was updated. Run npm start again to use it.';
  $('update-later').hidden = restarting || failed;
  $('update-restart').hidden = failed || !canRestart;
  $('update-restart').disabled = restarting;
  $('update-restart').setAttribute('aria-label', restarting ? 'Restarting' : 'Restart');
  $('update-spinner').toggleAttribute('hidden', !restarting);
}
$('update-later').onclick = () => { updateView.dismissed = true; renderUpdate(); };
$('update-restart').onclick = async () => {
  if (updateView.phase !== 'ready') return;
  updateView.phase = 'restarting'; renderUpdate();
  try {
    await apiWithin(10_000, '/api/restart', { method: 'POST' });
    updateView.accepted = true;
    // Fetch (not navigation) bypasses the service worker's Starting fallback. Only navigate once the old server is gone;
    // the offline navigation then shows Starting, which launches the helper and returns to the newly started dashboard.
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(1000, until - Date.now()));
      try { await fetch('/', { cache: 'no-store', signal: controller.signal }); }
      catch { if (!controller.signal.aborted) { location.replace('/'); return; } }
      finally { clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    updateView.phase = 'failed'; renderUpdate();
  } catch (error) {
    if (error.message === 'Busy') {
      updateView.phase = 'ready'; renderUpdate(true); // the next status uses the server's shared working predicate
    } else if (error.message === 'Restart from Terminal') {
      status.update.canRestart = false; updateView.phase = 'ready'; renderUpdate();
    } else { updateView.phase = 'failed'; renderUpdate(); }
  }
};

const seenStorageErrors = new Set();
function renderStorageError(error) {
  const connection = $('connection');
  connection.classList.toggle('warn', Boolean(error));
  // Keep Details (and keyboard focus) through status polls for the same error.
  if (error && connection.querySelector('button')?.dataset.storageError === error) return;
  connection.replaceChildren();
  if (!error) return;
  const details = el('button', 'Details', 'act');
  details.dataset.storageError = error;
  details.type = 'button'; details.onclick = () => openSettings('activity');
  connection.append(document.createTextNode(transcriptionStorageMessage(error)), details);
  if (!seenStorageErrors.has(error)) { seenStorageErrors.add(error); log(`Transcription storage: ${error}`, true); }
}
async function refreshStatus() {
  const sequence = ++statusSequence;
  const generation = selectionGeneration;
  try {
    const fresh = await api('/api/status');
    if (sequence !== statusSequence) return; // a newer status request is already in flight or done
    status = fresh;
    renderUpdate();
    renderOlderAudio(fresh.audioRetentionNotice);
    renderAudioRemoved(fresh.meetings.find(m => m.id === meetingId));
    listen.recording(fresh.recordingAnywhere || capture || requestingMic);
    listen.meeting(fresh.meetings.find(m => m.id === meetingId));
    if (fresh.shuttingDown) quitting(); // also with no meeting selected (no transcript polling)
    renderStorageError(fresh.transcriptionStorageError);
    // Only a snapshot requested after the current selection may say that meeting no longer exists.
    if (generation === selectionGeneration && !capture && !requestingMic && !status.meetings.some(m => m.id === meetingId)) selectMeeting(status.meetings[0]?.id ?? null);
    renderMeetingMenu();
    const ai = fresh.ai;
    $('settings-ai-change').hidden = !!ai?.forcedOff;
    $('cloud').textContent = ai?.forcedOff ? 'Off for this start (MEETING_CLOUD=0).' : ai?.mode === 'local' ? 'On this Mac · nothing leaves it.' : ai?.mode === 'off' ? 'Off · transcription only.' : `Cloud · ${ai?.main?.id?.split('/')[0] ?? 'through Pi'}`;
    $('board-model').closest('label').hidden = ai?.mode !== undefined && ai.mode !== 'cloud';
    if (ai?.mode === 'off') $('auto-answers').closest('label').hidden = true;
    $('ai-cloud-notice').hidden = !ai?.cloudNotice || ai.mode !== 'cloud';
    if (ai?.cloudNotice) $('ai-cloud-notice-text').textContent = `AI still runs in the cloud with ${ai.cloudConsent?.providers.join(', ') ?? 'your provider'}, as before. You can now keep it on this Mac instead.`;
    renderStatusDot();
  } catch (error) {
    if (quitView.seen) { $('quit-text').textContent = 'HearAlong has quit. You can close this window.'; return; }
    $('connection').classList.remove('warn');
    $('connection').textContent = /local session/.test(error.message) ? 'Server restarted — reload this page' : 'Server unavailable';
  } finally { controls(); }
}

async function refreshDetail() {
  if (!meetingId) { detail = undefined; return; }
  const requested = meetingId;
  try {
    const data = await api(`/api/meetings/${requested}`);
    if (requested !== meetingId) return;
    detail = data;
    renderAudioRemoved(data.meeting);
    listen.meeting(data.meeting);
    $('retry').hidden = Boolean(data.meeting.audioRemovedAt != null) || !data.chunks.some(c => c.status === 'failed');
    setProject(data.project);
    // Memory changed (a run finished, something waits for an OK): reload it, so the badge and the pills are right without the tab open.
    if (data.project && data.memoryStamp !== projectView.stamp) { projectView.stamp = data.memoryStamp; void refreshProject(); }
    renderMeetingChip();
    renderStatusDot();
    $('query').closest('.row').hidden = !data.materials.length;
    $('search-results').hidden = !data.materials.length;
    $('material-scope').hidden = !data.project;
    keepFocus($('materials'), () => $('materials').replaceChildren(...data.materials.map(material => {
      const item = el('li', `${material.label} (${material.kind})`);
      if (data.project) item.firstChild.after(el('span', material.scope.startsWith('project:') ? 'project' : 'this meeting only', 'scope'));
      const remove = focusKey(el('button', 'Remove', 'button'), material.id);
      remove.onclick = guarded(async () => { await api(`${base()}/materials/${material.id}`, { method: 'DELETE' }); await refreshDetail(); });
      item.append(remove);
      return item;
    })));
    const jobs = [...data.chunks].reverse().slice(0, 40);
    $('jobs').replaceChildren(...jobs.map(chunk => {
      const row = el('div', `${stamp(chunk.startMs)} · ${chunk.status}`, 'job');
      if (chunk.error) row.append(el('div', chunk.error, 'error'));
      if (chunk.metrics) {
        const m = JSON.parse(chunk.metrics);
        row.append(el('div', `${(m.computeMs / 1000).toFixed(2)} s for ${m.audioSeconds.toFixed(1)} s audio${m.recoveredBy ? ` · recovered by ${m.recoveredBy}` : ''}`, 'muted'));
      }
      return row;
    }));
  } catch { /* status polling reports connection problems */ }
}

function updateTranscriptDownloads(id) {
  const paths = { export: 'transcript.md', 'export-plain': 'transcript.txt', 'export-raw': 'transcript.md?mode=raw' };
  for (const [key, path] of Object.entries(paths)) {
    const href = id ? `/api/meetings/${id}/${path}` : '#';
    $(key).href = href;
    $(`meeting-${key}`).href = href;
    $(`meeting-${key}`).hidden = !id;
  }
  $('meeting-download-sep').hidden = !id;
  $('meeting-download-label').hidden = !id;
  $('transcript-options').disabled = !id;
}
function selectMeeting(id) {
  if (id === meetingId) return;
  selectionGeneration++;
  if (capture) void stopCapture();
  closeStartMenu();
  listen.close();
  meetingId = id;
  renderAudioRemoved(status?.meetings.find(m => m.id === id));
  $('retry').hidden = true;
  view.following = true;
  glossaryOwner = null;
  $('glossary-editor').hidden = true;
  $('glossary-editor').value = '';
  $('save-glossary').hidden = true;
  $('search-results').replaceChildren();
  store.set('meeting-id', id ?? '');
  view.reset();
  lastSnapshot = undefined;
  segmentsPoll.reset();
  updateTranscriptDownloads(id);
  closeTranscriptMenu();
  // Invalidate everything shown for the previous meeting's notes, including in-flight requests and the export link.
  notesView.owner = null; notesView.signature = null; notesView.data = null; notesView.sequence++; notesView.busy = false;
  $('notes-body').replaceChildren(); $('notes-body').classList.remove('has-notes'); delete $('notes-body').dataset.record;
  $('notes-warnings').replaceChildren(); $('notes-status').textContent = ''; $('notes-status').hidden = true;
  $('notes-progress').replaceChildren(); $('notes-progress').hidden = true;
  closeNotesMenu();
  $('notes-options').hidden = true; $('notes-stale').hidden = true;
  $('export-notes').href = '#';
  $('export-notes-panel').href = '#'; $('export-notes-panel').setAttribute('aria-disabled', 'true'); $('write-notes').hidden = false; $('write-notes').disabled = true;
  plansView?.reset();
  if (['notes', 'plans'].includes(notesView.tab)) void refreshNotes();
  if (notesView.tab === 'plans') void plansView?.refresh();
  closeSelectionMenu();
  // Nothing of the previous meeting's actions stays clickable while the new meeting's load.
  actionsView.sequence++;
  actionsView.cards.forEach(entry => entry.node.remove());
  actionsView.cards.clear();
  Object.assign(actionsView, { owner: null, jobs: [], materials: false, web: null, unseen: false });
  renderSelectionActions();
  $('board-empty').hidden = false;
  $('actions-status').textContent = '';
  void refreshActions();
  boardView.sequence++;
  resetBoardView(null);
  updateBoardBadge();
  void refreshBoard();
  resetProjectView();
  void refreshSegments();
  void refreshDetail();
}

function controls() {
  const recording = Boolean(capture);
  document.body.classList.toggle('recording', recording);
  const ready = Boolean(status?.config.available && meetingId) && !busy && !requestingMic && !quitView.seen;
  $('start').hidden = recording;
  $('stop').hidden = !recording;
  $('add-tab').hidden = !recording || Boolean(capture?.sources.has('tab') || capture?.sources.has('app')) || Boolean(capture?.stopping);
  $('mini-view').hidden = !recording || Boolean(capture?.stopping) || (nativeMini() ? lastSnapshot.mini.state === 'open' : !miniSupported() || Boolean(mini.win));
  if (recording && callMenuAnchor !== 'add-tab') closeStartMenu();
  const snapshotReady = lastSnapshot?.meetingId === meetingId;
  $('start').disabled = !ready || !snapshotReady || Boolean(lastSnapshot?.replay);
  // Switching and new meetings wait for the recording to stop; renaming is fine during one.
  const locked = recording || busy || requestingMic;
  $('new-meeting').disabled = locked;
  $('open-replay').disabled = locked;
  $('rename-meeting').disabled = busy || !meetingId;
  for (const item of $('meeting-list').querySelectorAll('button')) item.disabled = locked && item.getAttribute('aria-checked') !== 'true';
  $('replay').disabled = recording || busy || requestingMic || !status?.config.available;
}

// ---------- Notes (right pane tab) ----------

const SECTION_TITLES = { summary: 'Summary', decisions: 'Decided', actions: 'To do', openQuestions: 'Open questions' };
function showTab(tab) {
  // Without a project the Project tab falls back to the board; the choice is kept for when a project meeting is shown.
  const fallback = tab === 'project' && !projectView.project;
  if (fallback) tab = 'board';
  notesView.tab = tab;
  if (tab !== 'notes') closeNotesMenu();
  if (tab !== 'plans') plansView?.closeMenu();
  if (!fallback) store.set('right-tab', tab);
  $('tab-board').setAttribute('aria-selected', String(tab === 'board'));
  $('tab-notes').setAttribute('aria-selected', String(tab === 'notes'));
  $('tab-project').setAttribute('aria-selected', String(tab === 'project'));
  $('tab-plans').setAttribute('aria-selected', String(tab === 'plans'));
  for (const id of ['board', 'notes', 'plans', 'project']) {
    $(`tab-${id}`).tabIndex = id === tab ? 0 : -1;
    $(`${id}-panel`).setAttribute('aria-labelledby', `${layoutView.compact ? 'ctab' : 'tab'}-${id}`);
  }
  $('board-panel').hidden = tab !== 'board';
  $('notes-panel').hidden = tab !== 'notes';
  $('plans-panel').hidden = tab !== 'plans';
  $('project-panel').hidden = tab !== 'project';
  $('board-sort').hidden = tab !== 'board';
  if (tab === 'notes' || tab === 'plans') void refreshNotes();
  if (tab === 'plans') void plansView?.refresh();
  $('notes-options-wrap').hidden = tab !== 'notes';
  $('plans-options-slot').hidden = tab !== 'plans';
  updateBoardBadge();
  if (tab === 'project') void refreshProject();
}
// Arrow keys move between the tabs, as in the compact layout.
document.querySelector('.board-pane .tabs').addEventListener('keydown', event => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const order = ['board', 'notes', 'plans', 'project'].filter(t => !$(`tab-${t}`).hidden);
  const next = order[(order.indexOf(notesView.tab) + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
  showTab(next);
  $(`tab-${next}`).focus();
});
$('tab-board').onclick = () => showTab('board');
$('tab-notes').onclick = () => showTab('notes');
$('tab-plans').onclick = () => showTab('plans');
$('tab-project').onclick = () => showTab('project');

// ---------- Layouts: wide (transcript | board, resizable) and compact (one column with tabs) ----------

const BOARD_DEFAULT = 400, BOARD_MIN = 380, TRANSCRIPT_MIN = 480, DIVIDER = 8, COMPACT_BELOW = 900;
const layoutView = {
  boardWidth: Number(store.get('board-width')) || BOARD_DEFAULT,
  compact: false,
  tab: ['board', 'notes', 'plans', 'project'].includes(store.get('compact-tab')) ? store.get('compact-tab') : 'live',
  scroll: { live: null, board: 0, notes: 0, plans: 0, project: 0 },
};
/** Whether the board's cards are on screen (badge counting). */
function boardVisible() { return notesView.tab === 'board' && (!layoutView.compact || layoutView.tab === 'board'); }
/** Keep a single Notes menu and let Plans render its tools into the active layout's slot. */
function syncPaneTools() {
  const wrap = $('notes-options').parentElement;
  const target = layoutView.compact ? document.querySelector('.notes-bar') : document.querySelector('.board-pane .pane-head');
  if (wrap.parentElement !== target) target.insertBefore(wrap, layoutView.compact ? $('notes-status') : null);
}
/** Opens the board or notes in whichever layout is active. */
function openPane(tab, jumping = false) { if (layoutView.compact) showCompactTab(tab, jumping); else showTab(tab); }
/** The shown board width: the user's width, clamped so neither pane is ever below its minimum. */
function clampBoard() {
  const width = $('layout').clientWidth;
  const max = Math.max(BOARD_MIN, Math.floor(Math.min(width * 0.5, width - TRANSCRIPT_MIN - DIVIDER)));
  const shown = Math.round(Math.min(max, Math.max(BOARD_MIN, layoutView.boardWidth)));
  $('layout').style.setProperty('--board-width', `${shown}px`);
  const divider = $('divider');
  divider.setAttribute('aria-valuemin', String(BOARD_MIN));
  divider.setAttribute('aria-valuemax', String(max));
  divider.setAttribute('aria-valuenow', String(shown));
  divider.setAttribute('aria-valuetext', `Board ${shown} pixels wide`);
  return { shown, max };
}
function applyLayout() {
  const narrow = window.innerWidth < COMPACT_BELOW;
  const compact = narrow; // the width decides (the mini view covers a small window during a call)
  const changed = compact !== layoutView.compact;
  if (changed) { closeSelectionMenu(); saveScroll(); }
  layoutView.compact = compact;
  document.body.classList.toggle('layout-compact', compact);
  document.body.dataset.tab = layoutView.tab;
  $('compact-tabs').hidden = !compact;
  // Compact: the transcript is the Live tab's panel, and the sort control joins the board's filter bar (no extra header row).
  const pane = $('transcript-pane');
  if (compact) { pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', 'ctab-live'); }
  else { pane.removeAttribute('role'); pane.removeAttribute('aria-labelledby'); }
  const sort = $('board-sort');
  if (compact && sort.parentElement !== document.querySelector('.board-bar')) document.querySelector('.board-bar').prepend(sort);
  if (!compact && sort.parentElement === document.querySelector('.board-bar')) document.querySelector('.board-pane .pane-head').append(sort);
  syncPaneTools();
  if (changed) { closeNotesMenu(); plansView?.closeMenu(); plansView?.render(); }
  if (!compact) clampBoard();
  if (compact) {
    if (layoutView.tab !== 'live' && notesView.tab !== layoutView.tab) showTab(layoutView.tab);
    selectCompactTab(layoutView.tab);
    renderPinned(boardView.owner);
  }
  for (const id of ['board', 'notes', 'plans', 'project']) $(`${id}-panel`).setAttribute('aria-labelledby', `${compact ? 'ctab' : 'tab'}-${id}`);
  if (changed) restoreScroll();
  updateBoardBadge();
  renderMeetingChip();
}
/** Only panes on screen are saved: a hidden pane reports 0. */
function saveScroll() {
  if ($('transcript').offsetParent) layoutView.scroll.live = view.following ? null : $('transcript').scrollTop;
  const panel = $(`${notesView.tab}-panel`);
  if (panel.offsetParent) layoutView.scroll[notesView.tab] = panel.scrollTop;
}
function restoreScroll() {
  // A pane hidden with display:none loses its scroll position; put back where the user was (or follow live).
  requestAnimationFrame(() => {
    const box = $('transcript');
    if (!view.paused) box.scrollTop = layoutView.scroll.live === null ? box.scrollHeight : layoutView.scroll.live;
    $(`${notesView.tab}-panel`).scrollTop = layoutView.scroll[notesView.tab] ?? 0;
  });
}
/** The compact tabs: Transcript, Board, Notes, Plans, and Project when the meeting has one. */
function compactTabs() { return projectView.project ? ['live', 'board', 'notes', 'plans', 'project'] : ['live', 'board', 'notes', 'plans']; }
function selectCompactTab(tab) {
  for (const id of ['live', 'board', 'notes', 'plans', 'project']) {
    $(`ctab-${id}`).setAttribute('aria-selected', String(id === tab));
    $(`ctab-${id}`).tabIndex = id === tab ? 0 : -1; // roving tabindex: Tab goes into the panel, arrows move between tabs
  }
  document.body.dataset.tab = tab;
}
/** `jumping`: the caller scrolls to a target itself, so the saved position must not be restored over it. */
function showCompactTab(tab, jumping = false) {
  closePanel(); // in compact a panel covers the tabs' content: choosing a tab means leaving the panel
  if (tab === layoutView.tab && layoutView.compact) return;
  closeSelectionMenu();
  if (tab === 'live') { closeNotesMenu(); plansView?.closeMenu(); }
  saveScroll();
  layoutView.tab = tab;
  store.set('compact-tab', tab);
  if (tab !== 'live') showTab(tab);
  selectCompactTab(tab);
  if (!jumping) restoreScroll();
  updateBoardBadge();
}
for (const id of ['live', 'board', 'notes', 'plans', 'project']) $(`ctab-${id}`).onclick = () => showCompactTab(id);
$('compact-tabs').addEventListener('keydown', event => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const order = compactTabs();
  const next = order[(order.indexOf(layoutView.tab) + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
  showCompactTab(next);
  $(`ctab-${next}`).focus();
});
function setBoardWidth(width, save = true) {
  layoutView.boardWidth = width;
  const { shown } = clampBoard();
  layoutView.boardWidth = shown; // what the user sees is what is kept
  if (save) store.set('board-width', String(shown));
}
{
  const divider = $('divider');
  let drag = null;
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    closeSelectionMenu();
    divider.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, width: clampBoard().shown };
    document.body.classList.add('resizing');
    event.preventDefault();
  });
  divider.addEventListener('pointermove', event => {
    if (!drag) return;
    setBoardWidth(drag.width + (drag.x - event.clientX), false); // the board is on the right: dragging left widens it
  });
  const end = event => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('resizing');
    if (divider.hasPointerCapture?.(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    store.set('board-width', String(layoutView.boardWidth));
  };
  divider.addEventListener('pointerup', end);
  divider.addEventListener('pointercancel', end);
  divider.addEventListener('lostpointercapture', end);
  divider.addEventListener('dblclick', () => setBoardWidth(BOARD_DEFAULT));
  divider.addEventListener('keydown', event => {
    const { shown, max } = clampBoard();
    const moves = { ArrowLeft: shown + 16, ArrowRight: shown - 16, Home: BOARD_MIN, End: max, Enter: BOARD_DEFAULT };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setBoardWidth(moves[event.key]);
  });
}
let layoutFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => { closeSelectionMenu(); applyLayout(); });
});

/** Scrolls the transcript to a line, if this meeting is still shown and the line still exists. */
function scrollToSegment(owner, segmentId, citedIds = [segmentId]) {
  if (owner !== meetingId) return;
  // A hidden transcript cannot scroll; after switching tabs, jump at once (a smooth scroll from the top takes seconds).
  const switched = layoutView.compact && layoutView.tab !== 'live';
  if (switched) showCompactTab('live', true);
  const node = $('transcript').querySelector(`span[data-id="${CSS.escape(segmentId)}"]`);
  if (!node) { log('That line is not in the transcript shown now (it may be past the replay position or no longer exist).', true); return; }
  view.following = false;
  node.scrollIntoView({ block: 'center', behavior: switched ? 'auto' : 'smooth' });
  $('transcript').querySelectorAll('.cited').forEach(old => old.classList.remove('cited'));
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  for (const id of citedIds) $('transcript').querySelector(`span[data-id="${CSS.escape(id)}"]`)?.classList.add('cited');
  updateJump();
}
function noteControl(text, cites, record, owner) {
  const link = el('a', text, 'note-sentence');
  link.href = `#transcript-${encodeURIComponent(cites[0])}`;
  link.setAttribute('aria-describedby', 'note-transcript-hint');
  link.onclick = event => {
    event.preventDefault();
    if (owner !== meetingId || record.version !== notesView.data?.notes?.version) return;
    $('notes-body').querySelectorAll('.note-sentence.lit').forEach(n => n.classList.remove('lit'));
    link.classList.add('lit');
    scrollToSegment(owner, cites[0], cites);
  };
  return link;
}
function noteItem(item, record, owner) {
  const card = el('li', undefined, 'note');
  const control = noteControl(item.text, item.cites, record, owner);
  if (item.owner || item.ownerProposed) {
    const tag = el('span', item.owner || `${item.ownerProposed}?`, item.owner ? 'owner' : 'owner unconfirmed');
    if (!item.owner) tag.title = 'The model named this person, but no cited line clearly assigns the task to them.';
    const lastWord = Math.max(0, item.text.search(/\S+\s*$/));
    control.textContent = item.text.slice(0, lastWord);
    const tail = el('span', undefined, 'note-owner-tail');
    tail.append(item.text.slice(lastWord), ' ', tag);
    control.append(tail);
  }
  card.append(control);
  if (item.section === 'otherMatters' && !item.reviewReason) {
    const action = lookIntoIt(item, owner); action.classList.add('note-look'); action.querySelector('button').classList.add('text-action'); card.append(' ', action);
  }
  if (item.reviewReason) card.append(el('div', item.reviewReason, 'note-review'));
  return card;
}
/** Adjacent gaps with the same reason read as one stretch: "47:20–48:00 (unrecognised)". Same rule as mergeGaps() in notes.ts. */
function gapText(gaps) {
  const merged = [];
  for (const g of [...gaps].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last && last.reason === g.reason && g.startMs <= last.endMs + 1000) last.endMs = Math.max(last.endMs, g.endMs);
    else merged.push({ ...g });
  }
  return merged.map(g => `${stamp(g.startMs)}–${stamp(g.endMs)} (${g.reason})`).join(', ');
}
function renderNotes(data, owner) {
  const record = data.notes;
  const job = data.job;
  const running = job?.state === 'running';
  $('write-notes').textContent = running ? 'Writing…' : 'Write notes';
  $('write-notes').hidden = Boolean(record) || running;
  $('write-notes').disabled = running || !data.enabled || !meetingId;
  $('rewrite-notes').setAttribute('aria-disabled', String($('write-notes').disabled));
  $('notes-options').hidden = !record;
  $('notes-stale').hidden = !record || !data.stale;
  if (!record) closeNotesMenu();
  $('export-notes').href = record ? `/api/meetings/${owner}/notes.md?version=${record.version}` : '#';
  $('export-notes-panel').href = $('export-notes').href;
  $('export-notes-panel').setAttribute('aria-disabled', String(!record));
  $('export-notes-panel').title = record ? 'Download the notes' : 'Write notes first';
  let statusText = '';
  $('write-notes').title = data.enabled ? '' : 'Writing notes needs AI models, which are off (see Settings).';
  $('rewrite-notes').title = running ? 'Notes are being written.' : $('write-notes').title;
  const progressHost = $('notes-progress');
  progressHost.hidden = !running;
  progressHost.dataset.jobId = job?.id ?? '';
  if (running) {
    const card = progressCard('notes', job.progress ?? { phase: 'read', startedAt: job.startedAt }, async () => {
      try {
        const result = await post(`/api/meetings/${owner}/notes/cancel`, { jobId: job.id });
        if (result.outcome === 'already-saved') log('These notes were already saved.');
      } catch (error) { log(error.message, true); }
      finally { notesView.signature = null; await refreshNotes(); }
    }, progressHost.firstElementChild);
    if (!card.parentNode) progressHost.append(card);
  } else progressHost.replaceChildren();
  if (job?.state === 'failed') statusText = `Last attempt failed: ${job.error}`;
  else if (job?.state === 'interrupted') statusText = `Last attempt was interrupted: ${job.error ?? ''} Try again.`;

  $('notes-status').textContent = statusText;
  $('notes-status').hidden = !statusText;
  $('notes-body').classList.toggle('has-notes', Boolean(record));
  const warnings = [];
  if (record) {
    warnings.push(['version', `Version ${record.version}, written ${new Date(record.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} from the transcript up to ${stamp(record.input.coverage.untilMs)}.`]);
    if (data.stale) warnings.push(['warn', `The transcript changed since these notes (now up to ${stamp(data.currentUntilMs)}). Write the notes again for an up-to-date version.`]);
    const c = record.input.coverage;
    if (c.pendingChunks) warnings.push(['warn', `${c.pendingChunks} audio chunk(s) were still being transcribed.`]);
    if (c.gaps.length) warnings.push(['warn', `Missing speech: ${gapText(c.gaps)}.`]);
    if (c.uncorrected) warnings.push(['warn', `${c.uncorrected} line(s) had not been checked for misheard terms.`]);
    // Same rule as gapsSince() in notes.ts, so the export carries the same warning.
    const known = new Set(c.gaps.map(g => `${g.startMs}:${g.reason}`));
    const newGaps = (data.coverage?.gaps ?? []).filter(g => !known.has(`${g.startMs}:${g.reason}`));
    if (newGaps.length) warnings.push(['warn', `Speech missing since these notes were written: ${gapText(newGaps)}.`]);
  }
  if (record) warnings.push(['draft', 'AI notes: check a quote before relying on it.']);
  $('notes-warnings').replaceChildren(...warnings.map(([, text]) => el('p', text, 'notes-warning')));
  if (!record) {
    $('notes-body').replaceChildren(...(running ? [] : [el('p', 'After the meeting (or during it, as a draft), write notes from the transcript: summary, decisions, action items and open questions, each linked to the moment it was said.', 'board-empty')]));
    return;
  }
  // Transcript/coverage polling must not close what someone is reading or erase checked citations.
  const host = $('notes-body'), key = `${owner}:${record.version}`;
  const retained = host.dataset.record === key;
  if (retained) return; // Progress and warnings never rebuild saved content, focus or folds.
  const body = [];
  for (const section of ['summary', 'decisions', 'actions', 'openQuestions']) {
    const items = record.notes[section];
    if (!items.length) continue;
    const group = el('section', undefined, 'notes-group');
    group.append(el('h4', SECTION_TITLES[section], 'notes-section'));
    if (section === 'summary') {
      const paragraph = el('p', undefined, 'notes-summary');
      for (const item of items) paragraph.append(noteControl(item.text, item.cites, record, owner), ' ');
      group.append(paragraph);
    } else {
      const list = el('ul', undefined, 'notes-list'); list.append(...items.map(item => noteItem(item, record, owner))); group.append(list);
    }
    body.push(group);
  }
  const other = record.notes.otherMatters ?? [];
  const ranges = record.notes.otherTalk ?? record.notes.offTopic ?? [];
  const fold = (label, items) => {
    const box = el('details', undefined, 'notes-fold');
    const summary = el('summary', label);
    summary.dataset.focus = label;
    box.append(summary, ...items);
    return box;
  };
  const rangeRow = range => {
    const row = el('li', undefined, 'note offtopic-row');
    const chip = noteControl(range.label, [range.fromId], record, owner);
    chip.dataset.cite = range.fromId;
    chip.dataset.focus = `range:${range.fromId}`;
    row.append(chip);
    return row;
  };
  const content = ranges.filter(r => !r.smallTalk), small = ranges.filter(r => r.smallTalk);
  const otherList = el('ul', undefined, 'notes-list');
  otherList.append(...other.map(item => noteItem(item, record, owner)), ...content.map(rangeRow));
  const otherRows = [otherList];
  if (small.length) {
    const smallList = el('ul', undefined, 'notes-list'); smallList.append(...small.map(rangeRow));
    otherRows.push(fold(`Small talk (${small.length})`, [smallList]));
  }
  if (other.length + ranges.length) body.push(fold(`Not about the project (${other.length + ranges.length})`, otherRows));
  if (record.notes.needsReview.length) {
    const list = el('ul', undefined, 'notes-list'); list.append(...record.notes.needsReview.map(item => noteItem(item, record, owner)));
    body.push(fold(`Needs review (${record.notes.needsReview.length})`, [list]));
  }
  const hint = el('span', 'Shows this in the transcript'); hint.id = 'note-transcript-hint'; hint.hidden = true;
  host.replaceChildren(...body, hint);
  host.dataset.record = key;
}
async function refreshNotes() {
  if (!meetingId || notesView.busy) return;
  notesView.busy = true;
  const owner = meetingId;
  const sequence = ++notesView.sequence;
  try {
    const data = await api(`/api/meetings/${owner}/notes`);
    if (owner !== meetingId || sequence !== notesView.sequence) return; // a stale answer for another meeting
    // Re-render only when something changed, so reading is not disturbed by polling.
    const signature = JSON.stringify([data.notes?.version, data.job, data.stale, data.currentUntilMs, data.enabled, data.coverage]);
    const unchanged = notesView.owner === owner && notesView.signature === signature;
    notesView.owner = owner;
    notesView.data = data; // always the latest answer, even when nothing needs redrawing
    if (unchanged) return;
    notesView.signature = signature;
    renderNotes(data, owner);
    if (!data.job || data.job.state !== 'running') plansView?.render(); // progress must not rebuild the plans either
  } catch (error) { if (owner === meetingId && sequence === notesView.sequence) { $('notes-status').hidden = false; $('notes-status').textContent = error.message; } }
  finally { if (sequence === notesView.sequence) notesView.busy = false; }
}
// ---------- Notes options ----------
function bindMenuKeys(menu, close) {
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(); return; }
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === ' ' && document.activeElement?.tagName === 'A') {
      event.preventDefault(); document.activeElement.click();
    }
  });
}
let notesMenuOpener = null;
function closeNotesMenu(returnFocus = false) {
  const wasOpen = !$('notes-menu').hidden;
  $('notes-menu').hidden = true;
  $('notes-options').setAttribute('aria-expanded', 'false');
  const opener = notesMenuOpener;
  notesMenuOpener = null;
  if (returnFocus && wasOpen) (opener && !opener.hidden ? opener : $('notes-options')).focus();
}
function openNotesMenu(opener = $('notes-options'), last = false) {
  if ($('notes-options').hidden) return;
  notesMenuOpener = opener;
  $('notes-menu').hidden = false;
  $('notes-options').setAttribute('aria-expanded', 'true');
  const items = $('notes-menu').querySelectorAll('[role="menuitem"]');
  items[last ? items.length - 1 : 0]?.focus();
}
function toggleNotesMenu(opener) {
  if (!$('notes-menu').hidden && notesMenuOpener === opener) closeNotesMenu(true);
  else openNotesMenu(opener);
}
$('notes-options').onclick = () => toggleNotesMenu($('notes-options'));
$('notes-options').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); openNotesMenu($('notes-options'), event.key === 'ArrowUp');
  }
};
$('notes-stale').onclick = event => { event.preventDefault(); toggleNotesMenu($('notes-stale')); };
bindMenuKeys($('notes-menu'), closeNotesMenu);
$('notes-menu').addEventListener('click', event => {
  const item = event.target.closest?.('[role="menuitem"]');
  if (item && item.getAttribute('aria-disabled') !== 'true') closeNotesMenu(true);
});
document.addEventListener('click', event => {
  if (!event.target.closest?.('.notes-options-wrap, #notes-stale')) closeNotesMenu(true);
});
document.addEventListener('focusin', event => {
  if (!event.target.closest?.('.notes-options-wrap, #notes-stale')) closeNotesMenu(true);
});

$('write-notes').onclick = $('rewrite-notes').onclick = guarded(async () => {
  if ($('write-notes').disabled) return;
  const owner = meetingId;
  await post(`${base()}/notes`, {});
  if (owner === meetingId) { notesView.signature = null; await refreshNotes(); }
});
$('copy-notes').onclick = guarded(async () => {
  // Copy exactly the notes on screen: same meeting, same version, checked again after each wait.
  const owner = meetingId, generation = selectionGeneration, version = notesView.owner === owner ? notesView.data?.notes?.version : undefined;
  if (!version) throw new Error('No notes to copy.');
  const response = await fetch(`/api/meetings/${owner}/notes.md?version=${version}`);
  if (!response.ok) throw new Error(response.status === 409 ? 'The notes changed; reload the Notes tab and copy again.' : 'No notes to copy.');
  const text = await response.text();
  if (owner !== meetingId || generation !== selectionGeneration || notesView.owner !== owner || notesView.data?.notes?.version !== version) {
    log('The notes on screen changed before copying finished; nothing was copied. Copy again.', true); return;
  }
  await navigator.clipboard.writeText(text);
  log(`Notes v${version} copied as Markdown.`);
});

// ---------- Transcript downloads ----------
function closeTranscriptMenu(returnFocus = false) {
  const wasOpen = !$('transcript-menu').hidden;
  $('transcript-menu').hidden = true;
  $('transcript-options').setAttribute('aria-expanded', 'false');
  if (wasOpen && returnFocus) $('transcript-options').focus();
}
function openTranscriptMenu(last = false) {
  if ($('transcript-options').disabled) return;
  $('transcript-menu').hidden = false;
  $('transcript-options').setAttribute('aria-expanded', 'true');
  const items = $('transcript-menu').querySelectorAll('[role="menuitem"]');
  items[last ? items.length - 1 : 0]?.focus();
}
$('transcript-options').onclick = () => {
  if ($('transcript-menu').hidden) openTranscriptMenu();
  else closeTranscriptMenu(true);
};
$('transcript-options').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); openTranscriptMenu(event.key === 'ArrowUp');
  }
};
bindMenuKeys($('transcript-menu'), closeTranscriptMenu);
$('transcript-menu').addEventListener('click', event => {
  if (event.target.closest?.('[role="menuitem"]')) closeTranscriptMenu();
});
document.addEventListener('click', event => {
  if (!event.target.closest?.('.transcript-options-wrap')) closeTranscriptMenu();
});
document.addEventListener('focusin', event => {
  if (!event.target.closest?.('.transcript-options-wrap')) closeTranscriptMenu();
});
// ---------- End transcript downloads ----------

// ---------- Actions (M3): answer cards on the Board ----------

const ACTION_LABELS = { explain: 'Explain', answer: 'Answer', compute: 'Compute', findSource: 'Find source', lookUp: 'Look up', other: 'Other' };

async function startAction(action, selection, prompt, cardId) {
  closePanel(); // the new card appears on the board, which a panel would cover
  if (!selection || selection.owner !== meetingId) throw new Error('The selection belongs to another meeting.');
  const generation = selectionGeneration;
  const { job, merged } = await post(`/api/meetings/${selection.owner}/actions`, { action, selection: { text: selection.text, segmentIds: selection.segmentIds }, prompt, cardId });
  // A slow answer must not close the menu or clear a selection made since (possibly in another meeting).
  if (generation === selectionGeneration && menuSelection === selection) { closeSelectionMenu(); window.getSelection()?.removeAllRanges(); }
  log(merged ? `${ACTION_LABELS[action]} is already running for this selection.` : `${ACTION_LABELS[action]} started.`);
  if (generation === selectionGeneration) await refreshActions();
  return job;
}
/** The newest card and any running or queued card are open unless the user collapsed them; older answers start collapsed. */
function isExpanded(job) {
  if (actionsView.expanded.has(job.id)) return actionsView.expanded.get(job.id);
  const tops = actionsView.jobs.filter(j => !j.parentId);
  return job.state === 'queued' || job.state === 'running' || tops[0]?.id === job.id;
}
/** Card buttons act only while their meeting is still the one shown. */
const sameMeeting = owner => { if (owner === meetingId) return true; log('That card belongs to another meeting; nothing was done.', true); return false; };

/** "Look into it" on an Other matters card: an editable request, run as Look up (web) or as Other (files and web). */
function lookIntoIt(item, owner, cardId) {
  const wrap = el('div', undefined, 'look-into');
  const open = el('button', 'Look into it', 'button small-button');
  const form = el('form', undefined, 'look-form');
  form.hidden = true;
  const input = el('textarea');
  input.rows = 2;
  input.maxLength = 2000;
  input.value = `Look into this for me: ${item.text}`;
  input.setAttribute('aria-label', 'What to look into');
  input.dataset.key = `look-${cardId ?? item.text}`;
  const web = el('button', 'Look up on the web', 'button primary small-button');
  const other = el('button', 'Run as my request', 'button small-button');
  other.type = 'button';
  form.append(input, el('div', undefined, 'row'));
  form.lastChild.append(web, other, el('span', 'Research and drafts only — nothing is booked, paid or sent.', 'muted small'));
  open.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); };
  const run = action => guarded(async event => {
    event?.preventDefault();
    const selection = { owner, text: item.quote || item.text, segmentIds: item.cites };
    await startAction(action, selection, input.value, cardId);
    form.hidden = true;
    if (cardId) { await refreshBoard(); return; } // the answer appears on the card itself
    open.replaceWith(Object.assign(el('button', 'Looking into it… · View on Board', 'button small-button'), { onclick: () => openPane('board') }));
  });
  form.onsubmit = run('lookUp');
  other.onclick = run('other');
  wrap.append(open, form);
  return wrap;
}

const elapsed = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
function stateText(job) {
  const now = Date.now();
  switch (job.state) {
    case 'queued': return job.queuePosition > 1 ? `Queued · ${job.queuePosition - 1} ahead · starts when a running action finishes` : 'Queued · starts when a running action finishes';
    case 'running': return `Running · ${elapsed(now - job.startedAt)}`;
    case 'done': return `Done · ${elapsed(job.result?.ms ?? 0)}`;
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return 'Interrupted';
  }
}
const CHECK_OK = new Set(['quote found']);
const DRAFT_NOTE = 'AI draft — the badges check that the quoted words occur in the cited source, not that the answer is right.';
function checkPill(result) {
  if (!result.metaError && !result.checks.length && !result.uncitedRefs.length) return el('span', result.summary, 'check-pill neutral');
  const bad = result.metaError || !result.checks.length || result.checks.some(c => !CHECK_OK.has(c.status)) || result.uncitedRefs.length;
  const pill = el('span', `${bad ? '⚠' : '✓'} ${result.summary}`, `check-pill ${bad ? 'warn' : 'ok'}`);
  pill.title = DRAFT_NOTE;
  return pill;
}
function sourceRow(job, check) {
  // Rows with nothing to show (e.g. an invalid file) are static, with the reason inline: no dead disclosure arrow.
  const expandable = check.excerpt !== undefined || check.url || check.segmentId;
  if (!expandable) {
    const row = el('div', undefined, 'source static');
    row.dataset.key = `source-${check.id}`;
    row.append(el('span', `[${check.id}]`, 'mono'), el('span', check.label, 'source-label'), el('span', check.status, `badge ${CHECK_OK.has(check.status) ? 'ok' : 'warn'}`));
    if (check.detail) row.append(el('span', check.detail, 'muted small source-reason'));
    return row;
  }
  const item = el('details', undefined, 'source');
  item.dataset.key = `source-${check.id}`;
  const summary = el('summary');
  summary.append(el('span', `[${check.id}]`, 'mono'), el('span', check.label, 'source-label'),
    el('span', check.inherited ? `${check.status} (earlier answer)` : check.status, `badge ${CHECK_OK.has(check.status) ? 'ok' : 'warn'}`));
  item.append(summary);
  if (check.detail) item.append(el('p', check.detail, 'muted small'));
  if (check.type === 'web' && check.url) {
    const link = el('a', check.url, 'small');
    link.href = check.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    item.append(link);
  }
  if (check.type === 'transcript' && check.segmentId) {
    const owner = actionsView.owner;
    const chip = el('button', check.label.replace(/^Transcript /, ''), 'cite');
    chip.onclick = () => { if (sameMeeting(owner)) scrollToSegment(owner, check.segmentId); };
    item.append(el('blockquote', `“${check.excerpt}”`, 'note-quote'), chip);
  }
  if (check.type === 'file' && check.excerpt !== undefined) {
    const where = check.matchedFrom ? `quote found at lines ${check.matchedFrom}–${check.matchedTo}; showing ${check.excerptFrom}–${check.excerptTo}` : `showing ${check.excerptFrom ?? check.from}–${check.excerptTo ?? check.to}`;
    // A PDF's lines are those of the text the app extracted from it; the page is where to find them in the PDF.
    item.append(el('p', `${check.path}${check.pages ? `, page ${check.pages} (lines of its extracted text)` : ''}, cited lines ${check.ranges ?? `${check.from}–${check.to}`} · ${where}`, 'muted small'));
    item.append(el('pre', check.excerpt, 'source-preview'));
  }
  return item;
}
/**
 * Markdown with formulas: \( \), \[ \] and $$ $$ are rendered to MathML by KaTeX before Markdown runs (Markdown would
 * eat their backslashes), held as placeholders, and put back after sanitizing. Single $ is left alone (prices).
 */
function renderMarkdown(markdown) {
  if (!window.DOMPurify || !window.marked) return null;
  const math = [];
  const hold = (tex, display) => {
    let html;
    try { html = window.katex ? window.katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false }) : null; } catch { html = null; }
    // The hidden TeX <annotation> is dropped: DOMPurify removes that tag but would keep its text, showing the TeX twice.
    if (html) html = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');
    math.push(html ? window.DOMPurify.sanitize(html) : `<code>${tex.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</code>`);
    return `MATHPLACEHOLDER${math.length - 1}X`;
  };
  const prepared = markdown
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n\n${hold(tex, true)}\n\n`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => `\n\n${hold(tex, true)}\n\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => hold(tex, false));
  const html = window.DOMPurify.sanitize(window.marked.parse(prepared));
  return html.replace(/MATHPLACEHOLDER(\d+)X/g, (_, i) => math[Number(i)] ?? '');
}
/** Renders sanitized Markdown and turns [n] into buttons that open source n. */
function answerBody(job, sourcesBox) {
  const body = el('div', undefined, 'answer');
  const html = renderMarkdown(job.result.markdown);
  if (html === null) body.textContent = job.result.markdown; else body.innerHTML = html;
  for (const a of body.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  const ids = new Set(job.result.checks.map(c => c.id));
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[\d{1,3}\]/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement.closest('pre, code')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.nodeValue.split(/(\[\d{1,3}\])/);
    node.replaceWith(...parts.map(part => {
      const m = /^\[(\d{1,3})\]$/.exec(part);
      if (!m) return document.createTextNode(part);
      const n = Number(m[1]);
      const ref = el('button', part, `cite-ref${ids.has(n) ? '' : ' missing'}`);
      ref.title = ids.has(n) ? 'Show this source' : 'No such source in the answer';
      ref.onclick = () => {
        const row = sourcesBox.querySelector(`[data-key="source-${n}"]`);
        if (!row) return;
        if ('open' in row) row.open = true;
        for (let d = row.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true; // folded in a board card
        row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      return ref;
    }));
  }
  memoryPills(body, job.context?.memory);
  return body;
}
function actionCard(job, childrenOf, owner, depth = 0, options = {}) {
  const children = depth < 6 ? childrenOf(job.id) : [];
  const card = el('article', undefined, `note action-card state-${job.state}`);
  card.dataset.id = job.id;
  const head = el('div', undefined, 'action-head');
  head.append(el('span', ACTION_LABELS[job.action] ?? job.action, 'tag'));
  if (depth === 0 && !options.embedded) head.append(el('span', 'Your request', 'prov user'));
  head.append(el('span', stateText(job), 'muted small action-state'));
  if (job.state === 'done' && job.result && !options.embedded) head.append(checkPill(job.result)); // a board card shows it in its own header
  card.append(head);
  // Older top-level cards are collapsed to their header and question; a click opens them (G1, review 2).
  if (depth === 0 && !isExpanded(job)) {
    card.classList.add('collapsed');
    const summary = el('button', job.prompt || job.context.selection.text, 'collapsed-summary');
    summary.title = 'Show this answer';
    summary.onclick = () => { actionsView.expanded.set(job.id, true); actionsView.cards.get(job.id).sig = ''; renderActions(owner); };
    card.append(summary);
    if (children.length) card.append(el('p', `${children.length} follow-up${children.length > 1 ? 's' : ''}`, 'muted small'));
    return card;
  }
  if (depth === 0) {
    const hide = el('button', 'Collapse', 'link-button');
    hide.onclick = () => { actionsView.expanded.set(job.id, false); actionsView.cards.get(job.id).sig = ''; renderActions(owner); };
    head.append(hide);
  }
  // Inside a board card the card itself shows the question and quote; the answer is compact (decision G4/G8).
  if (!job.parentId && !options.embedded) {
    const quote = el('blockquote', `“${job.context.selection.text}”`, 'note-quote selection-quote');
    const chip = el('button', stamp(job.context.selection.startMs), 'cite');
    chip.onclick = () => { if (!sameMeeting(owner)) return; chip.classList.add('visited'); scrollToSegment(owner, job.context.selection.segmentIds[0]); };
    card.append(quote, el('div', undefined, 'cites'));
    card.lastChild.append(chip);
  }
  if (job.prompt && !options.embedded) card.append(el('p', `${job.parentId ? 'Follow-up' : 'You asked'}: ${job.prompt}`, 'action-prompt'));
  const controls = el('div', undefined, 'row action-controls');
  if (job.state === 'queued' || job.state === 'running') {
    if (job.state === 'running' && job.status.length) card.append(el('p', job.status.at(-1), 'action-status'));
    if (job.draft) {
      const draft = el('details', undefined, 'draft');
      draft.dataset.key = 'draft';
      draft.append(el('summary', 'Show draft (incomplete, not checked)'), el('pre', job.draft, 'draft-text'));
      card.append(draft);
    }
    const cancel = el('button', 'Cancel', 'button small-button');
    cancel.onclick = guarded(async () => { if (!sameMeeting(owner)) return; await post(`/api/meetings/${owner}/actions/${job.id}/cancel`); await refreshActions(); });
    controls.append(cancel);
  } else if (job.state === 'done' && job.result) {
    const sources = el('div', undefined, 'sources');
    // Inside a board card the secondary blocks are folded (decision G4); on their own card they are shown.
    const extra = el('details', undefined, 'more');
    extra.dataset.key = 'more';
    extra.append(el('summary', `Sources${job.result.assumptions.length ? ', assumptions' : ''}${job.result.openPoints.length ? ', open points' : ''} (${job.result.checks.length} source${job.result.checks.length === 1 ? '' : 's'})`));
    const into = options.embedded ? extra : card;
    // A calculation means nothing without its assumptions, so Compute shows them first; other answers lead with the answer.
    const assumptions = (target = into) => { if (!job.result.assumptions.length) return; target.append(el('h5', 'Assumptions', 'action-sub')); const ul = el('ul', undefined, 'action-list'); ul.append(...job.result.assumptions.map(a => el('li', a))); target.append(ul); };
    if (job.action === 'compute') assumptions(card);
    const body = answerBody(job, sources);
    if (options.embedded) {
      body.classList.add('compact');
      const more = el('button', 'Show full answer', 'link-button');
      more.onclick = () => { const open = body.classList.toggle('compact'); more.textContent = open ? 'Show full answer' : 'Show less'; };
      card.append(body, more);
    } else card.append(body);
    if (job.action !== 'compute') assumptions();
    if (job.result.openPoints.length) { into.append(el('h5', 'Open points', 'action-sub')); const ul = el('ul', undefined, 'action-list'); ul.append(...job.result.openPoints.map(a => el('li', a))); into.append(ul); }
    if (job.result.checks.length) { sources.append(el('h5', 'Sources', 'action-sub'), ...job.result.checks.map(c => sourceRow(job, c))); into.append(sources); }
    if (options.embedded && extra.childElementCount > 1) card.append(extra);
    if (job.result.compute.length) {
      const how = el('details', undefined, 'how');
      how.dataset.key = 'how';
      how.append(el('summary', `How it was computed (${job.result.compute.length} script${job.result.compute.length > 1 ? 's' : ''})`));
      for (const run of job.result.compute) how.append(el('p', `${run.script} · ${run.status}`, 'muted small'), el('pre', run.code, 'source-preview'), el('pre', run.output, 'source-preview output'));
      card.append(how);
    }
    const copy = el('button', 'Copy', 'button small-button');
    copy.onclick = guarded(async () => {
      const r = job.result;
      const list = (title, items) => items.length ? `\n\n**${title}**\n${items.map(x => `- ${x}`).join('\n')}` : '';
      const warnings = [...(r.notes ?? []), ...(r.manifest && r.manifest.status !== 'no change seen' ? [`Material files: ${r.manifest.status} (who changed them is not known)`] : [])];
      const text = [`> AI draft (${ACTION_LABELS[job.action]}, ${stamp(job.context.selection.startMs)}). ${DRAFT_NOTE.replace(/^AI draft — /, '')} Sources: ${r.summary}.`,
        ...warnings.map(w => `> ⚠ ${w}`),
        `**Question:** ${job.prompt || ACTION_LABELS[job.action]}`, `**Said in the meeting:** “${job.context.selection.text}”`, '',
        r.markdown + list('Assumptions', r.assumptions) + list('Open points', r.openPoints), '',
        ...r.checks.map(c => `[${c.id}] ${c.label} — ${c.status}${c.detail ? ` (${c.detail})` : ''}${c.inherited ? ' (from the earlier answer)' : ''}${c.url ? ` ${c.url}` : ''}`)].join('\n');
      await navigator.clipboard.writeText(`${text}\n`);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    });
    const follow = el('button', 'Ask a follow-up', 'button small-button');
    const form = el('form', undefined, 'follow-form');
    form.hidden = true;
    const input = el('input');
    input.placeholder = 'Ask a follow-up on this answer…';
    input.maxLength = 2000;
    form.append(input, Object.assign(el('button', 'Send', 'button primary small-button'), { type: 'submit' }));
    follow.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); };
    form.onsubmit = guarded(async event => {
      event.preventDefault();
      if (!sameMeeting(owner)) return;
      await post(`/api/meetings/${owner}/actions`, { parentId: job.id, prompt: input.value });
      actionsView.forms.delete(job.id);
      input.value = '';
      form.hidden = true;
      await refreshActions();
    });
    // Follow-ups stop at the server's depth limit (5 below the first answer); the deepest card says so instead of failing.
    if (depth >= 5) controls.append(copy, el('span', 'Ask a new question from the transcript to go further.', 'muted small'));
    else controls.append(copy, follow);
    for (const note of job.result.notes ?? []) card.append(el('p', note, 'notes-warning warn'));
    card.append(controls, form);
  }
  if (job.result?.manifest && job.result.manifest.status !== 'no change seen') {
    card.append(el('p', job.result.manifest.status === 'change observed'
      ? `⚠ Material files changed during this calculation: ${[...job.result.manifest.changed, ...job.result.manifest.added, ...job.result.manifest.removed].slice(0, 5).join(', ')}`
      : 'Material files could not all be checked for changes during this calculation.', 'notes-warning warn'));
  }
  if (job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled') {
    if (job.error) card.append(el('p', job.error, 'muted small'));
    if (job.draft) { const d = el('details', undefined, 'draft'); d.dataset.key = 'draft'; d.append(el('summary', 'Partial draft (incomplete, not checked)'), el('pre', job.draft, 'draft-text')); card.append(d); }
    const retry = el('button', 'Retry', 'button small-button');
    retry.onclick = guarded(async () => { if (!sameMeeting(owner)) return; await post(`/api/meetings/${owner}/actions/${job.id}/retry`); await refreshActions(); });
    controls.append(retry);
  }
  if (!card.contains(controls) && controls.childElementCount) card.append(controls);
  if (children.length) {
    const thread = el('div', undefined, 'thread');
    thread.append(...children.map(child => actionCard(child, childrenOf, owner, depth + 1)));
    card.append(thread);
  }
  return card;
}
/**
 * Re-renders only cards whose content (including any descendant) changed. Open <details>, a follow-up being typed and its
 * focus survive the replacement; elapsed times are updated in place, so running cards are not rebuilt every few seconds.
 */
function renderActions(owner) {
  const jobs = actionsView.jobs;
  const byParent = new Map();
  for (const job of jobs) if (job.parentId) byParent.set(job.parentId, [...(byParent.get(job.parentId) ?? []), job]);
  const childrenOf = id => (byParent.get(id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
  // Jobs bound to a board card are shown inside that card; here only the user's own requests (decision G10).
  const tops = jobs.filter(job => !job.cardId && !job.cardIds?.length && (!job.parentId || !jobs.some(j => j.id === job.parentId)));
  const tree = (job, depth = 0) => [job.id, job.state, job.status.at(-1), job.queuePosition, Boolean(job.draft), job.result?.summary, depth < 6 ? childrenOf(job.id).map(c => tree(c, depth + 1)) : []];
  const list = $('actions-list');
  const keep = new Set();
  let previous = null;
  for (const job of tops) {
    keep.add(job.id);
    const sig = JSON.stringify([isExpanded(job), tree(job)]);
    let entry = actionsView.cards.get(job.id);
    if (!entry || entry.sig !== sig) {
      const open = new Set(entry ? [...entry.node.querySelectorAll('details[open]')].map(d => `${d.closest('[data-id]')?.dataset.id}:${d.dataset.key}`) : []);
      const drafts = entry ? [...entry.node.querySelectorAll('.draft-text')].map(p => p.scrollTop) : [];
      if (entry) for (const form of entry.node.querySelectorAll('.follow-form')) {
        const id = form.closest('[data-id]')?.dataset.id;
        const input = form.querySelector('input');
        if (!id) continue;
        // Every form is recorded, so a form the user cleared and closed does not come back with old text.
        if (form.hidden && !input.value) actionsView.forms.delete(id);
        else actionsView.forms.set(id, { value: input.value, hidden: form.hidden, focused: document.activeElement === input, at: input.selectionStart });
      }
      const node = actionCard(job, childrenOf, owner);
      for (const d of node.querySelectorAll('details')) if (open.has(`${d.closest('[data-id]')?.dataset.id}:${d.dataset.key}`)) d.open = true;
      node.querySelectorAll('.draft-text').forEach((p, i) => { p.scrollTop = drafts[i] ?? 0; });
      if (entry) entry.node.replaceWith(node);
      for (const form of node.querySelectorAll('.follow-form')) {
        const saved = actionsView.forms.get(form.closest('[data-id]')?.dataset.id);
        if (!saved) continue;
        const input = form.querySelector('input');
        form.hidden = saved.hidden;
        input.value = saved.value;
        if (saved.focused) { input.focus(); input.setSelectionRange(saved.at ?? input.value.length, saved.at ?? input.value.length); }
      }
      entry = { node, sig };
      actionsView.cards.set(job.id, entry);
    } else {
      // Only the streaming draft text changed: update it in place.
      const walk = j => { const pre = entry.node.querySelector(`[data-id="${CSS.escape(j.id)}"] > .draft .draft-text`); if (pre && pre.textContent !== j.draft) pre.textContent = j.draft; childrenOf(j.id).forEach(walk); };
      walk(job);
    }
    if ((previous ? previous.nextSibling : list.firstChild) !== entry.node) list.insertBefore(entry.node, previous ? previous.nextSibling : list.firstChild);
    previous = entry.node;
  }
  for (const [id, entry] of actionsView.cards) if (!keep.has(id)) { entry.node.remove(); actionsView.cards.delete(id); }
  for (const job of jobs) {
    const state = list.querySelector(`[data-id="${CSS.escape(job.id)}"] > .action-head .action-state`);
    if (state) state.textContent = stateText(job);
  }
  $('board-empty').hidden = jobs.length > 0 || (boardView.data?.cards.length ?? 0) > 0;
  $('requests-title').hidden = !tops.length;
  $('answers-note').hidden = !jobs.some(j => j.state === 'done' && j.result);
  if (boardView.data && boardView.owner === owner) renderBoard(owner); // card answers follow their jobs
}
function updateBoardBadge() {
  const active = actionsView.jobs.filter(j => j.state === 'queued' || j.state === 'running').length;
  for (const job of actionsView.jobs) if (job.state === 'done' && !actionsView.seenDone.has(job.id)) {
    actionsView.seenDone.add(job.id);
    if (!boardVisible() && actionsView.initialised) actionsView.unseen = true;
  }
  actionsView.initialised = true;
  if (boardVisible()) { actionsView.unseen = false; boardView.away.clear(); }
  // Card dots track board scrolling; the tab counts only arrivals while the board was off screen.
  const newCards = boardView.away.size;
  // The same badge on the wide pane's Board tab and the compact Board tab.
  for (const badge of [$('board-badge'), $('compact-badge')]) {
    badge.hidden = !active && !actionsView.unseen && !newCards;
    badge.textContent = active ? String(active) : newCards ? `+${newCards}` : '•';
    badge.title = active ? `${active} action(s) running or queued` : newCards ? `${newCards} new card(s)` : 'A new answer is ready';
  }
  $('ctab-board').setAttribute('aria-label', $('compact-badge').hidden ? 'Board' : `Board, ${$('compact-badge').title}`);
}
async function refreshActions() {
  if (!meetingId) return;
  const owner = meetingId;
  const sequence = ++actionsView.sequence;
  try {
    const data = await api(`/api/meetings/${owner}/actions`);
    if (owner !== meetingId || sequence !== actionsView.sequence) return;
    if (actionsView.owner !== owner) {
      actionsView.cards.forEach(entry => entry.node.remove());
      actionsView.cards.clear();
      actionsView.forms.clear();
      actionsView.expanded.clear();
      actionsView.seenDone = new Set(data.jobs.filter(j => j.state === 'done').map(j => j.id));
      actionsView.initialised = false;
    }
    actionsView.owner = owner;
    Object.assign(actionsView, { jobs: data.jobs, materials: data.materials, enabled: data.enabled, web: data.web });
    renderSelectionActions();
    $('actions-status').hidden = data.enabled && !data.pausedUntil;
    $('actions-status').textContent = !data.enabled ? ''
      : data.pausedUntil ? `Paused after a rate-limit error until ${new Date(data.pausedUntil).toLocaleTimeString()}; queued actions wait.` : '';
    renderActions(owner);
    updateBoardBadge();
  } catch (error) { if (owner === meetingId && sequence === actionsView.sequence) { $('actions-status').hidden = false; $('actions-status').textContent = error.message; } }
}

// ---------- Board (M4): cards proposed by the quick model ----------

const GROUPS = [['Questions', ['question']], ['Claims to check', ['claim']], ['Decisions & actions', ['decision', 'action']], ['Other matters', ['other']]];
const STAGE_LABELS = { suggested: 'Suggested', investigating: 'Investigating', answered: 'Answered', meeting: 'From the meeting' };

function cardJobs(card) { return card.attempts.map(id => actionsView.jobs.find(j => j.id === id)).filter(Boolean); }
function stageOf(card) {
  if (['decision', 'action', 'other'].includes(card.type)) return 'meeting';
  const job = cardJobs(card).at(-1);
  if (!job) return 'suggested';
  return job.state === 'queued' || job.state === 'running' ? 'investigating' : job.state === 'done' ? 'answered' : 'suggested';
}
/** Card evidence as a selection for "Ask about this" / "Look into it": the cited lines and the literal quote. */
const cardSelection = (card, owner) => ({ owner, text: card.occurrences[0].quote, segmentIds: card.occurrences[0].lines.map(l => l.id) });

function boardCard(card, owner) {
  const node = el('article', undefined, `note board-card type-${card.type}${card.dismissed ? ' dismissed' : ''}${boardView.unread.has(card.id) ? ' unread' : ''}`);
  node.dataset.card = card.id;
  node.tabIndex = -1;
  const head = el('div', undefined, 'action-head');
  const meeting = ['decision', 'action', 'other'].includes(card.type);
  // The type says where it comes from (decisions, actions and other matters were said; questions and claims are suggested).
  const tag = el('span', TYPE_LABELS[card.type], 'tag');
  tag.title = (meeting ? 'Something the participants said or settled.' : 'The quick model thinks this is worth a look.') + ' The card text is an AI summary; the quote is what was said.';
  head.append(tag);
  const stage = stageOf(card);
  if (!meeting) head.append(el('span', STAGE_LABELS[stage], 'muted small action-state'));
  else head.append(el('span', '', 'action-state'));
  if (card.confidence === 'low') head.append(el('span', 'low confidence', 'badge warn'));
  if (card.auto) head.append(el('span', { reserved: 'Auto · starting', submitted: 'Auto', uncertain: 'Auto attempt interrupted', refused: 'Auto not run' }[card.auto.state], 'badge auto'));
  const latest = cardJobs(card).at(-1);
  if (latest?.state === 'done' && latest.result) head.append(checkPill(latest.result));
  const chip = el('button', stamp(card.firstMs), 'cite card-time');
  chip.setAttribute('aria-label', `Go to ${stamp(card.firstMs)} in the transcript`);
  chip.onclick = () => { if (sameMeeting(owner)) scrollToSegment(owner, card.occurrences[0].lines[0].id); };
  const dismiss = el('button', card.dismissed ? 'Restore' : '✕', card.dismissed ? 'link-button' : 'dismiss');
  dismiss.title = card.dismissed ? 'Show this card again' : 'Dismiss this card (you can undo)';
  if (!card.dismissed) dismiss.setAttribute('aria-label', 'Dismiss this card');
  dismiss.onclick = guarded(async () => {
    if (!sameMeeting(owner)) return;
    await post(`/api/meetings/${owner}/board/cards/${card.id}/${card.dismissed ? 'restore' : 'dismiss'}`);
    if (!card.dismissed) boardView.undo.set(card.id, Date.now() + 15000);
    await refreshBoard();
  });
  head.append(chip, dismiss);
  node.append(head);
  if (boardView.undo.has(card.id) && card.dismissed) {
    const bar = el('div', undefined, 'undo-bar');
    const undo = el('button', 'Undo', 'link-button');
    undo.onclick = guarded(async () => { boardView.undo.delete(card.id); await post(`/api/meetings/${owner}/board/cards/${card.id}/restore`); await refreshBoard(); });
    bar.append(el('span', 'Dismissed', 'muted small'), undo);
    node.append(bar);
    return node;
  }
  node.append(el('p', card.text, 'card-text'));
  const occ = card.occurrences[0];
  const quote = el('blockquote', `“${occ.quote}”`, 'note-quote selection-quote');
  if (occ.matched === 'original') quote.append(el('span', ' as originally heard', 'muted'));
  node.append(quote);
  if (card.occurrences.length > 1) node.append(el('p', `Raised again ${card.occurrences.length - 1}× (${card.occurrences.slice(1).map(o => stamp(o.lines[0].startMs)).join(', ')})`, 'muted small'));
  const controls = el('div', undefined, 'row action-controls');
  const plan = card.type === 'question' ? (card.nonProject ? 'Look up' : 'Investigate') : card.type === 'claim' && !card.nonProject ? 'Check claim' : null;
  if (plan && !(latest && (latest.state === 'queued' || latest.state === 'running'))) {
    const go = el('button', latest ? `${plan} again` : plan, 'button small-button primary-light');
    go.onclick = guarded(async () => {
      if (!sameMeeting(owner)) return;
      if (card.materials && !card.nonProject && !actionsView.materials && card.type !== 'question') throw new Error('Add materials first (the chip next to the meeting name).');
      await post(`/api/meetings/${owner}/board/cards/${card.id}/investigate`);
      await refreshActions(); await refreshBoard();
    });
    controls.append(go);
  }
  if (card.type === 'decision' || card.type === 'action') {
    const ask = el('button', 'Ask about this', 'button small-button');
    const form = el('form', undefined, 'follow-form');
    form.hidden = true;
    const input = el('input');
    input.value = `About this ${card.type}: ${card.text} — `;
    input.maxLength = 2000;
    form.append(input, Object.assign(el('button', 'Run', 'button primary small-button'), { type: 'submit' }));
    ask.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); };
    input.dataset.key = `ask-${card.id}`;
    form.onsubmit = guarded(async event => { event.preventDefault(); await startAction('other', cardSelection(card, owner), input.value, card.id); form.hidden = true; await refreshBoard(); });
    controls.append(ask);
    node.append(controls, form);
  } else if (card.type === 'other') {
    node.append(lookIntoIt({ text: card.text, quote: occ.quote, cites: occ.lines.map(l => l.id) }, owner, card.id));
  } else node.append(controls);
  if (card.auto?.state === 'uncertain') node.append(el('p', 'The automatic answer was interrupted (server restart); use Investigate to run it again.', 'muted small'));
  if (latest) {
    const holder = el('div', undefined, 'card-answer');
    holder.append(actionCard(latest, id => actionsView.jobs.filter(j => j.parentId === id).sort((a, b) => a.createdAt - b.createdAt), owner, 1, { embedded: true }));
    if (card.attempts.length > 1) holder.append(el('p', `${card.attempts.length - 1} earlier attempt${card.attempts.length > 2 ? 's' : ''}`, 'muted small'));
    // A finished automatic answer arrives folded, so it never pushes the board around while you listen (decision G2).
    if (latest.origin === 'auto' && latest.state === 'done') {
      const fold = el('details', undefined, 'auto-answer');
      fold.dataset.key = `auto-${latest.id}`;
      fold.append(el('summary', 'Answer ready (automatic) · Show'), holder);
      node.append(fold);
    } else node.append(holder);
  }
  return node;
}

/** First card visible in the board pane and its offset, so inserts above it never move what is being read. */
function anchorOf(pane) {
  const top = pane.getBoundingClientRect().top;
  const node = [...pane.querySelectorAll('[data-card]')].find(n => n.getBoundingClientRect().bottom > top + 1);
  return node ? { id: node.dataset.card, offset: node.getBoundingClientRect().top - top } : null;
}
/** What the user has open or typed inside a card, so a refresh of the card keeps it. */
function captureState(node) {
  const active = document.activeElement;
  return {
    open: new Set([...node.querySelectorAll('details[open]')].map(d => `${d.closest('[data-id]')?.dataset.id ?? ''}:${d.dataset.key ?? d.className}`)),
    full: new Set([...node.querySelectorAll('.answer:not(.compact)')].map(a => a.closest('[data-id]')?.dataset.id).filter(Boolean)),
    forms: [...node.querySelectorAll('form')].map(form => {
      const field = form.querySelector('input, textarea');
      const key = field?.dataset.key ?? `follow-${form.closest('[data-id]')?.dataset.id}`;
      return field ? { key, value: field.value, hidden: form.hidden, focused: active === field, at: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null;
    }).filter(Boolean),
  };
}
function restoreState(node, state) {
  for (const d of node.querySelectorAll('details')) if (state.open.has(`${d.closest('[data-id]')?.dataset.id ?? ''}:${d.dataset.key ?? d.className}`)) d.open = true;
  for (const id of state.full) {
    const body = node.querySelector(`[data-id="${CSS.escape(id)}"] .answer.compact`);
    if (body) { body.classList.remove('compact'); const more = body.nextElementSibling; if (more?.classList.contains('link-button')) more.textContent = 'Show less'; }
  }
  for (const form of node.querySelectorAll('form')) {
    const field = form.querySelector('input, textarea');
    const key = field?.dataset.key ?? `follow-${form.closest('[data-id]')?.dataset.id}`;
    const saved = state.forms.find(f => f.key === key);
    if (!saved || !field) continue;
    field.value = saved.value;
    form.hidden = saved.hidden;
    if (saved.focused) boardView.refocus = () => { field.focus({ preventScroll: true }); field.setSelectionRange?.(saved.at ?? field.value.length, saved.end ?? saved.at ?? field.value.length, saved.direction ?? 'none'); };
  }
}
/** Everything under a job that can change what its card shows: state, status, draft presence, summary, and all descendants. */
function jobTree(job, depth = 0) {
  return [job.id, job.state, job.status.at(-1), Boolean(job.draft), job.result?.summary,
    depth < 6 ? actionsView.jobs.filter(j => j.parentId === job.id).map(j => jobTree(j, depth + 1)) : []];
}
function renderBoard(owner) {
  const data = boardView.data;
  const container = $('board-cards');
  const restoreFocus = rememberFocus(container);
  renderPinned(owner);
  const pane = $('board-panel');
  const anchor = pane.scrollTop > 0 ? anchorOf(pane) : null;
  const all = data.cards;
  const dismissedCount = all.filter(c => c.dismissed && !boardView.undo.has(c.id)).length;
  $('show-dismissed').hidden = !dismissedCount && !boardView.showDismissed;
  $('show-dismissed').textContent = boardView.showDismissed ? 'Hide dismissed' : `Show dismissed (${dismissedCount})`;
  const visible = all.filter(c => (!c.dismissed || boardView.showDismissed || boardView.undo.has(c.id)) && (boardView.stage === 'all' || stageOf(c) === boardView.stage));
  // The first snapshot is the meeting's baseline; only later cards get dots and arrival counts.
  for (const c of all) if (!boardView.seen.has(c.id)) {
    boardView.seen.add(c.id);
    if (boardView.initialised) {
      boardView.unread.add(c.id);
      if (!boardVisible()) boardView.away.add(c.id);
    }
  }
  boardView.initialised = true;
  const keep = new Set();
  const nodeFor = card => {
    keep.add(card.id);
    const job = cardJobs(card).at(-1);
    const sig = JSON.stringify([card.type, card.text, card.dismissed, card.auto, card.occurrences.length, stageOf(card), boardView.unread.has(card.id), boardView.undo.has(card.id),
      card.attempts, job && jobTree(job)]);
    let entry = boardView.nodes.get(card.id);
    if (!entry || entry.sig !== sig) {
      const state = entry ? captureState(entry.node) : null;
      const node = boardCard(card, owner);
      if (state) restoreState(node, state);
      if (entry) entry.node.replaceWith(node);
      entry = { node, sig };
      boardView.nodes.set(card.id, entry);
    }
    return entry.node;
  };
  const children = [];
  /** A collapsible group whose open state survives re-renders (keyed by name). */
  const group = (key, label, cards, openByDefault, hint) => {
    let box = boardView.groups.get(key);
    if (!box) { box = el('details', undefined, 'board-group'); box.open = openByDefault; boardView.groups.set(key, box); }
    const summary = box.querySelector(':scope > summary') ?? el('summary');
    summary.textContent = label;
    summary.title = hint ?? '';
    box.replaceChildren(summary, ...cards.map(nodeFor));
    return box;
  };
  if (boardView.sort === 'time') {
    // Newest first; every non-project card (travel, admin…) goes into one folded group at the end, so none buries research items.
    const sorted = [...visible].sort((a, b) => b.createdAt - a.createdAt || b.firstMs - a.firstMs);
    for (const card of sorted) if (card.type !== 'other') children.push(nodeFor(card));
    const others = sorted.filter(c => c.type === 'other');
    if (others.length) children.push(group('other-matters', `${others.length} other matter${others.length > 1 ? 's' : ''}${others.some(c => boardView.unread.has(c.id)) ? ' · new' : ''}`, others, false, 'Not about the project: travel, admin, equipment…'));
  } else {
    for (const [title, types] of GROUPS) {
      const cards = visible.filter(c => types.includes(c.type)).sort((a, b) => a.firstMs - b.firstMs);
      if (!cards.length) continue;
      const fresh = cards.filter(c => boardView.unread.has(c.id)).length;
      children.push(group(title, `${title} · ${cards.length}${fresh ? ` (+${fresh} new)` : ''}`, cards, title !== 'Other matters'));
    }
  }
  container.replaceChildren(...children);
  // Focus is restored only once the card is attached in its final place (moving a node drops focus).
  if (boardView.refocus) { const refocus = boardView.refocus; boardView.refocus = null; refocus(); }
  restoreFocus();
  // Streaming drafts and elapsed times update in place, without rebuilding cards.
  for (const job of actionsView.jobs) {
    const holder = container.querySelector(`[data-id="${CSS.escape(job.id)}"]`);
    if (!holder) continue;
    const pre = holder.querySelector(':scope > .draft .draft-text');
    if (pre && pre.textContent !== job.draft) pre.textContent = job.draft;
    const state = holder.querySelector(':scope > .action-head .action-state');
    if (state && job.state !== 'done') state.textContent = stateText(job);
  }
  for (const [id] of boardView.nodes) if (!keep.has(id)) boardView.nodes.delete(id);
  const anchored = anchor && container.querySelector(`[data-card="${CSS.escape(anchor.id)}"]`);
  if (anchored) pane.scrollTop += anchored.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset;
  const fresh = [...boardView.unread].filter(id => visible.some(c => c.id === id)).length;
  $('new-cards').hidden = !fresh || pane.scrollTop < 40;
  $('new-cards').textContent = `● ${fresh} new card${fresh > 1 ? 's' : ''}`;
  const empty = !all.length && !actionsView.jobs.length;
  $('board-empty').hidden = !empty;
  // With cloud models off nothing will arrive: say so plainly instead of promising cards.
  $('board-empty').replaceChildren(...(data.enabled ? [
    (() => { const p = el('p'); p.append(el('strong', 'While you listen,'), ' the quick model reads the transcript about once a minute and adds cards: questions, claims to check, decisions and actions, anchored to the moment they were said.'); return p; })(),
    el('p', 'Select words in the transcript to ask, explain, compute or look something up yourself.', 'muted'),
  ] : [el('p', 'Cards need AI models, which are off. The transcript and your notes stay on this Mac.', 'muted')]));
  $('scan-board').disabled = !data.enabled;
  $('scan-board').hidden = !data.enabled;
  // The filters and order only matter once there are cards.
  $('stage-filter').closest('.board-filter').hidden = !all.length;
  $('board-sort').hidden = notesView.tab !== 'board' || !all.length; // a board control, on the Board tab only
  $('scan-board').title = "Let the quick model read this meeting's transcript and propose cards";
  renderAutoAnswers();
  const state = !data.enabled ? '' : data.pausedUntil ? `Paused after a rate limit until ${new Date(data.pausedUntil).toLocaleTimeString()}.`
    : data.scanning ? 'Reading the transcript…' : data.catchingUp ? 'Catching up…' : data.lastError ? `Last scan failed: ${data.lastError}` : '';
  $('board-state').textContent = [state, data.warning ? `⚠ ${data.warning}` : '',
    data.gaps?.length ? `${data.gaps.length} stretch(es) not scanned` : ''].filter(Boolean).join(' · ');
  markTranscript(owner);
  updateBoardBadge();
}
/** One mark per transcript paragraph that has cards; clicking it opens the Board at the card. */
function markTranscript(owner) {
  $('transcript').querySelectorAll('.para-mark').forEach(m => m.remove());
  const byPara = new Map();
  for (const card of boardView.data?.cards ?? []) {
    if (card.dismissed) continue;
    const span = $('transcript').querySelector(`span[data-id="${CSS.escape(card.occurrences[0].lines[0].id)}"]`);
    const para = span?.closest('.para');
    if (para) byPara.set(para, [...(byPara.get(para) ?? []), card]);
  }
  for (const [para, cards] of byPara) {
    const mark = el('button', cards.length > 1 ? String(cards.length) : '', 'para-mark');
    mark.title = cards.map(c => `${TYPE_LABELS[c.type]}: ${c.text}`).join('\n');
    mark.onclick = () => { if (sameMeeting(owner)) revealCard(owner, cards[0].id); };
    para.append(mark);
  }
}
async function refreshBoard() {
  if (!meetingId) return;
  const owner = meetingId;
  const sequence = ++boardView.sequence;
  try {
    const data = await api(`/api/meetings/${owner}/board`);
    if (owner !== meetingId || sequence !== boardView.sequence) return;
    if (boardView.owner !== owner) resetBoardView(owner);
    for (const [id, until] of boardView.undo) if (until < Date.now()) boardView.undo.delete(id);
    boardView.data = data;
    renderBoard(owner);
  } catch (error) { if (owner === meetingId && sequence === boardView.sequence) $('board-state').textContent = error.message; }
}
/** Opens the Board (the compact Board tab too) at a card, showing all stages if a filter hides it. */
function revealCard(owner, cardId) {
  closePanel();
  const switched = layoutView.compact ? layoutView.tab !== 'board' : notesView.tab !== 'board';
  openPane('board', true);
  let node = $('board-cards').querySelector(`[data-card="${CSS.escape(cardId)}"]`);
  if (!node && boardView.stage !== 'all') {
    boardView.stage = 'all';
    $('stage-filter').value = 'all';
    renderBoard(owner);
    node = $('board-cards').querySelector(`[data-card="${CSS.escape(cardId)}"]`);
  }
  if (!node) { log('That card is dismissed; use "Show dismissed" to see it.', true); return; }
  for (let d = node.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  node.scrollIntoView({ block: 'center', behavior: switched ? 'auto' : 'smooth' });
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus({ preventScroll: true });
}
/** Compact only: the newest card that is not dismissed, as one line above the live transcript. */
function renderPinned(owner) {
  const button = $('pinned-card');
  const newest = newestCard(owner);
  button.hidden = !newest;
  if (!newest) return;
  const signature = JSON.stringify([newest.id, newest.text, stageOf(newest)]);
  if (button.dataset.signature === signature) return;
  button.dataset.signature = signature;
  const stage = stageOf(newest);
  const tag = `${TYPE_LABELS[newest.type]} · ${stamp(newest.firstMs)}${stage === 'meeting' ? '' : ` · ${STAGE_LABELS[stage]}`}`;
  button.replaceChildren(el('span', tag, 'pinned-tag'), el('span', newest.text, 'pinned-text'));
  button.title = `Newest card: ${newest.text}`;
  button.setAttribute('aria-label', `Newest card, ${tag}: ${newest.text}. Opens it on the Board.`);
  button.onclick = () => { if (sameMeeting(owner)) revealCard(owner, newest.id); };
}
function resetBoardView(owner) {
  boardView.nodes.clear(); boardView.groups.clear(); boardView.seen.clear(); boardView.unread.clear(); boardView.away.clear(); boardView.undo.clear();
  Object.assign(boardView, { owner, data: null, initialised: false });
  $('board-cards').replaceChildren();
  $('pinned-card').hidden = true;
  renderAutoAnswers();
  delete $('pinned-card').dataset.signature;
}
$('board-panel').addEventListener('scroll', () => {
  // Cards scrolled into view count as read.
  if ($('board-panel').scrollTop < 40 && boardView.unread.size) { boardView.unread.clear(); if (boardView.data) renderBoard(boardView.owner); }
});
$('new-cards').onclick = () => { $('board-panel').scrollTo({ top: 0, behavior: 'smooth' }); };
$('stage-filter').onchange = () => {
  boardView.stage = $('stage-filter').value;
  if (boardView.data) renderBoard(boardView.owner);
};
// One toggle (it fits on the tabs' line): it shows the current order and switches to the other.
const setSort = sort => {
  boardView.sort = sort;
  store.set('board-sort', sort);
  $('board-sort').textContent = sort === 'time' ? 'Time ⇅' : 'Type ⇅';
  $('board-sort').setAttribute('aria-label', `Cards in order of ${sort}. Switch to ${sort === 'time' ? 'type' : 'time'}`);
  if (boardView.data) renderBoard(boardView.owner);
};
$('board-sort').onclick = () => setSort(boardView.sort === 'time' ? 'type' : 'time');
setSort(boardView.sort);
$('show-dismissed').onclick = () => { boardView.showDismissed = !boardView.showDismissed; if (boardView.data) renderBoard(boardView.owner); };
$('scan-board').onclick = guarded(async () => { await post(`${base()}/board/scan`); log('Scanning this meeting for board cards.'); await refreshBoard(); });

// ---------- Settings: automatic answers, the live board's model, and the mini window ----------
function renderAutoAnswers() {
  const used = boardView.owner === meetingId ? boardView.data?.autoUsed ?? 0 : 0;
  $('auto-answers-detail').textContent = 'Up to 5 per meeting.' + (!$('auto-answers').checked
    ? ' You can still press Answer on a question.' : used > 0 ? ` ${used} used so far.` : '');
}
async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    $('audio-retention').value = settings.audioRetention;
    $('board-model').value = settings.boardModel;
    $('auto-answers').checked = settings.autoAnswers !== false;
    $('auto-answers').closest('label').hidden = !settings.autoAnswersEnabled;
    renderAutoAnswers();
    $('board-model').disabled = !settings.boardEnabled;
    $('settings-ai-change').hidden = !!settings.aiForcedOff;
    $('board-model').closest('label').hidden = settings.aiMode !== undefined && settings.aiMode !== 'cloud';
    $('mini-by-itself').checked = mini.byItself = settings.miniOpensItself;
  } catch (error) { log(error.message, true); }
}
$('board-model').onchange = guarded(async () => {
  const settings = await send('/api/settings', 'PUT', { boardModel: $('board-model').value });
  log(`Live board now uses ${settings.boardModels.find(m => m.id === settings.boardModel).model}; it applies from the next scan.`);
});
$('auto-answers').onchange = guarded(async () => {
  renderAutoAnswers();
  try { await send('/api/settings', 'PUT', { autoAnswers: $('auto-answers').checked }); }
  finally { await loadSettings(); }
});
// A failed save shows its error by the box and puts the box back as it was.
$('mini-by-itself').onchange = guarded(async () => {
  mini.saves++;
  try { mini.byItself = (await send('/api/settings', 'PUT', { miniOpensItself: $('mini-by-itself').checked })).miniOpensItself; }
  finally { mini.saves++; $('mini-by-itself').checked = mini.byItself; }
});
$('audio-retention').onchange = guarded(async () => {
  try { await send('/api/settings', 'PUT', { audioRetention: $('audio-retention').value }); }
  finally { await loadSettings(); }
});
function renderOlderAudio(notice) {
  $('older-audio').hidden = !notice;
  if (notice) $('older-audio-text').textContent = `Remove the audio of ${notice.count} older meetings (${(notice.bytes / 1_000_000).toFixed(1)} MB)? Transcripts and notes are kept.`;
}
function renderAudioRemoved(meeting) {
  $('audio-removed').hidden = meeting?.audioRemovedAt == null;
  $('audio-removed').textContent = meeting?.audioRemovedAt != null ? `Audio removed after ${meeting.audioRemovedAfter}` : '';
}
for (const answer of ['remove', 'keep']) $(answer === 'remove' ? 'remove-older-audio' : 'keep-older-audio').onclick = guarded(async () => {
  await post('/api/audio-retention', { answer });
  renderOlderAudio(null);
  await refreshStatus(); await refreshDetail();
});
void loadSettings();

// ---------- Meetings, replay, materials, glossary ----------

// The meeting menu: switch, new, rename, replay. A WAI-ARIA menu button: arrows move, Home/End jump, Escape or Tab closes.
function meetingWhen(m) {
  const day = new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return new Date(m.createdAt).toDateString() === new Date().toDateString() ? 'today' : day;
}
function renderMeetingMenu() {
  const current = status?.meetings.find(m => m.id === meetingId);
  $('meeting-title').textContent = current?.title ?? (status?.meetings.length ? 'Choose a meeting' : 'No meetings yet');
  // The project shows as a small label above the meeting's name; the menu lists that project's meetings (or those without one).
  const project = projectView.projects.find(p => p.id === current?.projectId);
  $('meeting-project').textContent = project?.name ?? '';
  $('meeting-project').hidden = !project;
  const scope = projectView.menuProject !== undefined ? projectView.menuProject : current?.projectId ?? null;
  const scopeName = projectView.projects.find(p => p.id === scope)?.name;
  $('meeting-list-label').textContent = scope ? `${scopeName ?? 'Project'} · meetings` : projectView.projects.length ? 'Meetings without a project' : 'Meetings';
  $('switch-project').hidden = !projectView.projects.length;
  $('move-meeting').disabled = !meetingId;
  keepFocus($('meeting-list'), () => $('meeting-list').replaceChildren(...(status?.meetings ?? []).filter(m => (m.projectId ?? null) === scope).map(m => {
    const item = focusKey(el('button', undefined, 'menu-item'), m.id);
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(m.id === meetingId));
    item.tabIndex = -1;
    item.append(el('span', m.title), el('span', meetingWhen(m), 'when'));
    item.onclick = () => { closeMeetingMenu(true); projectView.menuProject = undefined; selectMeeting(m.id); void refreshStatus(); };
    return item;
  })));
  controls();
}
function menuItems() { return [...$('meeting-menu').querySelectorAll('[role^="menuitem"]')].filter(n => !n.disabled && !n.hidden); }
function openMeetingMenu(focusLast = false) {
  closePanel();
  $('meeting-menu').hidden = false;
  $('meeting-button').setAttribute('aria-expanded', 'true');
  for (const n of $('meeting-menu').querySelectorAll('[role^="menuitem"]')) n.tabIndex = -1;
  const items = menuItems();
  (focusLast ? items.at(-1) : items[0])?.focus();
}
function closeMeetingMenu(returnFocus = false) {
  if ($('meeting-menu').hidden) return;
  projectView.menuProject = undefined; // the next opening shows the current meeting's project again
  $('meeting-menu').hidden = true;
  $('meeting-button').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('meeting-button').focus();
}
$('meeting-button').onclick = () => { if ($('meeting-menu').hidden) openMeetingMenu(); else closeMeetingMenu(); };
$('meeting-button').addEventListener('dblclick', () => { closeMeetingMenu(); startRename(); });
$('meeting-button').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); openMeetingMenu(); }
  if (event.key === 'ArrowUp') { event.preventDefault(); openMeetingMenu(true); }
});
$('meeting-menu').addEventListener('keydown', event => {
  const items = menuItems();
  const at = items.indexOf(document.activeElement);
  const go = i => { event.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
  if (event.key === 'ArrowDown') go(at + 1);
  else if (event.key === 'ArrowUp') go(at - 1);
  else if (event.key === 'Home') go(0);
  else if (event.key === 'End') go(items.length - 1);
  else if (event.key === 'Escape') { event.preventDefault(); closeMeetingMenu(true); }
  else if (event.key === 'Tab') closeMeetingMenu();
  else if (event.key === ' ' && document.activeElement?.tagName === 'A') {
    event.preventDefault(); document.activeElement.click();
  }
});
$('meeting-menu').addEventListener('click', event => {
  if (event.target.closest?.('a[download]')) closeMeetingMenu();
});
document.addEventListener('click', event => { if (!event.target.closest?.('.meeting-wrap')) closeMeetingMenu(); });
// Rename in place: the name becomes a text field; Enter or leaving it saves, Escape cancels.
function startRename(selectAll = true) {
  if (!meetingId) return;
  const field = $('meeting-name');
  field.value = status?.meetings.find(m => m.id === meetingId)?.title ?? '';
  field.dataset.owner = meetingId;
  $('meeting-button').hidden = true;
  field.hidden = false;
  field.focus();
  if (selectAll) field.select();
}
async function finishRename(save) {
  const field = $('meeting-name');
  if (field.hidden) return;
  const hadFocus = document.activeElement === field;
  field.hidden = true;
  $('meeting-button').hidden = false;
  if (hadFocus) $('meeting-button').focus(); // keyboard users continue from the name
  const title = field.value.trim();
  const owner = field.dataset.owner;
  if (!save || !title || !owner || title === status?.meetings.find(m => m.id === owner)?.title) return;
  await send(`/api/meetings/${owner}`, 'PATCH', { title });
  await refreshStatus();
}
$('rename-meeting').onclick = () => { closeMeetingMenu(); startRename(); };
$('meeting-name').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void guarded(() => finishRename(true))(); }
  if (event.key === 'Escape') { event.preventDefault(); void finishRename(false); $('meeting-button').focus(); }
});
$('meeting-name').addEventListener('blur', () => { void guarded(() => finishRename(true))(); });
// New meeting: created with today's date as its name, which is ready to be typed over.
$('new-meeting').onclick = guarded(async () => {
  if (capture) return;
  // The project the menu shows (after "Show another project’s meetings…"), read before closing the menu clears it.
  const projectId = menuProjectId();
  closeMeetingMenu();
  const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const meeting = await post('/api/meetings', { title: `Meeting ${stamp}`, ...(projectId ? { projectId } : {}) });
  selectMeeting(meeting.id);
  await refreshStatus();
  log('Created a new meeting. Recording has not started.');
  startRename();
});
$('open-replay').onclick = () => { projectView.replayProject = menuProjectId(); closeMeetingMenu(); $('replay-dialog').showModal(); };
function menuProjectId() { return projectView.menuProject !== undefined ? projectView.menuProject : status?.meetings.find(m => m.id === meetingId)?.projectId ?? null; }
$('close-replay').onclick = () => $('replay-dialog').close();
$('replay-dialog').addEventListener('close', () => $('meeting-button').focus()); // its opener was in the closed menu

// Settings: one dialog with a sidebar of sections (This meeting: materials, glossary, export; This Mac: setup, microphone, mini window,
// speech, cloud models, activity). The materials chip opens it at Materials, the cog at Microphone. Escape and Close shut it.
let setupSnapshot;
function setupStatusChanged(snapshot) {
  setupSnapshot = snapshot;
  const ai = snapshot.rows.find(row => row.id === 'ai');
  $('settings-ai-change').hidden = !!ai.forcedOff;
  $('setup-web').hidden = ai.mode !== 'local' || ai.web !== false;
  if (ai.mode === 'local') $('setup-web').replaceChildren('Web lookups are unavailable in On this Mac mode.');
  else $('setup-web').replaceChildren();
  renderStatusDot();
}
const setupUi = new SetupUI($('setup-settings'), { details: true, onStatus: setupStatusChanged,
  onSaved: () => Promise.all([refreshStatus(), loadSettings()]),
  onError(error) { $('setup-settings-error').hidden = !error; $('setup-settings-error').textContent = error?.message.replace(/'/g, '’') ?? ''; },
});
$('settings-ai-change').onclick = guarded(async () => {
  const snapshot = await setupUi.refresh({ background: true });
  if (await aiDialog(snapshot.rows.find(r => r.id === 'ai'), options => setupUi.refresh({ ...options, background: true }))) await Promise.all([refreshStatus(), loadSettings()]);
});
for (const [id, change] of [['ai-notice-change', true], ['ai-notice-keep', false]]) $(id).onclick = guarded(async () => {
  const snapshot = await setupRequest('/api/setup/ai/notice', 'POST'); $('ai-cloud-notice').hidden = true;
  $('open-system').focus(); // The disappearing notice cannot be a dialog's return-focus target.
  if (change && await aiDialog(snapshot.rows.find(r => r.id === 'ai'), options => setupUi.refresh({ ...options, background: true }))) await Promise.all([refreshStatus(), loadSettings()]);
});
window.addEventListener('pagehide', () => setupUi.stop({ dispose: true }));
// The same sequence guard owns initial, action and foreground reads. No idle setup polling.
let foregroundSetup;
function refreshSetupSnapshot({ recheck = false } = {}) {
  foregroundSetup ??= (async () => {
    // GET is a cached snapshot. A Terminal install needs one bounded OS recheck, not idle polling.
    if (recheck) {
      try { await setupRequest('/api/setup/recheck', 'POST'); }
      catch (error) { setupUi.onError(error); return; }
    }
    return setupUi.refresh({ background: true });
  })().finally(() => { foregroundSetup = null; });
  return foregroundSetup;
}
void refreshSetupSnapshot();
function refreshSpeechOff() {
  if ($('status-dot').classList.contains('error') && !setupUi.checkingRow && !setupUi.pendingActions.has('speech')) void refreshSetupSnapshot({ recheck: true });
}
window.addEventListener('focus', refreshSpeechOff);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSpeechOff(); });
function showSettingsSection(name) {
  if (name === 'setup') void setupUi.start(setupSnapshot); else setupUi.stop();
  if (name === 'cloud') void refreshSetupSnapshot();
  for (const section of $('settings').querySelectorAll('.settings-section')) section.hidden = section.dataset.section !== name;
  for (const button of $('settings').querySelectorAll('.settings-nav button')) {
    button.setAttribute('aria-current', button.dataset.section === name ? 'page' : 'false');
    button.tabIndex = button.dataset.section === name ? 0 : -1; // Tab goes to the section; arrows move between sections
  }
  store.set('settings-section', name);
  // Which scope the section is about: the project (project, and its materials and glossary), this meeting, or this Mac.
  const title = status?.meetings.find(m => m.id === meetingId)?.title;
  const project = projectView.project;
  $('settings-meeting').textContent = name === 'project' ? (project ? `This project: ${project.name}` : `This meeting: ${title ?? ''}`)
    : ['materials', 'glossary'].includes(name) && project ? `This project: ${project.name}`
    : ['materials', 'glossary', 'export'].includes(name) && title ? `This meeting: ${title}` : 'This Mac';
  if (name === 'microphone') void listMicrophones();
  if (name === 'project') renderPlanSetting();
}
function openSettings(name) {
  closeMeetingMenu();
  closeSelectionMenu();
  renderSettingsNav();
  showSettingsSection(name);
  if (!$('settings').open) $('settings').showModal();
  $('settings').querySelector(`.settings-nav button[data-section="${name}"]`)?.focus();
  void refreshDetail();
}
/** Closes the settings dialog if it is open (kept under the old name: tab switches and actions call it). */
function closePanel() { if ($('settings').open) $('settings').close(); }
for (const button of $('settings').querySelectorAll('.settings-nav button')) button.onclick = () => showSettingsSection(button.dataset.section);
$('settings').querySelector('.settings-nav').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const buttons = [...$('settings').querySelectorAll('.settings-nav button')];
  const at = buttons.indexOf(document.activeElement);
  if (at < 0) return;
  event.preventDefault();
  const next = buttons[(at + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
  next.focus();
  showSettingsSection(next.dataset.section);
});
$('open-meeting').onclick = () => openSettings('materials');
// With a warning on the dot, the cog opens where the problem is.
$('open-system').onclick = () => openSettings($('status-dot').classList.contains('error') ? 'setup' : $('status-dot').classList.contains('warn') ? 'speech' : 'microphone');
$('close-settings').onclick = () => $('settings').close();
$('settings').addEventListener('close', () => { micTest?.stop(); setupUi.stop(); });
// A click on the dimmed backdrop closes it too.
$('settings').addEventListener('click', event => { if (event.target === $('settings')) $('settings').close(); });
/** "Materials: <first> · Glossary v<N>" (short in compact), or "Add materials". */
function renderMeetingChip() {
  const roots = detail?.materials ?? [];
  const glossary = lastSnapshot?.correction?.glossary;
  const full = roots.length ? `Materials: ${roots[0].label}${roots.length > 1 ? ` +${roots.length - 1}` : ''}${glossary ? ` · Glossary v${glossary.version}` : ''}` : 'Add materials';
  $('open-meeting').textContent = layoutView.compact ? (roots.length ? 'Materials' : 'Add materials') : full;
  $('open-meeting').title = `This meeting: materials, glossary and export${roots.length ? ` (${full})` : ''}`;
}
/** Green: ready with cloud models. Grey "Local": ready without them (a normal setup). Amber: audio waiting or failed. Red: no local model. */
function renderStatusDot() {
  if (!status) return;
  const failed = (detail?.chunks ?? []).filter(c => c.status === 'failed').length;
  const speech = setupSnapshot?.rows.find(row => row.id === 'speech');
  const speechReady = speech ? speech.state === 'ready' && !speech.pending : status.config.available;
  const [kind, word, label] = !speechReady ? ['error', 'Speech off', 'Speech needs setup on this Mac']
    : failed ? ['warn', `${failed} failed`, `${failed} piece(s) of audio failed to transcribe`]
    // A queue is normal (each 16–24 s piece passes through it; a replay queues its whole file): only a live backlog is a problem.
    : capture && status.queued > 3 ? ['warn', `${status.queued} waiting`, `Transcription is falling behind: ${status.queued} pieces of audio waiting`]
    : !status.capabilities.cloudModels ? ['local', '', 'Ready; AI models are off, nothing leaves this Mac']
    : ['ok', '', 'Ready'];
  // Nothing to show when all is well: the dot appears only for a problem (amber, red); local-only mode is just the word "Local".
  $('status-dot').className = `status-dot ${kind}`;
  $('status-dot').hidden = kind === 'ok' || kind === 'local';
  $('status-word').textContent = word;
  $('open-system').setAttribute('aria-label', `Settings: ${label}`);
  $('open-system').title = label;
}
$('replay').onclick = guarded(async () => {
  const file = $('replay-file').files[0];
  if (!file) throw new Error('Choose an audio or video file to replay.');
  busy = true; controls();
  try {
    // A replay joins the project the menu showed when the dialog opened, as a new meeting does.
    const projectId = projectView.replayProject ?? null;
    const meeting = await post('/api/meetings', { title: `${file.name} (replay)`, ...(projectId ? { projectId } : {}) });
    log(`Uploading ${file.name} for local transcription…`);
    await api(`/api/meetings/${meeting.id}/upload`, { method: 'POST', body: file });
    await post(`/api/meetings/${meeting.id}/replay`, { speed: Number($('replay-speed').value) });
    selectMeeting(meeting.id);
    await refreshStatus();
    $('replay-dialog').close();
    log(`Replaying at ${$('replay-speed').value}×.`);
  } finally { busy = false; controls(); }
});
for (const [field, button] of [['material-path', 'attach'], ['query', 'search']]) {
  $(field).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $(button).click(); } });
}
$('attach').onclick = guarded(async () => {
  const path = $('material-path').value.trim();
  if (!path) throw new Error('Enter a file or folder path.');
  if (!confirm(`Grant read-only access to this file/folder?\n${path}\n\nIf you build a glossary, excerpts are sent to OpenAI through Pi.`)) return;
  await post(`${base()}/materials`, { path, ...(detail?.project ? { scope: $('material-scope').value } : {}) });
  $('material-path').value = '';
  await refreshDetail();
  log('Material attached with read-only access.');
});
$('search').onclick = guarded(async () => {
  const owner = meetingId;
  const result = await api(`${base()}/search?q=${encodeURIComponent($('query').value)}`);
  if (owner !== meetingId) return;
  $('search-results').replaceChildren(...result.hits.map(hit => el('div', `${hit.file}${hit.page ? ` p. ${hit.page}` : ''}${hit.line === null ? '' : `:${hit.line}`}\n${hit.text}`, 'hit')));
  if (!result.hits.length) $('search-results').textContent = 'No matches in the attached materials.';
  log(`Search: ${result.scanned} files, ${result.hits.length} hits${result.unread?.length ? `, ${result.unread.length} PDFs without text (${result.unread.slice(0, 3).join('; ')})` : ''}${result.errors.length ? `, ${result.errors.length} unreadable` : ''}${result.limited ? ', limit reached' : ''}.`);
});
$('build-glossary').onclick = guarded(async () => {
  await post(`${base()}/glossary/build`, {});
  log('Building the glossary with the heavy model; this can take a few minutes.');
});
$('edit-glossary').onclick = guarded(async () => {
  const owner = meetingId;
  const { glossary } = await api(`${base()}/glossary`);
  if (owner !== meetingId) return; // the user switched meetings while this loaded
  glossaryOwner = owner;
  $('glossary-editor').value = (glossary?.terms ?? []).map(t => `${t.term}${t.spokenVariants.length ? ` | ${t.spokenVariants.join('; ')}` : ''}`).join('\n');
  $('glossary-editor').hidden = false;
  $('save-glossary').hidden = false;
});
$('save-glossary').onclick = guarded(async () => {
  const terms = $('glossary-editor').value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [term, variants = ''] = line.split('|');
    return { term: term.trim(), spokenVariants: variants.split(';').map(v => v.trim()).filter(Boolean) };
  });
  if (!glossaryOwner || glossaryOwner !== meetingId) throw new Error('This editor belongs to another meeting; open the glossary again.');
  const saved = await send(`/api/meetings/${glossaryOwner}/glossary`, 'PUT', { terms });
  log(`Glossary saved (version ${saved.version}). Your edits win over future rebuilds.`);
});
$('retry').onclick = guarded(async () => { await post(`${base()}/retry`); await refreshDetail(); });

// ---------- Microphone settings: device, room mode, level meter (per browser: the device is this Mac's) ----------

// Room mode is the default for in-person recording; "0" turns it off.
const micSettings = { deviceId: store.get('mic-device') || '', room: store.get('room-mode') !== '0' };
$('room-mode').checked = micSettings.room;
/** In person, room mode turns off processing tuned for a close talker; online keeps echo cancellation (the call plays aloud). */
function micConstraints(online) {
  const room = micSettings.room && !online;
  return { ...(micSettings.deviceId ? { deviceId: { exact: micSettings.deviceId } } : {}), channelCount: 1,
    echoCancellation: !room, noiseSuppression: !room, autoGainControl: true };
}
function captureSettings(kind, stream, online = false) {
  const track = stream.getAudioTracks()[0];
  const applied = track?.getSettings?.() ?? {};
  return kind === 'tab' ? { kind } : { kind, device: (track?.label || 'default').slice(0, 120), roomMode: micSettings.room && !online,
    echoCancellation: track?.hearAlongEcho ?? applied.echoCancellation ?? false, noiseSuppression: Boolean(applied.noiseSuppression), autoGainControl: Boolean(applied.autoGainControl) };
}
async function listMicrophones() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default');
    $('mic-device').replaceChildren(el('option', 'System default'), ...devices.map((d, i) => { const o = el('option', d.label || `Microphone ${i + 1}`); o.value = d.deviceId; return o; }));
    $('mic-device').firstChild.value = '';
    $('mic-device').value = devices.some(d => d.deviceId === micSettings.deviceId) ? micSettings.deviceId : '';
  } catch { /* the list stays as it is */ }
}
$('mic-device').onchange = () => { micSettings.deviceId = $('mic-device').value; store.set('mic-device', micSettings.deviceId); $('mic-hint').textContent = 'Applies to the next recording.'; };
$('room-mode').onchange = () => { micSettings.room = $('room-mode').checked; store.set('room-mode', micSettings.room ? '1' : '0'); $('mic-hint').textContent = 'Applies to the next in-person recording.'; };
let level = null; // { analyser, frame, quietSince }
function watchLevel(context, input) {
  stopLevel();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  input.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  level = { analyser, frame: 0, quietSince: null };
  const tick = () => {
    if (!level || level.analyser !== analyser) return;
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length);
    const db = Math.max(-60, Math.min(0, 20 * Math.log10(rms + 1e-9)));
    const meter = $('mic-meter');
    meter.firstElementChild.style.width = `${Math.round((db + 60) / 60 * 100)}%`;
    meter.setAttribute('aria-valuenow', String(Math.round(db)));
    const quiet = db < -50;
    meter.classList.toggle('quiet', quiet);
    level.quietSince = quiet ? level.quietSince ?? Date.now() : null;
    if (level.quietSince && Date.now() - level.quietSince > 4000) $('mic-hint').textContent = 'Very quiet for a few seconds. If people are talking, move the laptop closer, or try Room mode for the next recording.';
    level.frame = requestAnimationFrame(tick);
  };
  tick();
}
function stopLevel() {
  if (!level) return;
  cancelAnimationFrame(level.frame);
  try { level.analyser.disconnect(); } catch { /* already gone */ }
  level = null;
  $('mic-meter').firstElementChild.style.width = '0%';
  $('mic-meter').setAttribute('aria-valuenow', '-60');
}
/** A 10 s look at the level with the settings the next in-person recording will use; nothing is saved. */
let micTest = null; // { stop } while a level test runs
$('mic-test').onclick = guarded(async () => {
  if (capture) { $('mic-hint').textContent = 'Recording: the meter shows the live microphone.'; return; }
  listen.recording(true);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(false), video: false });
  const context = new AudioContext();
  try {
    await listMicrophones(); // labels appear once permission is granted
    watchLevel(context, context.createMediaStreamSource(stream));
    $('mic-test').disabled = true;
    $('mic-hint').textContent = `Testing ${stream.getAudioTracks()[0]?.label || 'the microphone'}${micSettings.room ? ' in room mode' : ''}… speak at your normal distance.`;
    // Ends after 10 s, or at once when the dialog closes or recording starts: the microphone is never left open.
    const ended = await new Promise(resolve => { const timer = setTimeout(() => resolve(false), 10_000); micTest = { stop: () => { clearTimeout(timer); resolve(true); } }; });
    $('mic-hint').textContent = ended ? 'Test stopped. Nothing was recorded.' : 'Test finished. Nothing was recorded.';
  } finally {
    micTest = null;
    stopLevel();
    stream.getTracks().forEach(track => track.stop());
    await context.close();
    $('mic-test').disabled = false;
  }
});

// ---------- Capture: microphone (Me) and one meeting tab or app (Them), on the same meeting timeline ----------

/** The current recording session, or undefined. Each source has its own queue and end; the session ends when all have. */
// capture = { owner, path, context, offsetMs, generation, sources: Map<'mic'|'tab'|'app', Source>, stopping, drainUntil, startedAt, lastDraftAt }
let captureGeneration = 0;
const SOURCE_NAMES = { mic: 'Microphone', tab: 'Meeting tab', app: 'The call' };
const recordingEnds = createRecordingEnds((path, value) => apiWithin(10_000, path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
}));

function sourceIds() { return capture ? [...capture.sources.values()].map(s => s.sourceId) : []; }
/** A source's end: stop its input, collect its last frame, save what is queued, and tell the server. Never touches the other source. */
function endSource(session, source, why) {
  if (session.stopping) session.drainUntil ??= Date.now() + 30_000;
  if (source.ending) return source.ending;
  if (source.kind === 'app') {
    source.ending = (async () => {
      try {
        await post('/api/live/app-capture/stop', { source: source.sourceId });
        const until = session.drainUntil ?? Date.now() + 30_000;
        while (!source.ended && Date.now() < until) { await pollAppCapture(); if (!source.ended) await new Promise(resolve => setTimeout(resolve, 250)); }
        if (!source.ended) log('The call: the end could not be confirmed before the saving deadline.', true);
      } catch (error) { log(`The call could not confirm its end: ${error.message}`, true); }
      session.sources.delete('app');
      controls(); renderLive(lastSnapshot);
    })();
    return source.ending;
  }
  freezeSource(source);
  source.ending = (async () => {
    try {
      const flushed = await Promise.race([
        new Promise(resolve => { source.flushResolve = () => resolve(true); source.node.port.postMessage('flush'); }),
        new Promise(resolve => setTimeout(() => resolve(false), 1500)),
      ]);
      if (!flushed) log(`${SOURCE_NAMES[source.kind]}: the last moment of audio (under 1 s) could not be collected and is lost.`, true);
    } finally { source.node.disconnect(); }
    // Stop bounds the whole queue to the shared drain deadline, not a fresh retry budget per queued frame.
    let saved = true;
    try { await source.uploads; } catch { saved = false; /* already reported */ }
    // Always end the source on the server: after a failed upload with an unknown last frame (null), so whatever was saved is
    // transcribed now and its live preview is released.
    try { await recordingEnds.end(`${session.path}/pcm/end`, { source: source.sourceId, lastSequence: saved && source.sequence ? source.sequence - 1 : null, stopping: Boolean(session.stopping) }); }
    catch (error) { log(`${SOURCE_NAMES[source.kind]}: the end could not be confirmed (${error.message}); saved audio is transcribed after a short delay and confirming Stop will keep retrying.`, true); }
    if (why) log(why);
    session.sources.delete(source.kind);
    if (source.kind === 'tab' && !session.stopping) session.tabEnded = true;
    if (!session.sources.size) await finishSession(session);
    else { controls(); renderLive(lastSnapshot); }
  })();
  return source.ending;
}
/** Stops the physical input at once (tracks and graph); the frame already buffered is still flushed by endSource. */
function freezeSource(source) {
  if (source.kind === 'app') return;
  if (source.frozen) return;
  source.frozen = true;
  source.stream.getTracks().forEach(track => track.stop());
  source.input.disconnect();
}
async function finishSession(session) {
  if (session.finished) return;
  session.finished = true;
  clearInterval(session.suspensionTimer);
  document.removeEventListener('resume', session.onResume);
  stopLevel();
  await session.context.close().catch(() => {});
  if (capture === session) capture = undefined;
  closeMini();
  controls();
  if (!document.activeElement || document.activeElement === document.body) $('start').focus();
  renderLive(lastSnapshot);
  log('Recording stopped. Saved audio keeps transcribing.');
}
/** Stop: every input is frozen first, then each source settles on its own (one stuck queue cannot keep the other recording). */
async function stopCapture() {
  const session = capture;
  if (!session) return;
  session.drainUntil ??= Date.now() + 30_000;
  if (session.stopping) return session.stopping;
  // The mini view says "Stopping…" at once too (it is drawn from the server).
  void post('/api/live/stop', { sources: sourceIds() }).catch(() => {});
  session.stopping = (async () => {
    const sources = [...session.sources.values()];
    sources.forEach(freezeSource);
    await Promise.allSettled(sources.map(source => endSource(session, source)));
    await finishSession(session);
  })();
  controls(); // both windows show "stopping" at once: nothing may look as if it could still cancel it
  return session.stopping;
}
/** Wires a granted stream into the session as a new source, timed by the shared clock. */
async function addSource(session, kind, stream) {
  // A track that ended between being granted and being wired (the share was stopped, the device unplugged) is not a source.
  if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error(`${SOURCE_NAMES[kind]}: the audio ended before recording could start.`);
  const input = session.context.createMediaStreamSource(stream);
  // Mono by the graph: a stereo tab is mixed down (both channels), never cut to one.
  const node = new AudioWorkletNode(session.context, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const source = { kind, addedAt: Date.now(), sourceId: `${kind}:${crypto.randomUUID()}`, stream, input, node, sequence: 0, samples: 0, firstMs: null, pending: 0, uploads: Promise.resolve(), failed: false, ending: null, frozen: false, flushResolve: null };
  session.sources.set(kind, source);
  const fail = message => {
    if (source.failed) return;
    source.failed = true;
    log(message, true);
    void endSource(session, source); // only this source; the other keeps recording
  };
  for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
    if (source.frozen) return;
    void endSource(session, source, kind === 'tab' ? 'The meeting tab is no longer shared; the microphone keeps recording.' : 'The microphone device ended.');
  });
  node.onprocessorerror = () => fail(`${SOURCE_NAMES[kind]}: audio processing failed; this source stopped.`);
  node.port.onmessage = event => {
    if (event.data.kind === 'flushed') { source.flushResolve?.(); return; }
    if (event.data.kind !== 'pcm' || source.failed) return;
    const { buffer, sampleRate: rate, frame, captureWallMs, discontinuities } = event.data;
    // Run before reading the suspension evidence too: a queued worklet message may beat the timer after wake.
    session.suspension.tick(Date.now());
    const suspension = session.suspension.interval;
    if (source.pending >= 30) { fail(`${SOURCE_NAMES[kind]}: saving fell 30 s behind; this source stopped. Audio not yet saved is lost.`); return; }
    // The first frame is placed by the context clock (shared by both sources); later frames follow by sample count.
    if (source.firstMs === null) source.firstMs = session.offsetMs + frame * 1000 / rate;
    const sequence = source.sequence++;
    const startMs = source.firstMs + source.samples * 1000 / rate;
    source.samples += buffer.byteLength / 4;
    source.pending++;
    const upload = timeout => apiWithin(timeout, `${session.path}/pcm`, { method: 'POST', body: buffer, headers: {
      'Content-Type': 'application/octet-stream', 'X-Audio-Source': source.sourceId, 'X-Sequence': String(sequence),
      'X-Sample-Rate': String(rate), 'X-Start-Ms': String(startMs), 'X-Pending': String(source.pending), 'X-Clock-Start': String(session.startedAt - session.offsetMs), 'X-Recording': session.recordingId,
      'X-Capture-Settings': JSON.stringify(captureSettings(kind, stream, session.online || session.sources.has('tab') || session.sources.has('app'))),
      ...(Number.isFinite(captureWallMs) ? { 'X-Capture-Wall-Ms': String(captureWallMs) } : {}),
      ...(discontinuities?.length ? { 'X-Capture-Discontinuities': JSON.stringify(discontinuities) } : {}),
      ...(suspension ? { 'X-Suspension-From': String(suspension.fromWallMs), 'X-Suspension-To': String(suspension.toWallMs) } : {}),
    } });
    source.uploads = source.uploads.then(() => uploadWithRetry({
      attempt: upload, get until() { return session.drainUntil; },
    }))
      .then(reply => {
        source.pending--;
        source.firstSaved = true;
        // A Stop asked from the mini view, or a quit, arrives with the frames (they keep coming while this page's timers are slowed).
        if (reply.quit) quitting();
        else if (reply.stop && capture === session) void stopCapture();
      }).catch(error => {
        source.pending--;
        fail(`${SOURCE_NAMES[kind]}: audio could not be saved (${error.message}); this source stopped. Audio after its last saved second is lost.`);
        throw error;
      });
    void source.uploads.catch(() => {});
  };
  input.connect(node);
  node.connect(session.context.destination); // The worklet outputs silence, not playback.
  if (kind === 'mic') watchLevel(session.context, input);
  // Ended while the graph was being set up: the listener above came too late for it.
  if (!stream.getAudioTracks().some(track => track.readyState === 'live')) void endSource(session, source, `${SOURCE_NAMES[kind]} ended as recording started.`);
  return source;
}
/** Asks Chrome for a tab's audio. Must be called directly from the click (the picker needs it). Returns the audio-only stream. */
async function pickMeetingTab() {
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    selfBrowserSurface: 'exclude', systemAudio: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude', preferCurrentTab: false,
  });
  const video = display.getVideoTracks()[0];
  const surface = video?.getSettings?.().displaySurface;
  const audio = display.getAudioTracks();
  // Chrome needs video for tab capture; only the audio is kept. A window or screen is not a meeting tab: refuse it.
  display.getVideoTracks().forEach(track => track.stop());
  if (surface !== 'browser') { audio.forEach(track => track.stop()); throw new Error(surface ? 'Share a Chrome tab (not a window or screen) to record the call.' : 'Chrome did not say which kind of surface was shared, so the tab could not be verified.'); }
  if (!audio.length) throw new Error('No tab audio: when sharing, tick “Also share tab audio”.');
  return new MediaStream(audio);
}
let callMenuAnchor = null;
let callMenuTimer = null;
let helperAvailable = false;
let helperCheckedAt = 0;
function hasAppCapture() { return helperAvailable && Date.now() - helperCheckedAt < 3000; }
function closeStartMenu() {
  $('start-menu').hidden = true;
  $('start').setAttribute('aria-expanded', 'false'); $('add-tab').setAttribute('aria-expanded', 'false');
  clearInterval(callMenuTimer); callMenuTimer = null; callMenuAnchor = null;
}
function startMenuStep(apps) {
  for (const node of [$('start-mic'), $('start-online'), document.querySelector('.start-consent')]) node.hidden = apps;
  for (const id of ['call-heading', 'call-tab', 'call-apps']) $(id).hidden = !apps;
  $('call-empty').hidden = true;
  $('start-menu').setAttribute('aria-label', apps ? 'Where is the call?' : 'Start recording');
}
async function refreshCallApps() {
  const anchor = callMenuAnchor;
  if (!anchor) return;
  try {
    const result = await api('/api/live/apps');
    if (callMenuAnchor !== anchor) return;
    helperAvailable = result.available; helperCheckedAt = Date.now();
    const apps = result.apps ?? [];
    const known = new Map([...$('call-apps').children].map(n => [n.dataset.app, n]));
    for (const app of apps) {
      let row = known.get(app.id); known.delete(app.id);
      if (!row) {
        row = el('button', app.name); row.setAttribute('role', 'menuitem'); row.dataset.app = app.id;
        row.append(el('span', 'Use headphones', 'muted small'));
        row.onclick = guarded(() => { closeStartMenu(); return capture ? attachApp(capture, app) : startRecording(true, app); });
        $('call-apps').append(row);
      }
    }
    for (const row of known.values()) { if (row === document.activeElement) $('call-tab').focus(); row.remove(); }
    $('call-empty').hidden = apps.length > 0;
  } catch { /* keep the last list until the next refresh */ }
}
function openCallMenu(anchor) {
  closeStartMenu(); callMenuAnchor = anchor;
  $(anchor).parentElement.append($('start-menu'));
  startMenuStep(true); $('call-back').hidden = anchor !== 'start';
  $('start-menu').hidden = false; $(anchor).setAttribute('aria-expanded', 'true'); $('call-tab').focus();
  void refreshCallApps(); callMenuTimer = setInterval(refreshCallApps, 1000);
}
$('start').onclick = () => {
  const open = $('start-menu').hidden;
  closeStartMenu();
  $('start').parentElement.append($('start-menu')); startMenuStep(false);
  $('start-menu').hidden = !open;
  $('start').setAttribute('aria-expanded', String(open));
  if (open) $('start-mic').focus();
};
document.addEventListener('click', event => { if (!event.target.closest?.('.start-wrap')) closeStartMenu(); });
$('start-menu').addEventListener('keydown', event => {
  if (event.key === 'Escape') { const anchor = callMenuAnchor ?? 'start'; closeStartMenu(); $(anchor).focus(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const rows = [...$('start-menu').querySelectorAll('[role="menuitem"]')].filter(n => !n.hidden && n.offsetParent);
    rows[(rows.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
  }
});
$('call-back').onclick = () => { closeStartMenu(); startMenuStep(false); $('start-menu').hidden = false; $('start').setAttribute('aria-expanded', 'true'); $('start-online').focus(); };
$('call-tab').onclick = guarded(() => {
  closeStartMenu();
  if (!capture) return startRecording(true);
  return attachTab(capture, pickMeetingTab().then(stream => ({ stream }), error => ({ error })));
});
async function startRecording(online, app = null) {
  closeStartMenu();
  micTest?.stop();
  const path = base();
  const owner = meetingId;
  const generation = ++captureGeneration;
  // The tab picker first, straight from the click; everything else may wait on the network or a permission prompt.
  // Settled at once (stream or error), so a cancelled share is never an unhandled rejection while the microphone starts.
  const tabRequest = online && !app ? pickMeetingTab().then(stream => ({ stream }), error => ({ error })) : null;
  requestingMic = true; listen.recording(true); controls();
  let micStream, context, session;
  const stillOwner = () => {
    if (quitView.seen) throw new Error('HearAlong is quitting; the recording was not started.');
    if (meetingId !== owner || generation !== captureGeneration) throw new Error('The meeting changed while recording was starting; it was cancelled.');
  };
  try {
    const current = await api(path);
    stillOwner();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(online), video: false }).catch(error => {
      if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError' || !micSettings.deviceId) throw error;
      log('The chosen microphone is not available; recording with the system default instead.', true);
      return navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(online), deviceId: undefined }, video: false });
    });
    stillOwner();
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('/pcm-worklet.js');
    await context.resume();
    stillOwner();
    // Starts after all saved audio (including live frames not yet in a window); context frame 0 is this offset for every source.
    session = { owner, path, context, generation, offsetMs: current.audioEndMs ?? Math.max(0, ...current.chunks.map(c => c.startMs + c.seconds * 1000)), sources: new Map(), stopping: null, startedAt: Date.now(), recordingId: crypto.randomUUID() };
    session.suspension = new CaptureSuspension(Date.now());
    session.suspensionTimer = setInterval(() => session.suspension.tick(Date.now()), 1000);
    session.onResume = () => session.suspension.tick(Date.now(), true);
    document.addEventListener('resume', session.onResume);
    capture = session;
    session.online = Boolean(app);
    await addSource(session, 'mic', micStream);
    log(online ? (app ? 'Microphone recording started; waiting for the call…' : 'Microphone recording started; waiting for the meeting tab…') : 'Microphone recording started.');
  } catch (error) {
    micStream?.getTracks().forEach(track => track.stop());
    clearInterval(session?.suspensionTimer);
    if (session?.onResume) document.removeEventListener('resume', session.onResume);
    await context?.close().catch(() => {});
    if (capture === session) capture = undefined;
    tabRequest?.then(outcome => outcome.stream?.getTracks().forEach(track => track.stop()));
    throw error;
  } finally { requestingMic = false; controls(); renderLive(lastSnapshot); }
  if (tabRequest) await attachTab(session, tabRequest);
  if (app) await attachApp(session, app);
}
/** Adds the picked tab to the session that asked for it, if that session is still recording; otherwise the tab is released. */
async function attachTab(session, outcome) {
  const { stream, error } = await outcome;
  if (error) { log(`Recording the microphone only: ${error.name === 'NotAllowedError' ? 'tab sharing was cancelled' : error.message}`, true); return; }
  if (capture !== session || session.stopping || session.finished || session.sources.has('tab') || session.sources.has('app')) { stream.getTracks().forEach(track => track.stop()); return; }
  try {
    const mic = session.sources.get('mic');
    for (const track of mic?.stream.getAudioTracks() ?? []) {
      try { await track.applyConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }); }
      catch (failure) { log(`Could not update microphone processing; recording continues: ${failure.message}`, true); }
    }
    if (capture !== session || session.stopping || session.finished || session.sources.has('tab') || session.sources.has('app')) { stream.getTracks().forEach(track => track.stop()); return; }
    await addSource(session, 'tab', stream);
  }
  catch (failure) { stream.getTracks().forEach(track => track.stop()); log(`Recording the microphone only: ${failure.message}`, true); return; }
  log('Meeting tab recording started (“Them”); the microphone is “Me”.');
  controls(); renderLive(lastSnapshot);
}
/** The helper is the audio owner; the page holds only its identity and server-observed end. */
async function attachApp(session, app) {
  if (capture !== session || session.stopping || session.finished || session.sources.has('tab') || session.sources.has('app')) return;
  const source = { kind: 'app', app, sourceId: `app:${crypto.randomUUID()}`, addedAt: Date.now(), pending: 0, ended: false };
  session.sources.set('app', source); session.online = true; controls();
  try {
    for (const track of session.sources.get('mic')?.stream.getAudioTracks() ?? []) {
      const modes = track.getCapabilities?.().echoCancellation;
      const echo = Array.isArray(modes) && modes.includes('all') ? 'all' : true;
      try { await track.applyConstraints({ echoCancellation: echo, noiseSuppression: true, autoGainControl: true }); track.hearAlongEcho = echo; }
      catch (error) { log(`Could not update microphone processing; recording continues: ${error.message}`, true); }
    }
    // The control endpoint accepts only the recording now, never a Start that arrives late from a permission prompt.
    const until = Date.now() + 10_000;
    while (!session.sources.get('mic')?.firstSaved && Date.now() < until && capture === session && !session.stopping) await new Promise(resolve => setTimeout(resolve, 100));
    if (capture !== session || session.stopping || session.finished) { source.ended = true; return; }
    const reply = await post('/api/live/app-capture', { app, meetingId: session.owner, recordingId: session.recordingId, source: source.sourceId, pageId, clockStart: session.startedAt - session.offsetMs });
    if (!reply.accepted) throw new Error('The recording changed before call capture could start.');
    log(`Recording you (microphone) and ${app.name} (the call).`);
  } catch (error) {
    source.ended = true; session.sources.delete('app');
    log(`Recording the microphone only: ${error.message}`, true);
  }
  controls(); renderLive(lastSnapshot);
}
let appCapturePolling = false;
async function pollAppCapture() {
  if (appCapturePolling) return;
  appCapturePolling = true;
  try {
    const result = await api('/api/live/app-capture');
    helperAvailable = result.available; helperCheckedAt = Date.now();
    const session = capture, source = session?.sources.get('app'), state = result.state;
    if (!source || state?.source !== source.sourceId) return;
    if (state.notice && source.notice !== state.notice) { source.notice = state.notice; log(state.notice, true); }
    if (state.ended && !source.ended) {
      source.ended = true;
      if (state.message) log(state.message, true);
      if (!source.ending) {
        session.sources.delete('app');
        if (!session.sources.size) await finishSession(session);
        controls(); renderLive(lastSnapshot);
      }
    }
  } catch { helperAvailable = false; }
  finally { appCapturePolling = false; }
}
$('start-mic').onclick = guarded(() => startRecording(false));
$('start-online').onclick = guarded(() => hasAppCapture() ? openCallMenu('start') : startRecording(true));
$('add-tab').onclick = guarded(async () => {
  const session = capture;
  if (!session) return;
  if (hasAppCapture()) { openCallMenu('add-tab'); return; }
  await attachTab(session, pickMeetingTab().then(stream => ({ stream }), error => ({ error }))); // called from the click: the picker needs it
});
$('stop').onclick = guarded(() => { closeStartMenu(); return stopCapture(); });
void pollAppCapture();
setInterval(pollAppCapture, 1000);
window.addEventListener('pagehide', () => { for (const source of capture?.sources.values() ?? []) source.stream?.getTracks().forEach(track => track.stop()); });
window.addEventListener('beforeunload', event => { if (capture) { event.preventDefault(); event.returnValue = ''; } });

// ---------- Mini view (M7, mockup A): a small always-on-top window while recording (docs/design/M7-native-mini.md) ----------

// The page itself is /mini.html, drawn from the server alone. With the helper (the installed app) it is the helper's native window,
// which also floats over full-screen apps. This button opens it; it opens by itself when the user leaves the app only if they
// turned that on in Settings (the server decides). Without the helper (npm start), Chrome's Document Picture-in-Picture window
// holds the same page in a frame.
/** Must run straight from a click or Chrome's media-session request: Chrome opens its window only with that activation. */
function openMini() {
  if (!capture || capture.stopping || mini.win) return;
  if (nativeMini()) {
    void post('/api/live/mini', { sources: sourceIds(), action: 'open' }).then(() => refreshSegments()).catch(error => log(`The mini view could not open: ${error.message}`, true));
    return;
  }
  if (!miniSupported()) return;
  documentPictureInPicture.requestWindow({ width: 360, height: 268 }).then(win => {
    if (!capture || capture.stopping || mini.win) { win.close(); return; }
    mini.win = win;
    const doc = win.document;
    doc.title = 'HearAlong';
    const frame = doc.createElement('iframe');
    frame.src = new URL('/mini.html', location.href).href;
    frame.title = 'Mini view';
    // Set through the style object (the page's policy allows no style attributes): the frame fills the window.
    Object.assign(doc.documentElement.style, { height: '100%' });
    Object.assign(doc.body.style, { margin: '0', height: '100%', overflow: 'hidden' });
    Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0' });
    doc.body.append(frame);
    frame.addEventListener('load', () => frame.contentWindow?.focus());
    // The page in the frame asks for the app (a card, or after Stop) from inside its click: the app's window comes forward.
    win.miniBridge = { activate: () => window.focus() };
    // Closing the window by hand only closes it; the recording goes on, and the header offers it again with the focus on it.
    win.addEventListener('pagehide', () => {
      if (mini.win !== win) return;
      mini.win = null;
      controls();
      if (capture && !capture.stopping && (!document.activeElement || document.activeElement === document.body)) $('mini-view').focus();
    });
    controls();
  }).catch(error => log(`The mini view could not open: ${error.message}`, true));
}
function closeMini() { mini.win?.close(); mini.win = null; }
/** The newest card that is not dismissed: a project card, or an other matter (travel, admin) only when there is nothing else. */
function newestCard(owner) {
  const live = (boardView.owner === owner ? boardView.data?.cards ?? [] : []).filter(c => !c.dismissed).sort((a, b) => b.createdAt - a.createdAt);
  return live.find(c => c.type !== 'other') ?? live[0];
}
/**
 * Problems with the recording, most urgent first; nothing while all is well. The server's (the mini view shows the same), and
 * saving behind from this page's own count at once, before the server hears of it.
 */
function captureNotices(snapshot) {
  if (!capture) return [];
  const notices = snapshot?.meetingId === capture.owner ? [...snapshot.notices ?? []] : [];
  const behind = [...capture.sources.values()].some(s => s.pending >= SAVING_BEHIND_FRAMES);
  if (behind && !notices.some(n => n.text === NOTICES.savingBehind.text)) notices.splice(notices.some(n => n.text === NOTICES.tabEnded.text) ? 1 : 0, 0, NOTICES.savingBehind);
  return notices;
}
$('mini-view').onclick = () => openMini();
// Leaving this page while recording (another tab, or the window hidden): the helper's window opens by itself, once per recording,
// if the user turned that on in Settings (the server knows the setting and ignores this otherwise).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && capture && !capture.stopping && nativeMini()) void post('/api/live/mini', { sources: sourceIds(), action: 'away' }).catch(() => {});
});
// Chrome may offer to open it by itself when the user switches away while recording (automatic Picture-in-Picture), taken only
// with the same setting.
try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => { if (capture && !nativeMini() && mini.byItself) openMini(); }); } catch { /* not offered by this browser */ }

// ---------- Projects and project memory (M6; docs/design/M6-memory.md §2, mockup C v3.1) ----------

const ITEM_WORD = { todo: 'to-do', decision: 'decision', question: 'question' };
const TYPE_ORDER = [['todo', 'To-dos'], ['decision', 'Decisions'], ['question', 'Questions']];
const OPEN_STATUSES = ['open', 'in force'];
const RESOLVED_MS = 15_000;
const day = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** A wall-clock time ("today 14:20", "Oct 9, 14:20"), never styled as a transcript time. */
function wallClock(ms) {
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return new Date(ms).toDateString() === new Date().toDateString() ? `today ${time}` : `${day(ms)}, ${time}`;
}
const requestId = () => crypto.randomUUID();
let projectEpoch = 0;
const projectOwners = new WeakMap();
/** Captured by rendered controls, not looked up again at click time. A → B → A is still a new owner. */
function projectAccess(value) {
  const owner = value ? projectOwners.get(value) : { id: projectView.project?.id, epoch: projectEpoch };
  const check = () => {
    if (!owner?.id || owner.id !== projectView.project?.id || owner.epoch !== projectEpoch) throw new Error('The project changed; use its current controls.');
  };
  const wrap = fn => async (...args) => { check(); const result = await fn(...args); check(); return result; };
  return { check, projectBase: () => { check(); return `/api/projects/${owner.id}`; }, post: wrap(post), send: wrap(send), api: wrap(api) };
}
function bindProjectData(value) {
  if (!value || typeof value !== 'object') return;
  projectOwners.set(value, { id: projectView.project?.id, epoch: projectEpoch });
  for (const child of Object.values(value)) bindProjectData(child);
}

async function loadProjects() {
  try {
    projectView.projects = (await api('/api/projects')).projects;
    renderMeetingMenu();
  } catch { /* status polling reports connection problems */ }
}
/** Called with each meeting detail: shows or hides everything that belongs to a project. */
function setProject(project) {
  const before = projectView.project;
  const changed = (project?.id ?? null) !== (before?.id ?? null) || project?.name !== before?.name || project?.repoPath !== before?.repoPath;
  if ((project?.id ?? null) !== (before?.id ?? null)) resetProjectView();
  projectView.project = project ?? null;
  $('tab-project').hidden = !project;
  $('ctab-project').hidden = !project;
  $('compact-tabs').style.setProperty('--tab-count', String(compactTabs().length));
  if (!project) {
    if (notesView.tab === 'project') showTab('board');
    if (layoutView.compact && layoutView.tab === 'project') showCompactTab('live');
  }
  $('project-none').hidden = Boolean(project);
  $('project-settings').hidden = !project;
  if (!changed) return;
  // Checking the repo needs a repo folder; without one the button is off and says why.
  $('check-repo').disabled = !project?.repoPath;
  $('check-repo-note').textContent = project && !project.repoPath ? 'Needs a repo folder (above).' : '';
  if (project) {
    if (document.activeElement !== $('project-name')) $('project-name').value = project.name;
    if (document.activeElement !== $('project-repo')) $('project-repo').value = project.repoPath ?? '';
    if (!projectView.projects.some(p => p.id === project.id)) void loadProjects();
  }
  renderMeetingMenu();
  renderSettingsNav();
  renderPlanSetting();
  // The Project tab chosen earlier comes back once a project meeting is shown (it fell back to the board meanwhile).
  if (project && notesView.tab !== 'project' && (layoutView.compact ? layoutView.tab === 'project' : store.get('right-tab') === 'project')) showTab('project');
  else if (project && (notesView.tab === 'project' || layoutView.tab === 'project')) void refreshProject();
  if (!project) updateProjectBadge();
}
function resetProjectView() {
  projectEpoch++;
  projectView.sequence++;
  Object.assign(projectView, { recent: null, drafts: null, versions: null, versionsOf: undefined, commits: null, commitsFor: null, focusEditor: null });
  briefEditing(false); closeVersions();
  Object.assign(projectView, { owner: null, data: null, run: null, filter: null, editing: null, answering: null, tell: null, menu: null, stamp: null });
  projectView.expanded.clear();
  projectView.resolved.clear();
  projectView.resolvedEdits.clear();
  projectView.sources.clear();
  projectView.wordings.clear();
  Object.assign(projectView, { wordingOpen: null, quietOpen: false, briefOpen: false });
  $('ok-rows').replaceChildren(); $('memory-lists').replaceChildren();
  $('needs-ok').hidden = true; $('brief').hidden = true; $('lists-bar').hidden = true; $('project-empty').hidden = true;
  $('tell-result').hidden = true; $('tell-input').value = ''; $('project-state').textContent = '';
  $('memory-popover').hidden = true;
  updateProjectBadge();
}
async function refreshProject() {
  const project = projectView.project;
  if (!project || !meetingId) return;
  const sequence = ++projectView.sequence;
  const owner = meetingId;
  try {
    const [data, run] = await Promise.all([api(`/api/projects/${project.id}/memory`), api(`/api/meetings/${owner}/memory/run`)]);
    if (sequence !== projectView.sequence || owner !== meetingId || projectView.project?.id !== project.id) return;
    // Open timelines show what just happened; the user's changes of the last 15 s keep their Undo after a reload.
    await Promise.all([...projectView.expanded.keys()].map(async id => {
      try {
        const { timeline } = await api(`/api/projects/${project.id}/memory/items/${id}`);
        if (sequence === projectView.sequence) projectView.expanded.set(id, timeline);
      } catch { if (sequence === projectView.sequence) projectView.expanded.delete(id); }
    }));
    if (sequence !== projectView.sequence) return;
    for (const r of data.recent ?? []) for (const item of r.items) {
      if (!projectView.recent?.has(item.id)) (projectView.recent ??= new Map()).set(item.id, { batch: r.batch, at: r.at, word: 'the change to', closing: item.closing });
    }
    // The repo's recent commits, for the Source of changes that came without one (read once per project).
    if (projectView.commitsFor !== project.id && project.repoPath && data.proposals.some(p => p.source.kind === 'file' || p.source.kind === 'agent')) {
      projectView.commitsFor = project.id;
      projectView.commits = (await api(`/api/projects/${project.id}/commits`).catch(() => ({ commits: [] }))).commits;
      if (sequence !== projectView.sequence) return;
    }
    bindProjectData(data);
    projectView.data = data;
    logSkippedFiles(project.id, data.files);
    projectView.run = run.run;
    projectView.owner = owner;
    if (projectView.filter === null) {
      // After a meeting the view opens on that meeting's changes until they are all confirmed or undone (§2).
      projectView.filter = hasOpenChanges() ? 'changes' : 'all';
      $('project-filter').value = projectView.filter;
    }
    renderProject();
  } catch (error) { if (sequence === projectView.sequence) $('project-state').textContent = `Could not load the project: ${error.message}`; }
}
/**
 * The meeting whose changes "Changes" shows: this one once it has any; before that, the project's previous meeting with
 * changes, so a new meeting opens on what changed since last time (§2).
 */
function changesMeeting() {
  const d = projectView.data;
  if (!d) return meetingId;
  const has = id => d.proposals.some(p => p.meetingId === id) || d.items.some(i => d.info[i.id]?.meetings.includes(id));
  if (has(meetingId)) return meetingId;
  const created = status?.meetings.find(m => m.id === meetingId)?.createdAt ?? Infinity;
  const earlier = (status?.meetings ?? []).filter(m => m.id !== meetingId && m.projectId === projectView.project?.id && m.createdAt < created).sort((a, b) => b.createdAt - a.createdAt);
  return earlier.find(m => has(m.id))?.id ?? meetingId;
}
/** Something from that meeting still waits: an OK, or an AI-recorded item or link not yet confirmed. */
function hasOpenChanges() {
  const d = projectView.data;
  if (!d) return false;
  const from = changesMeeting();
  if (d.proposals.some(p => p.meetingId === from)) return true;
  return d.items.some(i => deletedMeetingChanges(i) || fromThisMeeting(i) && (!i.confirmed || d.info[i.id]?.unconfirmed.some(u => u.meetingId === from)));
}
const deletedMeeting = id => typeof id === 'string' && status?.meetings && !status.meetings.some(m => m.id === id);
function deletedMeetingChanges(item) {
  const info = projectView.data?.info[item.id];
  return Boolean(!item.confirmed && (deletedMeeting(info?.createdIn) || info?.meetings.some(deletedMeeting))
    || info?.unconfirmed.some(u => deletedMeeting(u.meetingId)));
}
const fromThisMeeting = item => Boolean(projectView.data?.info[item.id]?.meetings.includes(changesMeeting()) || deletedMeetingChanges(item));
function updateProjectBadge() {
  const d = projectView.data;
  // What needs a decision; an agent's note that led to nothing does not.
  const count = projectView.project && d ? d.proposals.length + d.captures.filter(c => c.problems).length + (d.inbox ?? []).filter(n => n.state === 'failed').length : 0;
  for (const badge of [$('project-badge'), $('cproject-badge')]) { badge.hidden = !count; badge.textContent = String(count); badge.title = `${count} change(s) need your OK`; }
  $('ctab-project').setAttribute('aria-label', count ? `Project, ${count} change(s) need your OK` : 'Project');
  $('tab-project').setAttribute('aria-label', count ? `Project, ${count} change(s) need your OK` : 'Project');
}
$('project-filter').onchange = () => { projectView.filter = $('project-filter').value; renderProject(); };

function renderProject() {
  const d = projectView.data;
  if (!d) return;
  updateProjectBadge();
  // One status line: a run in progress or failed, or the repo folder missing.
  const run = projectView.run;
  const state = $('project-state');
  state.replaceChildren();
  state.classList.toggle('error', run?.state === 'failed');
  if (run?.state === 'running') state.textContent = 'Updating memory from this meeting’s notes…';
  else if (run?.state === 'failed') {
    state.append(`Memory was not updated from this meeting: ${run.error ?? 'the run failed'} `);
    const again = el('button', 'Try again', 'link-button');
    again.onclick = guarded(async () => { await post(`${base()}/memory/update`, {}); await refreshProject(); });
    state.append(again);
  } else if (d.files?.state === 'repo missing' || d.files?.state === 'not ours') {
    state.append(d.files.state === 'repo missing' ? 'The repo folder is missing, so the memory files are paused (memory itself keeps working). '
      : 'The repo already has a project-memory/ folder the app did not write, so the memory files are paused (memory itself keeps working). ');
    const open = el('button', 'Open Settings → Project', 'link-button');
    open.onclick = () => openSettings('project');
    state.append(open);
  } else if (notesView.data?.notes && (!run || (run.notesVersion ?? 0) < notesView.data.notes.version)) {
    // Notes written while the meeting was still going on (or before a project) do not update memory by themselves.
    const update = el('button', 'Update memory from this meeting’s notes', 'link-button');
    update.onclick = guarded(async () => { await post(`${base()}/memory/update`, {}); await refreshProject(); });
    state.append(update);
  }
  renderNeedsOk();
  renderBrief();
  renderMemoryLists();
}

/** Capture before any synchronous rebuild (including card replacements), then restore only focus lost by that rebuild. */
function rememberFocus(container) {
  const active = document.activeElement;
  if (!container.contains(active)) return () => {};
  const card = active.closest('[data-card]');
  const job = active.closest('[data-id]');
  const scopes = [card, job].filter((node, i, nodes) => node && container.contains(node) && nodes.indexOf(node) === i);
  const scopeKeys = scopes.map(node => node.hasAttribute('data-card') ? `[data-card="${CSS.escape(node.dataset.card)}"]` : `[data-id="${CSS.escape(node.dataset.id)}"]`);
  const scope = scopes.at(-1) ?? container;
  const key = active.dataset.focus !== undefined ? ['data-focus', active.dataset.focus] : active.dataset.key !== undefined ? ['data-key', active.dataset.key] : null;
  const signature = node => JSON.stringify([node.tagName, node.className, node.getAttribute('type'), node.getAttribute('href'), node.getAttribute('aria-label'), node.textContent]);
  const identity = signature(active);
  const peers = [...scope.querySelectorAll(active.tagName)].filter(node => signature(node) === identity);
  const index = peers.indexOf(active);
  const selection = 'selectionStart' in active && active.selectionStart !== null ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  return () => {
    // Rendering is synchronous: an intentional focus change during it must win over restoration.
    const now = document.activeElement;
    if (now === active && active.isConnected) return;
    if (now && now !== document.body && now !== document.documentElement) return;
    let root = container;
    for (const selector of scopeKeys) { root = root.querySelector(selector); if (!root) return; }
    const again = active.isConnected && container.contains(active) ? active : active === scope ? root
      : key ? root.querySelector(`[${key[0]}="${CSS.escape(key[1])}"]`)
      : scopes.length ? [...root.querySelectorAll(active.tagName)].filter(node => signature(node) === identity)[index] : null;
    if (!again) return;
    again.focus({ preventScroll: true });
    if (selection) try { again.setSelectionRange(...selection); } catch { /* not a text field */ }
  };
}
function keepFocus(container, render) {
  const restore = rememberFocus(container);
  render();
  restore();
}
const focusKey = (node, key) => { node.dataset.focus = key; return node; };

// Needs your OK: changes to existing items, unsure matches, edits found in files, guessed sources (§4.2, §6). One filled
// button per row (Accept); Change ▾ and Reject are text actions. Rows keep their place when resolved, with Undo for 15 s.
function renderNeedsOk() {
  const d = projectView.data;
  const now = Date.now();
  for (const [id, r] of projectView.resolved) if (now - r.at > RESOLVED_MS) projectView.resolved.delete(id);
  for (const [id, r] of projectView.resolvedEdits) if (now - r.at > RESOLVED_MS) projectView.resolvedEdits.delete(id);
  const entries = [...d.proposals.filter(p => !projectView.resolved.has(p.id)).map(p => ({ p })), ...[...projectView.resolved.values()].map(r => ({ p: r.proposal, resolved: r }))]
    .sort((a, b) => a.p.createdAt - b.p.createdAt || a.p.id.localeCompare(b.p.id));
  // The changes found in one file edit are one block: one source, one "Accept all".
  const blocks = [];
  const edits = new Map();
  for (const entry of entries) {
    if (!entry.p.capture) { blocks.push(entry); continue; }
    let block = edits.get(entry.p.capture);
    if (!block) { block = { capture: entry.p.capture, entries: [] }; edits.set(entry.p.capture, block); blocks.push(block); }
    block.entries.push(entry);
  }
  const notes = d.inbox ?? [];
  const rows = [...d.captures.filter(c => c.problems).map(captureRow), ...notes.filter(n => n.state === 'failed').map(inboxRow),
    ...blocks.map(b => b.capture ? editBlock(b) : okRow(b.p, b.resolved))];
  // Agent notes that led to nothing need no decision: one quiet line, not a row each.
  const quiet = notes.filter(n => n.state === 'empty');
  if (quiet.length) rows.push(quietNotes(quiet));
  $('needs-ok').hidden = !rows.length;
  keepFocus($('ok-rows'), () => $('ok-rows').replaceChildren(...rows));
  if (projectView.resolved.size || projectView.resolvedEdits.size) setTimeout(() => { if (projectView.data === d) renderNeedsOk(); }, RESOLVED_MS + 100);
}
/** After a row is resolved: focus goes to the next row still waiting (below it, else above), else to the lists. */
function focusNextRow(rowKey) {
  requestAnimationFrame(() => {
    const rows = [...$('ok-rows').children];
    const at = rows.findIndex(r => r.dataset.row === rowKey);
    const waiting = r => r.querySelector('.button.primary');
    const next = rows.slice(at + 1).find(waiting) ?? rows.slice(0, Math.max(0, at)).reverse().find(waiting);
    (next ? waiting(next) : $('project-filter')).focus();
  });
}
const textAction = (label, key) => focusKey(el('button', label, 'text-action'), key);
/** Text whose item ids (T-3, Q-12) never break at their hyphen. */
function withIds(text) {
  return String(text).split(/\b([TDQ]-\d+)\b/).map((part, i) => i % 2 ? el('span', part, 'nowrap') : document.createTextNode(part));
}
const textEl = (tag, text, className) => { const node = el(tag, undefined, className); node.append(...withIds(text)); return node; };
function captureRow(capture) {
  const { projectBase, post } = projectAccess(capture);
  const row = el('div', undefined, 'ok-row');
  row.dataset.row = `capture:${capture.id}`;
  const head = el('span', undefined, 'ok-head');
  head.append(el('strong', `Changed in ${capture.file}`), ` · ${wallClock(capture.at)} · `, el('span', 'could not be read', 'ok-flag'));
  const problems = JSON.parse(capture.problems);
  const done = focusKey(el('button', 'Done with this edit', 'button small-button primary'), `capture:${capture.id}`);
  done.onclick = guarded(async () => { await post(`${projectBase()}/captures/${capture.id}/dismiss`, {}); await refreshProject(); focusNextRow(row.dataset.row); });
  const actions = el('div', undefined, 'ok-actions');
  actions.append(done);
  row.append(head, el('span', `${problems.join('; ')}. Open the file and fix it, or let the app rewrite it.`, 'ok-proposed'), actions);
  return row;
}
/** An agent's note that could not be read: Retry, or Dismiss. */
function inboxRow(notice) {
  const { projectBase, post } = projectAccess(notice);
  const row = el('div', undefined, 'ok-row');
  row.dataset.row = `inbox:${notice.hash}`;
  const head = el('span', undefined, 'ok-head');
  head.append(el('strong', 'Note from an agent'), ` · ${notice.name} · `, el('span', `could not be read: ${notice.error ?? 'the model call failed'}`, 'ok-flag'));
  const actions = el('div', undefined, 'ok-actions');
  const retry = focusKey(el('button', 'Retry', 'button small-button primary'), `retry:${notice.hash}`);
  retry.onclick = guarded(async () => { await post(`${projectBase()}/inbox/${notice.hash}/retry`, {}); await refreshProject(); focusNextRow(row.dataset.row); });
  const dismiss = textAction('Dismiss', `dismiss:${notice.hash}`);
  dismiss.setAttribute('aria-label', `Dismiss the note ${notice.name}`);
  dismiss.onclick = guarded(async () => { await post(`${projectBase()}/inbox/${notice.hash}/dismiss`, {}); await refreshProject(); focusNextRow(row.dataset.row); });
  actions.append(retry, dismiss);
  row.append(head, el('p', `“${notice.text}”`, 'ok-said'), actions);
  return row;
}
/** "1 agent note had nothing to record · Show · Dismiss": seen once, without a row each. */
function quietNotes(notes) {
  const { projectBase, post } = projectAccess();
  const row = el('div', undefined, 'ok-quiet');
  row.dataset.row = 'quiet-notes';
  const line = el('div', undefined, 'ok-quiet-line');
  line.append(el('span', `${notes.length} agent note${notes.length === 1 ? '' : 's'} had nothing to record`, 'muted small'));
  const open = Boolean(projectView.quietOpen);
  const show = focusKey(el('button', open ? 'Hide' : 'Show', 'link-button'), 'quiet:show');
  show.setAttribute('aria-expanded', String(open));
  show.onclick = () => { projectView.quietOpen = !open; renderNeedsOk(); };
  const dismiss = focusKey(el('button', 'Dismiss', 'link-button'), 'quiet:dismiss');
  dismiss.setAttribute('aria-label', `Dismiss ${notes.length === 1 ? 'this note' : 'these notes'}`);
  dismiss.onclick = guarded(async () => {
    for (const n of notes) await post(`${projectBase()}/inbox/${n.hash}/dismiss`, {});
    projectView.quietOpen = false;
    await refreshProject();
    focusNextRow(row.dataset.row);
  });
  line.append(show, dismiss);
  row.append(line);
  if (open) for (const n of notes) row.append(el('p', `${n.name}: “${n.text}”`, 'ok-said'));
  return row;
}
/** What the source said or changed, with a link to the moment when it is this meeting. */
function sourceLine(p) {
  const s = p.source;
  if (s.kind === 'meeting') {
    const line = s.lines?.[0];
    const wrap = el('span', undefined, 'ok-head');
    if (line && s.meetingId === meetingId) {
      const time = el('button', stamp(line.startMs), 'card-time');
      time.setAttribute('aria-label', `Jump to ${stamp(line.startMs)} in the transcript`);
      time.onclick = () => scrollToSegment(meetingId, line.id);
      wrap.append(time);
    } else wrap.append(el('span', status?.meetings.find(m => m.id === s.meetingId)?.title ?? 'an earlier meeting', 'muted'));
    return wrap;
  }
  if (s.kind === 'agent') return el('span', `Note from an agent · ${wallClock(p.createdAt)}`, 'muted small');
  if (s.kind === 'commit') return el('span', `Commit ${s.hash.slice(0, 7)} · ${wallClock(p.createdAt)}`, 'muted small');
  return el('span', wallClock(p.createdAt), 'muted small');
}
/**
 * Source for a change that came without one (a file edit, an agent's note): the original, the guessed commit, or any recent
 * commit of the repo. One per file edit, one per agent's proposal.
 */
function sourcePicker(key, originalLabel, suggested) {
  const label = el('label', 'Source', 'ok-source');
  const select = focusKey(el('select'), `source:${key}`);
  select.append(new Option(originalLabel, 'original'));
  if (suggested) select.append(new Option(`commit ${suggested.hash.slice(0, 7)} “${suggested.subject}” (guessed)`, 'suggested'));
  for (const c of projectView.commits ?? []) if (c.hash !== suggested?.hash) select.append(new Option(`commit ${c.hash.slice(0, 7)} “${c.subject}”`, `commit:${c.hash}`));
  select.value = sourceChoice(key, suggested);
  select.onchange = () => projectView.sources.set(key, select.value);
  label.append(select);
  return label;
}
const sourceChoice = (key, suggested) => projectView.sources.get(key) ?? (suggested ? 'suggested' : 'original');
function sourceValue(key, suggested) {
  const choice = sourceChoice(key, suggested);
  return choice.startsWith('commit:') ? { commit: choice.slice(7) } : choice;
}
function proposalTitle(p) {
  if (p.kind === 'new') return `New ${ITEM_WORD[p.changes.find(c => c.op === 'create')?.type] ?? 'item'}`;
  if (p.kind === 'same') return p.flags.includes('AI unsure') ? 'Raised again, or new?' : 'Raised again';
  return 'Change to an existing item';
}
/** The item a proposal currently points at (the user may have picked another with Change ▾). */
function chosenTarget(p) { return projectView.menu?.choices?.get(p.id) ?? Object.keys(p.targets)[0] ?? 'new'; }
/** A change whose wording the user can edit: a new item, a rewording, an answer. */
const wordable = p => p.changes.some(c => c.op === 'create' || c.op === 'answer' || (c.op === 'edit' && c.text));
/** The proposal as the user has shaped it: another item (Change ▾), and their own wording. Null: as proposed. */
function changesFor(p) {
  const choice = projectView.menu?.choices?.get(p.id);
  const wording = projectView.wordings.get(p.id);
  if (!choice && wording === undefined) return null;
  const original = Object.keys(p.targets)[0];
  const type = p.changes.find(c => c.op === 'create')?.type ?? projectView.data.items.find(i => i.id === original)?.type ?? 'todo';
  let changes = !choice ? p.changes.map(c => ({ ...c }))
    : choice === 'new' ? [{ op: 'create', type, text: p.sourceText }]
    : p.kind === 'update' ? p.changes.map(c => ({ ...c, ...(c.item === original ? { item: choice } : {}), ...(c.by === original ? { by: choice } : {}) }))
    : [{ op: 'addSource', item: choice }];
  if (wording !== undefined) changes = changes.map(c => c.op === 'create' || c.op === 'answer' || (c.op === 'edit' && c.text) ? { ...c, text: wording } : c);
  return changes.map(c => { const copy = { ...c }; delete copy.source; return copy; });
}
/** A target changed since the proposal was made, and the user has not looked at it again. */
const isStale = p => Object.entries(p.targets).some(([id, v]) => projectView.data.items.find(i => i.id === id)?.version !== v) && !projectView.menu?.reviewed?.has(p.id);
const currentVersions = p => Object.fromEntries(Object.keys(p.targets).map(id => [id, projectView.data.items.find(i => i.id === id)?.version]));
/** What Accept sends besides the request id: the user's changes and the versions they saw. */
function acceptBody(p) {
  const changes = changesFor(p);
  const choice = projectView.menu?.choices?.get(p.id);
  const expect = choice ? (choice === 'new' ? {} : { [choice]: projectView.data.items.find(i => i.id === choice)?.version })
    : projectView.menu?.reviewed?.has(p.id) ? currentVersions(p) : undefined;
  return { ...(changes ? { changes } : {}), ...(expect ? { expect } : {}) };
}
function proposedText(p) {
  const choice = chosenTarget(p);
  const item = projectView.data.items.find(i => i.id === choice);
  const wording = projectView.wordings.get(p.id);
  if (wording !== undefined) return `Will be recorded as: ${wording}`;
  if (projectView.menu?.choices?.has(p.id)) return choice === 'new' ? `Proposed: record it as a new ${ITEM_WORD[p.changes.find(c => c.op === 'create')?.type] ?? 'item'}` : `Proposed: ${p.kind === 'update' ? 'apply to' : 'raised again under'} ${choice} · ${item?.text ?? ''}`;
  return `Proposed: ${p.summary}`;
}
function staleLine(p) {
  const d = projectView.data;
  const [id] = Object.entries(p.targets).find(([tid, v]) => d.items.find(i => i.id === tid)?.version !== v);
  const now = d.items.find(i => i.id === id);
  return textEl('span', `Changed since proposed: ${id} is now ${now?.status ?? 'gone'} · ${now?.text ?? ''}`, 'ok-flag');
}
function resolvedActions(p, resolved, onUndo) {
  const actions = el('div', undefined, 'ok-actions');
  actions.append(el('span', resolved.state === 'accepted' ? '✓ Accepted' : 'Rejected', resolved.state === 'accepted' ? 'ok-done' : 'ok-rejected-word'));
  const undo = focusKey(el('button', 'Undo', 'link-button'), `undo:${p.id}`);
  undo.setAttribute('aria-label', `Undo: ${resolved.state} ${p.summary}`);
  undo.onclick = guarded(onUndo);
  actions.append(undo);
  return actions;
}
async function undoResolution(p, resolved) {
  const { projectBase, post } = projectAccess(p);
  if (resolved.state === 'accepted') await post(`${projectBase()}/memory/undo`, { batch: resolved.batch, requestId: requestId() });
  else await post(`${projectBase()}/proposals/${p.id}/reopen`, {});
  projectView.resolved.delete(p.id);
}
async function acceptOne(p, rowKey, source) {
  const { projectBase, post, check } = projectAccess(p);
  try {
    const result = await post(`${projectBase()}/proposals/${p.id}/accept`, { requestId: requestId(), ...acceptBody(p), source });
    projectView.resolved.set(p.id, { proposal: p, state: 'accepted', batch: result.batch, at: Date.now() });
  } catch (error) {
    check();
    projectView.menu?.reviewed?.delete(p.id);
    await refreshProject();
    throw /changed since/i.test(error.message) ? new Error(`${error.message} The row now shows it as it is.`) : error;
  }
  projectView.wordings.delete(p.id);
  await refreshProject();
  focusNextRow(rowKey);
}
async function rejectOne(p, rowKey) {
  const { projectBase, post } = projectAccess(p);
  await post(`${projectBase()}/proposals/${p.id}/reject`, {});
  projectView.resolved.set(p.id, { proposal: p, state: 'rejected', at: Date.now() });
  await refreshProject();
  focusNextRow(rowKey);
}
function rejectButton(p, rowKey) {
  const d = projectView.data;
  const status = p.changes.find(c => c.op === 'status');
  const keeps = status ? ` (keeps ${status.item} ${d.items.find(i => i.id === status.item)?.status ?? 'as it is'})` : '';
  const reject = textAction('Reject', `reject:${p.id}`);
  reject.title = `Reject this change${keeps}`;
  reject.setAttribute('aria-label', `Reject: ${p.summary}${keeps}`);
  reject.onclick = guarded(() => rejectOne(p, rowKey));
  return reject;
}
/** A proposal from a meeting, an agent's note or the repo check. */
function okRow(p, resolved) {
  const row = el('div', undefined, `ok-row${resolved ? ' resolved' : ''}${resolved?.state === 'rejected' ? ' rejected' : ''}`);
  row.dataset.row = `proposal:${p.id}`;
  const head = el('span', undefined, 'ok-head');
  head.append(el('strong', proposalTitle(p)), ' · ', sourceLine(p));
  const flags = p.flags.filter(f => f !== 'AI unsure' || p.kind !== 'same');
  if (flags.length) head.append(' · ', textEl('span', flags.join('; '), 'ok-flag'));
  row.append(head);
  // What was said (a meeting, an agent's or the user's note).
  if (p.source.kind !== 'commit') row.append(el('p', `“${p.sourceText}”`, 'ok-said'));
  // A new item in the note's own words says nothing the title and the quote have not said already.
  const ownWords = !projectView.menu?.choices?.has(p.id) && !projectView.wordings.has(p.id) && p.kind === 'new' && p.changes.find(c => c.op === 'create')?.text === p.sourceText && p.source.kind === 'meeting';
  const proposed = proposedText(p);
  if (!ownWords) row.append(textEl('span', proposed, 'ok-proposed'));
  const stale = !resolved && isStale(p);
  if (stale) row.append(staleLine(p));
  if (!resolved && p.source.kind === 'agent') row.append(sourcePicker(p.id, 'The note itself', p.suggested));
  if (resolved) { row.append(resolvedActions(p, resolved, async () => { await undoResolution(p, resolved); await refreshProject(); requestAnimationFrame(() => $('ok-rows').querySelector(`[data-focus="accept:${p.id}"], [data-focus="review:${p.id}"]`)?.focus()); })); return row; }
  if (projectView.wordingOpen === p.id) row.append(wordingForm(p));
  const actions = el('div', undefined, 'ok-actions');
  if (stale) {
    const review = focusKey(el('button', 'Review again', 'button small-button primary'), `review:${p.id}`);
    review.onclick = () => {
      (projectView.menu ??= {}); (projectView.menu.reviewed ??= new Set()).add(p.id);
      renderNeedsOk();
      requestAnimationFrame(() => $('ok-rows').querySelector(`[data-focus="accept:${p.id}"]`)?.focus());
    };
    actions.append(review);
  } else {
    const accept = focusKey(el('button', 'Accept', 'button small-button primary'), `accept:${p.id}`);
    accept.setAttribute('aria-label', `Accept: ${proposed.replace(/^(Proposed|Will be recorded as): /, '')}`);
    accept.onclick = guarded(() => acceptOne(p, row.dataset.row, p.source.kind === 'agent' ? sourceValue(p.id, p.suggested) : 'original'));
    actions.append(accept);
    const options = changeOptions(p);
    if (options.length) {
      const change = focusKey(el('button', 'Change ▾', 'text-action'), `change:${p.id}`);
      change.dataset.match = p.id;
      change.setAttribute('aria-haspopup', 'menu');
      const open = projectView.menu?.change === p.id;
      change.setAttribute('aria-expanded', String(open));
      change.onclick = () => { projectView.menu = { ...(projectView.menu ?? {}), change: open ? null : p.id, open: null, changeFocused: null }; renderNeedsOk(); };
      actions.append(change);
    }
  }
  actions.append(rejectButton(p, row.dataset.row));
  row.append(actions);
  if (projectView.menu?.change === p.id) row.append(changeMenu(p));
  if (projectView.menu?.open === p.id) row.append(matchMenu(p));
  return row;
}
/** Change ▾: edit the wording; it belongs to another item; record it as a new item instead. */
function changeOptions(p) {
  const matchable = p.source.kind !== 'commit' && (p.kind !== 'update' || Object.keys(p.targets).length);
  const type = ITEM_WORD[p.changes.find(c => c.op === 'create')?.type ?? projectView.data.items.find(i => i.id === Object.keys(p.targets)[0])?.type] ?? 'item';
  return [
    ...(wordable(p) ? [['Edit wording', () => { projectView.wordingOpen = p.id; projectView.focusEditor = `wording:${p.id}`; }]] : []),
    ...(matchable ? [['Belongs to another item…', () => { projectView.menu.open = p.id; projectView.menu.justOpened = null; }]] : []),
    ...(matchable && p.kind !== 'new' && chosenTarget(p) !== 'new' ? [[`Record as a new ${type}`, () => { (projectView.menu.choices ??= new Map()).set(p.id, 'new'); }]] : []),
    ...(projectView.menu?.choices?.has(p.id) || projectView.wordings.has(p.id) ? [['Back to what was proposed', () => { projectView.menu.choices?.delete(p.id); projectView.wordings.delete(p.id); }]] : []),
  ];
}
function changeMenu(p) {
  const menu = el('div', undefined, 'match-menu change-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Change');
  const close = () => { projectView.menu.change = null; renderNeedsOk(); requestAnimationFrame(() => $('ok-rows').querySelector(`[data-focus="change:${p.id}"]`)?.focus()); };
  for (const [label, run] of changeOptions(p)) {
    const item = focusKey(el('button', label, 'match-option'), `changeopt:${p.id}:${label}`);
    item.setAttribute('role', 'menuitem');
    item.onclick = () => {
      projectView.menu.change = null;
      run();
      renderNeedsOk();
      requestAnimationFrame(() => ($('ok-rows').querySelector(`[data-focus="wording-input:${p.id}"]`) ?? $('ok-rows').querySelector(`[data-focus="accept:${p.id}"]`))?.focus());
    };
    menu.append(item);
  }
  menu.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const stops = [...menu.querySelectorAll('.match-option')];
    stops[(stops.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length]?.focus();
    event.preventDefault();
  };
  if (projectView.menu.changeFocused !== p.id) { projectView.menu.changeFocused = p.id; requestAnimationFrame(() => menu.querySelector('.match-option')?.focus()); }
  return menu;
}
/** Edit wording: the user's own words for the change (kept while other things happen, like every draft). */
function wordingForm(p) {
  const drafts = projectView.drafts ??= new Map();
  const key = `wording:${p.id}`;
  const form = el('form', undefined, 'mem-edit ok-wording');
  const input = focusKey(el('input'), `wording-input:${p.id}`);
  input.value = drafts.get(key) ?? projectView.wordings.get(p.id) ?? p.changes.find(c => c.text)?.text ?? p.sourceText;
  input.setAttribute('aria-label', 'Wording to record');
  input.oninput = () => drafts.set(key, input.value);
  const use = el('button', 'Use this wording', 'button small-button primary');
  const cancel = el('button', 'Cancel', 'text-action');
  cancel.type = 'button';
  cancel.onclick = () => { drafts.delete(key); projectView.wordingOpen = null; renderNeedsOk(); requestAnimationFrame(() => $('ok-rows').querySelector(`[data-focus="accept:${p.id}"]`)?.focus()); };
  form.onsubmit = event => {
    event.preventDefault();
    if (!input.value.trim()) return;
    projectView.wordings.set(p.id, input.value.trim());
    drafts.delete(key);
    projectView.wordingOpen = null;
    renderNeedsOk();
    requestAnimationFrame(() => $('ok-rows').querySelector(`[data-focus="accept:${p.id}"]`)?.focus());
  };
  const buttons = el('div', undefined, 'mem-edit-buttons');
  buttons.append(use, cancel);
  form.append(input, buttons);
  if (projectView.focusEditor === key) { projectView.focusEditor = null; requestAnimationFrame(() => input.focus()); }
  return form;
}
/**
 * The changes found in one edit of a memory file: one block with one Source; each change can be accepted or rejected, and
 * several together with "Accept all" (all or none). One filled button: Accept for a single change, Accept all for several.
 */
function editBlock(block) {
  const { projectBase, post } = projectAccess();
  const first = block.entries[0].p;
  const key = `edit:${block.capture}`;
  const pending = block.entries.filter(e => !e.resolved).map(e => e.p);
  const together = projectView.resolvedEdits.get(block.capture);
  const row = el('div', undefined, `ok-row ok-edit${together?.state === 'rejected' ? ' rejected' : ''}`);
  row.dataset.row = key;
  const head = el('span', undefined, 'ok-head');
  head.append(el('strong', `Edited in ${first.source.file}`), ' · ', el('span', wallClock(first.createdAt), 'muted small'));
  row.append(head);
  if (pending.length) row.append(sourcePicker(key, 'No source given', first.suggested));
  const single = block.entries.length === 1;
  for (const { p, resolved } of block.entries) {
    const change = el('div', undefined, `ok-change${resolved?.state === 'rejected' && !together ? ' rejected' : ''}`);
    change.append(textEl('span', p.summary, 'ok-proposed'));
    const stale = !resolved && isStale(p);
    if (stale) change.append(staleLine(p));
    // Resolved together: the block shows the result once, below.
    if (resolved && !together) change.append(resolvedActions(p, resolved, async () => { await undoResolution(p, resolved); await refreshProject(); }));
    else if (!resolved) {
      const actions = el('div', undefined, 'ok-actions');
      if (stale) {
        const review = focusKey(el('button', 'Review again', single ? 'button small-button primary' : 'text-action'), `review:${p.id}`);
        review.onclick = () => { (projectView.menu ??= {}); (projectView.menu.reviewed ??= new Set()).add(p.id); renderNeedsOk(); };
        actions.append(review);
      } else {
        const accept = focusKey(el('button', 'Accept', single ? 'button small-button primary' : 'text-action'), `accept:${p.id}`);
        accept.setAttribute('aria-label', `Accept: ${p.summary}`);
        accept.onclick = guarded(() => acceptOne(p, key, sourceValue(key, first.suggested)));
        actions.append(accept);
      }
      actions.append(rejectButton(p, key));
      change.append(actions);
    }
    row.append(change);
  }
  if (together) {
    row.append(resolvedActions({ id: key, summary: `${block.entries.length} changes in ${first.source.file}` }, together, async () => {
      for (const { p } of block.entries) { const r = projectView.resolved.get(p.id); if (r) await undoResolution(p, r); }
      projectView.resolvedEdits.delete(block.capture);
      await refreshProject();
    }));
  } else if (!single && pending.length > 1) {
    const actions = el('div', undefined, 'ok-actions');
    // All or nothing, in one transaction; a change made stale since must be reviewed on its own first.
    if (!pending.some(isStale)) {
      const all = focusKey(el('button', 'Accept all', 'button small-button primary'), `accept-all:${block.capture}`);
      all.setAttribute('aria-label', `Accept all ${pending.length} changes from this edit of ${first.source.file}`);
      all.onclick = guarded(async () => {
        const source = sourceValue(key, first.suggested);
        const items = pending.map(p => ({ id: p.id, source, ...(projectView.menu?.reviewed?.has(p.id) ? { expect: currentVersions(p) } : {}) }));
        try {
          const result = await post(`${projectBase()}/proposals/accept-all`, { requestId: requestId(), items });
          for (const p of pending) projectView.resolved.set(p.id, { proposal: p, state: 'accepted', batch: result.batches[p.id], at: Date.now() });
          projectView.resolvedEdits.set(block.capture, { state: 'accepted', at: Date.now() });
        } finally { await refreshProject(); }
        focusNextRow(key);
      });
      actions.append(all);
    }
    const none = textAction('Reject all', `reject-all:${block.capture}`);
    none.setAttribute('aria-label', `Reject all ${pending.length} changes from this edit of ${first.source.file}`);
    none.onclick = guarded(async () => {
      try {
        await post(`${projectBase()}/proposals/reject-all`, { ids: pending.map(p => p.id) });
        for (const p of pending) projectView.resolved.set(p.id, { proposal: p, state: 'rejected', at: Date.now() });
        projectView.resolvedEdits.set(block.capture, { state: 'rejected', at: Date.now() });
      } finally { await refreshProject(); }
      focusNextRow(key);
    });
    actions.append(none);
    row.append(actions);
  }
  return row;
}
/** Change ▾ → Belongs to another item…: the next candidates, "a new item instead", and a search over every item, closed ones too. */
function matchMenu(p) {
  const d = projectView.data;
  const menu = el('div', undefined, 'match-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Belongs to another item');
  const current = chosenTarget(p);
  // Closing returns focus to the row's Change ▾ button.
  const close = () => { projectView.menu.open = null; renderNeedsOk(); requestAnimationFrame(() => $('ok-rows').querySelector(`[data-focus="change:${p.id}"]`)?.focus()); };
  const choose = id => { (projectView.menu.choices ??= new Map()).set(p.id, id); close(); };
  const option = (id, label) => {
    const button = focusKey(el('button', undefined, 'match-option'), `option:${p.id}:${id}`);
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(id === current));
    button.append(el('span', id === current ? '●' : '', 'mark'), el('span', label));
    button.onclick = () => choose(id);
    return button;
  };
  const label = id => { const i = d.items.find(x => x.id === id); return i ? `${i.id} · ${i.text}${OPEN_STATUSES.includes(i.status) ? '' : ` (${i.status})`}` : id; };
  const ids = [...new Set([...Object.keys(p.targets), ...p.alternatives])].filter(id => d.items.some(i => i.id === id));
  if (ids.length) {
    menu.append(el('span', p.kind === 'update' ? 'Apply to' : 'Raise again under', 'menu-label'));
    for (const id of ids) menu.append(option(id, label(id)));
  }
  const search = focusKey(el('input'), `search:${p.id}`);
  search.placeholder = 'Search all items, closed ones too';
  search.setAttribute('aria-label', 'Search all items');
  search.value = projectView.menu.search ?? '';
  const results = el('div');
  const find = () => {
    projectView.menu.search = search.value;
    const q = search.value.trim().toLowerCase();
    results.replaceChildren(...(q.length < 2 ? [] : d.items.filter(i => i.status !== 'merged' && !ids.includes(i.id) && `${i.id} ${i.text}`.toLowerCase().includes(q)).slice(0, 8).map(i => option(i.id, label(i.id)))));
  };
  search.oninput = find;
  // Arrow keys move between the options and the search field; Escape closes from anywhere in the menu.
  menu.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const stops = [...menu.querySelectorAll('.match-option, input')];
    const at = stops.indexOf(document.activeElement);
    stops[(at + (event.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length]?.focus();
    event.preventDefault();
  };
  menu.append(search, results);
  find();
  if (projectView.menu.justOpened !== p.id) { projectView.menu.justOpened = p.id; requestAnimationFrame(() => (menu.querySelector('[aria-checked="true"]') ?? search).focus()); }
  return menu;
}

// A click outside an open Change ▾ menu closes it.
document.addEventListener('click', event => {
  if (!(projectView.menu?.open || projectView.menu?.change) || event.target.closest?.('.match-menu, [data-match]')) return;
  Object.assign(projectView.menu, { open: null, change: null, justOpened: null, changeFocused: null });
  renderNeedsOk();
});

// The brief: where the project stands. AI-written versions say so, with Undo; every version is kept.
function renderBrief() {
  bindBriefControls();
  const brief = projectView.data.brief;
  $('brief').hidden = !brief && !projectView.data.items.length;
  $('brief-text').textContent = brief?.text || 'No brief yet. It is written after a meeting’s notes, or you can write one.';
  $('brief-who').textContent = !brief?.text ? '' : brief.actor === 'ai' ? `Written by AI after ${day(brief.at)} ·` : brief.actor === 'file' ? `Edited in brief.md on ${day(brief.at)} ·` : `Edited on ${day(brief.at)} ·`;
  $('brief-undo').hidden = !(brief?.actor === 'ai' && brief.text);
  $('brief-versions-button').hidden = !brief || brief.version < 2;
  // Folded to three lines; More shows the rest (only when there is more).
  $('brief-text').classList.toggle('clamp', !projectView.briefOpen);
  requestAnimationFrame(() => {
    const t = $('brief-text');
    $('brief-more').hidden = !projectView.briefOpen && t.scrollHeight <= t.clientHeight + 1;
    $('brief-more').textContent = projectView.briefOpen ? 'Less' : 'More';
    $('brief-more').setAttribute('aria-expanded', String(Boolean(projectView.briefOpen)));
  });
  // A list opened for an older brief would restore against a version that is gone: it closes when the brief changes.
  if (projectView.versionsOf !== undefined && projectView.versionsOf !== (brief?.version ?? null)) closeVersions();
}
function closeVersions() {
  $('brief-versions').hidden = true;
  $('brief-versions-button').setAttribute('aria-expanded', 'false');
  projectView.versionsOf = undefined;
}
// While the brief is edited, only the editor and Save / Cancel are shown.
function briefEditing(on) {
  $('brief-edit').hidden = !on; $('brief-text').hidden = on;
  document.querySelector('#brief .brief-meta').hidden = on;
  if (on) closeVersions();
}
function bindBriefControls() {
  const { projectBase, send, api } = projectAccess();
  $('brief-edit-button').onclick = () => {
    $('brief-input').value = projectView.data?.brief?.text ?? '';
    briefEditing(true);
    $('brief-input').focus();
  };
  $('brief-cancel').onclick = () => { briefEditing(false); $('brief-edit-button').focus(); };
  $('brief-save').onclick = guarded(async () => {
    await send(`${projectBase()}/brief`, 'PUT', { text: $('brief-input').value, basedOn: projectView.data?.brief?.version ?? null });
    briefEditing(false);
    await refreshProject();
    $('brief-edit-button').focus();
  });
  // Undo of an AI rewrite: the version before it comes back as it was (with its own author), or no brief if it was the first.
  $('brief-undo').onclick = guarded(async () => {
    const { brief, versions } = await api(`${projectBase()}/brief`);
    const previous = versions.find(v => v.version < brief.version);
    await send(`${projectBase()}/brief`, 'PUT', previous ? { restore: previous.version, basedOn: brief.version } : { text: '', basedOn: brief.version });
    closeVersions();
    await refreshProject();
    $('brief-edit-button').focus();
  });
  $('brief-more').onclick = () => { projectView.briefOpen = !projectView.briefOpen; renderBrief(); };
  $('brief-versions-button').onclick = guarded(async () => {
    if (!$('brief-versions').hidden) { closeVersions(); return; }
    const { brief, versions } = await api(`${projectBase()}/brief`);
    projectView.versions = { current: brief.version, list: versions, open: new Set() };
    renderVersions();
    $('brief-versions').hidden = false;
    projectView.versionsOf = brief.version;
    $('brief-versions-button').setAttribute('aria-expanded', 'true');
  });
}
/** Each version opens to show its text, with "Restore this version" (the text is never only in a tooltip). */
function renderVersions() {
  const { projectBase, send, api } = projectAccess();
  const { current, list, open } = projectView.versions;
  keepFocus($('brief-versions'), () => $('brief-versions').replaceChildren(...list.map(v => {
    const li = el('li', undefined, 'brief-version');
    const shown = open.has(v.version);
    const toggle = focusKey(el('button', `${shown ? '▾' : '▸'} v${v.version} · ${v.actor === 'ai' ? 'AI' : v.actor === 'file' ? 'brief.md' : 'you'} · ${day(v.at)}${v.version === current ? ' · shown now' : ''}`, 'version-toggle'), `version:${v.version}`);
    toggle.setAttribute('aria-expanded', String(shown));
    toggle.onclick = () => { if (shown) open.delete(v.version); else open.add(v.version); renderVersions(); };
    li.append(toggle);
    if (shown) {
      li.append(el('p', v.text || '(empty)', 'version-text'));
      if (v.version !== current) {
        const restore = focusKey(el('button', 'Restore this version', 'text-action'), `restore:${v.version}`);
        restore.onclick = guarded(async () => {
          // Against the newest version, read now (the brief may have changed since the list opened).
          const latest = (await api(`${projectBase()}/brief`)).brief;
          await send(`${projectBase()}/brief`, 'PUT', { restore: v.version, basedOn: latest.version });
          closeVersions();
          await refreshProject();
          $('brief-versions-button').focus();
        });
        li.append(restore);
      }
    }
    return li;
  })));
}

// The lists: To-dos, Decisions, Questions, with the Show filter. AI-recorded items and links carry "new" and Undo.
function visibleItems() {
  const d = projectView.data;
  const f = projectView.filter ?? 'all';
  const live = d.items.filter(i => i.status !== 'merged' && !(i.status === 'dropped' && i.fields.reason === 'undone'));
  // An item changed in the last 15 s stays where it was, in every view, with its Undo.
  if (f === 'changes') return live.filter(i => fromThisMeeting(i) || recentlyChanged(i));
  if (f === 'closed') return live.filter(i => !OPEN_STATUSES.includes(i.status) || recentlyChanged(i));
  const open = live.filter(i => OPEN_STATUSES.includes(i.status) || recentlyChanged(i));
  return f === 'all' ? open : open.filter(i => i.type === f);
}
/** Changed by the user in the last 15 s: stays in place with one Undo; dimmed only if the change closed it. */
const recentlyChanged = item => { const r = projectView.recent?.get(item.id); return Boolean(r && Date.now() - r.at < RESOLVED_MS); };
/** Remembers the user's change to each item it touched, for its Undo window. */
function noteRecent(result, word) {
  for (const item of result.items ?? []) (projectView.recent ??= new Map()).set(item.id, { batch: result.batch, at: Date.now(), word, closing: !OPEN_STATUSES.includes(item.status) });
}
function unconfirmedOf(item) {
  const info = projectView.data.info[item.id];
  const links = (info?.unconfirmed ?? []).filter(u => projectView.filter !== 'changes' || u.meetingId === changesMeeting() || deletedMeeting(u.meetingId));
  return { item: !item.confirmed, links };
}
function renderMemoryLists() {
  const { projectBase, post } = projectAccess();
  const d = projectView.data;
  const items = visibleItems();
  const waiting = new Set(d.proposals.flatMap(p => Object.keys(p.targets)));
  const sections = TYPE_ORDER.map(([type, title]) => {
    const list = items.filter(i => i.type === type);
    if (!list.length) return null;
    const section = el('section', undefined, 'project-section');
    section.setAttribute('aria-label', title);
    section.append(el('h3', `${title} (${list.length})`, 'project-heading'), ...list.flatMap(item => memoryRow(item, waiting.has(item.id))));
    return section;
  }).filter(Boolean);
  keepFocus($('memory-lists'), () => {
    $('memory-lists').replaceChildren(...sections);
    if (!sections.length && d.items.length) $('memory-lists').append(el('p', projectView.filter === 'changes' ? 'Nothing changed in memory from this meeting yet.' : 'Nothing to show here.', 'notes-empty'));
  });
  $('project-empty').hidden = Boolean(d.items.length);
  // The Show filter, and one "Confirm all new" for what is on screen. Before this meeting has changes, "Changes" is since the last one.
  const from = changesMeeting();
  const previous = from !== meetingId ? status?.meetings.find(m => m.id === from) : null;
  $('project-filter').options[0].textContent = previous ? `Since last meeting (${day(previous.createdAt)})` : 'This meeting’s changes';
  $('lists-bar').hidden = !d.items.length;
  const pending = items.flatMap(i => { const u = unconfirmedOf(i); return [...(u.item ? [{ op: 'confirm', item: i.id }] : []), ...u.links.map(l => ({ op: 'confirm', item: i.id, event: l.event }))]; });
  $('confirm-all').hidden = !pending.length;
  $('confirm-all').textContent = `Confirm all new (${pending.length})`;
  $('confirm-all').onclick = guarded(async () => { await post(`${projectBase()}/memory`, { requestId: requestId(), changes: pending }); await refreshProject(); $('project-filter').focus(); });
  if ([...(projectView.recent?.values() ?? [])].some(r => Date.now() - r.at < RESOLVED_MS)) setTimeout(() => { if (projectView.data === d) renderMemoryLists(); }, RESOLVED_MS + 100);
}
function memoryRow(item, waiting) {
  const { projectBase, post } = projectAccess(item);
  const d = projectView.data;
  const info = d.info[item.id];
  const recent = recentlyChanged(item) ? projectView.recent.get(item.id) : null;
  const row = el('div', undefined, `mem-row${recent?.closing ? ' closing' : ''}`);
  // Only to-dos are ticked; a question is answered in words (its actions), a decision changes by Reverse (as in mockup C).
  if (item.type !== 'todo') row.append(el('span', '', 'gap16'));
  else {
    const box = focusKey(el('input'), `box:${item.id}`);
    box.type = 'checkbox';
    box.dataset.item = item.id;
    box.checked = item.status === 'done';
    box.disabled = waiting || item.status === 'dropped';
    box.setAttribute('aria-label', waiting ? `${item.id} is waiting for your OK` : box.checked ? `Reopen ${item.id}: ${item.text}` : `Mark ${item.id} done: ${item.text}`);
    box.onchange = guarded(async () => {
      const to = box.checked ? 'done' : 'open';
      const result = await post(`${projectBase()}/memory`, { requestId: requestId(), changes: [{ op: 'status', item: item.id, to, ...(to === 'open' ? { reason: 'reopened in the app' } : {}) }], expect: { [item.id]: item.version } });
      noteRecent(result, to === 'done' ? 'marking done' : 'reopening');
      await refreshProject();
    });
    row.append(box);
  }
  const main = el('div', undefined, 'mem-main');
  const open = projectView.expanded.has(item.id);
  // ▸ says the row opens (its history and actions); the text opens it too.
  const line = el('div', undefined, 'mem-line');
  const chev = focusKey(el('button', open ? '▾' : '▸', 'mem-chev'), `chev:${item.id}`);
  chev.setAttribute('aria-label', `${open ? 'Close' : 'Open'} ${item.id}`);
  chev.setAttribute('aria-expanded', String(open));
  chev.onclick = () => toggleItem(item.id);
  const text = focusKey(el('button', `${item.id} · ${item.text}`, 'mem-text'), `text:${item.id}`);
  text.dataset.item = item.id;
  text.setAttribute('aria-expanded', String(open));
  text.onclick = () => toggleItem(item.id);
  line.append(chev, text);
  // Under the text: since when (older items only), its status if closed, what is new and when, one Undo, waiting for an OK.
  const unconfirmed = unconfirmedOf(item);
  const meta = el('div', undefined, 'mem-meta');
  const add = (...parts) => meta.append(...(meta.childNodes.length ? [' · '] : []), ...parts);
  if (!unconfirmed.item) add(`since ${day(item.createdAt)}`);
  if (!OPEN_STATUSES.includes(item.status)) add(item.status);
  if (unconfirmed.item || unconfirmed.links.length) {
    const when = unconfirmed.item ? item.createdAt : unconfirmed.links.at(-1).at;
    meta.append(...(meta.childNodes.length ? [' '] : []), el('span', `${unconfirmed.item ? 'New' : 'Raised again'} ${dayWord(when)}`, 'new-tag'));
  }
  main.append(line);
  // One Undo: the user's own latest change while its window is open; otherwise what is new here (the item if it came from
  // the meeting shown, else its latest "raised again").
  let undo = null;
  if (recent) undo = { batch: recent.batch, label: `Undo ${recent.word} ${item.id}`, after: () => projectView.recent.delete(item.id) };
  else if (unconfirmed.item || unconfirmed.links.length) {
    const link = unconfirmed.links.length && (!unconfirmed.item || info?.createdIn !== changesMeeting());
    const batch = link ? unconfirmed.links.at(-1).batch : info?.created;
    if (batch) undo = { batch, label: link ? `Undo: ${item.id} raised again` : `Undo adding ${item.id}` };
  }
  if (undo) {
    // The user's own change keeps its Undo in view for its 15 s; an AI record's Undo shows on pointing or Tab (fewer links).
    const button = focusKey(el('button', 'Undo', recent ? 'link-button' : 'link-button hover-undo'), `undo:${item.id}`);
    button.setAttribute('aria-label', undo.label);
    button.onclick = guarded(async () => {
      await post(`${projectBase()}/memory/undo`, { batch: undo.batch, requestId: requestId() });
      undo.after?.();
      await refreshProject();
      focusItem(item.id);
    });
    meta.append(button);
  }
  if (waiting) add(el('span', 'waiting for your OK ↑', 'waiting'));
  if (meta.childNodes.length) main.append(meta);
  row.append(main);
  const out = [row];
  const timeline = projectView.expanded.get(item.id);
  if (timeline) out.push(timelineList(item, timeline), itemActions(item));
  if (projectView.editing === item.id) out.push(editRow(item));
  if (projectView.answering === item.id) out.push(editRow(item, 'answer'));
  return out;
}
/** "today", "yesterday", or the day ("Oct 9"). */
function dayWord(ms) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : day(ms);
}
/** After an action: focus goes to the item's text (or the Show select if the item left the view). */
function focusItem(id) {
  requestAnimationFrame(() => ($('memory-lists').querySelector(`[data-focus="text:${id}"]`) ?? $('project-filter')).focus());
}
async function toggleItem(id) {
  const { projectBase, api } = projectAccess();
  if (projectView.expanded.has(id)) { projectView.expanded.delete(id); renderMemoryLists(); return; }
  projectView.expanded.set(id, []);
  try { projectView.expanded.set(id, (await api(`${projectBase()}/memory/items/${id}`)).timeline); }
  catch (error) { log(error.message, true); }
  renderMemoryLists();
}
const WHO = event => event.actor === 'ai' ? 'AI-recorded' : event.actor === 'user' ? 'by you' : event.actor === 'file' ? 'from a file edit' : String(event.actor).startsWith('agent:') ? 'agent note' : '';
function eventSource(event) {
  const s = event.source;
  const span = el('span');
  if (!s) return span;
  if (s.kind === 'meeting') {
    const line = s.lines?.[0];
    const title = status?.meetings.find(m => m.id === s.meetingId)?.title ?? 'a meeting';
    if (line && s.meetingId === meetingId) {
      const time = el('button', stamp(line.startMs), 'card-time');
      time.setAttribute('aria-label', `Jump to ${stamp(line.startMs)} in the transcript`);
      time.onclick = () => scrollToSegment(meetingId, line.id);
      span.append(time);
    } else span.append(`${title}${line ? ` ${stamp(line.startMs)}` : ''}`);
    if (s.quote) span.append(` — “${s.quote}”`);
  } else if (s.kind === 'chat') span.append(`told in the app: “${s.text}”`);
  else if (s.kind === 'file') span.append(`edited in ${s.file}`);
  else if (s.kind === 'agent') span.append(`agent note: “${s.note.slice(0, 160)}”`);
  else if (s.kind === 'commit') {
    span.append(`commit ${s.hash.slice(0, 7)} “${s.subject}”${s.guessed ? ' (guessed)' : ''}`);
    if (s.from) span.append(', from ', eventSource({ source: s.from }));
  }
  else if (s.kind === 'plan') span.append(`from the plans of ${status?.meetings.find(m => m.id === s.meetingId)?.title ?? 'a meeting'}`);
  else if (s.kind === 'undo') span.append('undone');
  else if (s.kind === 'app') span.append('in the app');
  return span;
}
function timelineList(item, events) {
  const list = el('ol', undefined, 'timeline');
  list.setAttribute('aria-label', `${item.id} timeline`);
  const words = { create: 'Raised', addSource: 'Raised again', status: 'Status', answer: 'Answered', supersede: 'Superseded', merge: 'Merged', edit: 'Reworded', confirm: 'Confirmed', undo: 'Undone' };
  for (const e of events) {
    if (e.op === 'confirm' && !e.ref) { list.append(el('li', `Confirmed · ${day(e.at)}`, 'muted')); continue; }
    const li = el('li');
    const what = e.op === 'status' ? `→ ${e.after?.status}` : e.op === 'answer' ? `Answered: ${e.after?.fields?.answer ?? ''}` : words[e.op] ?? e.op;
    li.append(`${what} · ${day(e.at)} · `, eventSource(e), el('span', ` · ${WHO(e)}${e.undone ? ' · later undone' : ''}`, 'muted'));
    list.append(li);
  }
  if (!events.length) list.append(el('li', 'Loading…', 'muted'));
  return list;
}
function itemActions(item) {
  const { projectBase, post, check } = projectAccess(item);
  const box = el('div', undefined, 'mem-actions');
  const action = (label, aria, onclick) => { const button = focusKey(el('button', label, 'link-button'), `action:${item.id}:${label}`); button.setAttribute('aria-label', aria); button.onclick = onclick; box.append(button); };
  // Confirm one item (and its new "raised again" links); "Confirm all new" does the same for everything shown.
  const unconfirmed = unconfirmedOf(item);
  if (unconfirmed.item || unconfirmed.links.length) action('Confirm', `Confirm ${item.id}`, guarded(async () => {
    await post(`${projectBase()}/memory`, { requestId: requestId(), changes: [...(unconfirmed.item ? [{ op: 'confirm', item: item.id }] : []), ...unconfirmed.links.map(l => ({ op: 'confirm', item: item.id, event: l.event }))] });
    await refreshProject();
    focusItem(item.id);
  }));
  const open = mode => { check(); projectView.editing = mode === 'edit' ? item.id : null; projectView.answering = mode === 'answer' ? item.id : null; projectView.focusEditor = `${item.id}:${mode}`; renderMemoryLists(); };
  action('Edit', `Edit ${item.id}`, () => open('edit'));
  const change = (label, to, reason, word) => action(label, `${label} ${item.id}`, guarded(async () => {
    const result = await post(`${projectBase()}/memory`, { requestId: requestId(), changes: [{ op: 'status', item: item.id, to, ...(reason ? { reason } : {}) }], expect: { [item.id]: item.version } });
    noteRecent(result, word);
    await refreshProject();
    focusItem(item.id);
  }));
  if (item.type === 'question' && item.status === 'open') action('Answer…', `Answer ${item.id}`, () => open('answer'));
  if (item.type === 'decision') { if (item.status === 'in force') change('Reverse', 'reversed', null, 'reversing'); else change('Back in force', 'in force', 'restored in the app', 'restoring'); }
  else if (item.status === 'open') change('Drop', 'dropped', null, 'dropping');
  else change('Reopen', 'open', 'reopened in the app', 'reopening');
  return box;
}
/**
 * Inline form under an item: new wording (Edit), or a question's answer (Answer…). The draft lives outside the DOM, so
 * other actions and re-renders never lose what the user typed; it goes only on Save or Cancel.
 */
function editRow(item, mode = 'edit') {
  const { projectBase, post } = projectAccess(item);
  const key = `${item.id}:${mode}`;
  const drafts = projectView.drafts ??= new Map();
  const form = el('form', undefined, 'mem-edit');
  const input = focusKey(el('input'), `editor:${key}`);
  input.value = drafts.get(key) ?? (mode === 'edit' ? item.text : '');
  input.placeholder = mode === 'answer' ? 'The answer, in a sentence' : '';
  input.setAttribute('aria-label', mode === 'edit' ? `New text for ${item.id}` : `Answer to ${item.id}`);
  input.oninput = () => drafts.set(key, input.value);
  const save = el('button', mode === 'edit' ? 'Save' : 'Save answer', 'button primary');
  const cancel = el('button', 'Cancel', 'button');
  cancel.type = 'button';
  const done = () => { projectView.editing = null; projectView.answering = null; drafts.delete(key); };
  cancel.onclick = () => { done(); renderMemoryLists(); focusItem(item.id); };
  form.onsubmit = guarded(async event => {
    event.preventDefault();
    const change = mode === 'edit' ? { op: 'edit', item: item.id, text: input.value } : { op: 'answer', item: item.id, text: input.value };
    const result = await post(`${projectBase()}/memory`, { requestId: requestId(), changes: [change], expect: { [item.id]: item.version } });
    noteRecent(result, mode === 'edit' ? 'editing' : 'answering');
    done();
    await refreshProject();
    focusItem(item.id);
  });
  const buttons = el('div', undefined, 'mem-edit-buttons');
  buttons.append(save, cancel);
  form.append(input, buttons);
  // Focused when it opens, not on every re-render (another row's action must not pull focus here).
  if (projectView.focusEditor === key) { projectView.focusEditor = null; requestAnimationFrame(() => input.focus()); }
  return form;
}

// "Tell the project…": the sentence is interpreted, shown right under the box, and applied only on Apply (§5).
$('tell-form').onsubmit = guarded(async event => {
  event.preventDefault();
  const { projectBase, post, check } = projectAccess();
  const text = $('tell-input').value.trim();
  if (!text) return;
  const box = $('tell-result');
  box.hidden = false;
  box.replaceChildren(el('span', 'Reading…', 'muted small'));
  const owner = projectView.project?.id;
  let result;
  try { result = await post(`${projectBase()}/tell`, { text }); }
  catch (error) { check(); box.replaceChildren(el('span', error.message, 'error small')); return; }
  if (owner !== projectView.project?.id) return;
  // One request id per interpretation: a double click applies it once.
  projectView.tell = { text, plans: result.plans, requestId: requestId() };
  const actions = el('div', undefined, 'ok-actions');
  // Refusals the user can act on; the model's own format slips (an unknown kind, an empty update) are not theirs to fix.
  const dropped = (result.dropped ?? []).map(reason => reason.replace(/^[^:\s]+:\s*/, ''))
    .filter(reason => !/^(unknown (target|kind)|an update with nothing to change|a new item needs a type and text)/.test(reason))
    .map(reason => el('span', `Not applied: ${reason}`, 'muted small'));
  if (!result.plans.length) {
    const close = el('button', 'Close', 'text-action');
    close.onclick = () => { box.hidden = true; $('tell-input').focus(); };
    box.replaceChildren(...(dropped.length ? dropped : [el('span', 'No changes found in that note.')]), actions);
    actions.append(close);
    close.focus();
    return;
  }
  const apply = el('button', 'Apply', 'button small-button primary');
  apply.onclick = guarded(async () => {
    const { plans, requestId: id } = projectView.tell;
    const applied = await post(`${projectBase()}/tell/apply`, { requestId: id, text, changes: plans.flatMap(p => p.changes), expect: Object.assign({}, ...plans.map(p => p.targets)) });
    noteRecent(applied, 'applying');
    box.hidden = true; $('tell-input').value = ''; projectView.tell = null;
    await refreshProject();
    $('tell-input').focus();
  });
  const change = el('button', 'Change', 'text-action');
  change.onclick = () => { box.hidden = true; $('tell-input').focus(); };
  actions.append(apply, change);
  box.replaceChildren(...result.plans.map(p => el('span', `${p.summary}${p.flags.length ? ` (${p.flags.join('; ')})` : ''}`)), ...dropped, actions);
  apply.focus();
});

// Memory ids in answers (T-3, D-4, Q-2) become pills that open a small popover in place (§2). An answer pins the memory it
// saw (`pins`, §7): the popover shows that version, and what changed since if the item moved on.
function memoryPills(body, pins) {
  const items = projectView.data?.items;
  const known = new Set(pins ? Object.keys(pins.items) : (items ?? []).map(i => i.id));
  if (!known.size) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\b[TDQ]-\d+\b/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement.closest('pre, code, button')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    node.replaceWith(...node.nodeValue.split(/\b([TDQ]-\d+)\b/).map(part => {
      if (!known.has(part)) return document.createTextNode(part);
      const pill = el('button', part, 'memory-pill');
      pill.setAttribute('aria-label', `Project memory item ${part}`);
      pill.onclick = event => { event.stopPropagation(); showMemoryPopover(part, pill, pins); };
      return pill;
    }));
  }
}
function showMemoryPopover(id, anchor, pins) {
  const pinned = pins?.items[id];
  // The current item, only within the same project (a moved meeting's old answer refers to its old project).
  const current = !pins || pins.projectId === projectView.project?.id ? projectView.data?.items.find(i => i.id === id) : undefined;
  const pop = $('memory-popover');
  if (!pinned && !current) return;
  const view = el('button', 'View in Project tab', 'link-button');
  view.onclick = () => { pop.hidden = true; openPane('project'); if (!projectView.expanded.has(id)) void toggleItem(id); };
  if (pinned) {
    const changed = current && current.version !== pinned.version;
    // Nothing is added when the item is unchanged; only a change since the answer, or a moved meeting, says so.
    pop.replaceChildren(el('strong', `${id} · ${ITEM_WORD[pinned.type] ?? 'item'} · ${pinned.status}`), el('span', pinned.text),
      ...(changed ? [el('span', `Changed since this answer: now ${current.status} · ${current.text}`, 'ok-flag small')] : []),
      ...(current ? [view] : [el('span', 'From the project memory at the time of this answer.', 'muted small')]));
  } else pop.replaceChildren(el('strong', `${current.id} · ${ITEM_WORD[current.type]} · ${current.status}${current.confirmed ? '' : ' · unconfirmed'}`), el('span', current.text), el('span', `since ${day(current.createdAt)}`, 'muted small'), view);
  const box = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - 332))}px`;
  pop.style.top = `${Math.min(box.bottom + 6, window.innerHeight - 160)}px`;
  pop.hidden = false;
  document.body.append(pop);
  (pop.querySelector('button') ?? pop).focus();
}
document.addEventListener('click', event => { if (!event.target.closest?.('#memory-popover')) $('memory-popover').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('memory-popover').hidden) $('memory-popover').hidden = true; });

// "Show another project’s meetings…" and "Move this meeting to…" (one small dialog).
let projectDialogMode = 'move';
async function openProjectDialog(mode) {
  projectDialogMode = mode;
  await loadProjects(); // current names and meeting counts
  closeMeetingMenu();
  closePanel();
  const current = status?.meetings.find(m => m.id === meetingId);
  $('project-dialog-title').textContent = mode === 'move' ? 'Move this meeting to…' : 'Show another project’s meetings';
  $('project-dialog-note').textContent = mode === 'move' ? `“${current?.title ?? ''}”. It takes the project’s materials and glossary; its memory so far stays where it was recorded.` : 'Show the meetings of another project.';
  $('project-dialog-go').textContent = mode === 'move' ? 'Move' : 'Show its meetings';
  $('project-dialog-error').hidden = true;
  const choices = [
    ...projectView.projects.map(p => [p.id, `${p.name}`, `${p.meetings} meeting(s)`]),
    [mode === 'move' ? 'none' : 'none', mode === 'move' ? 'No project' : 'Meetings without a project', ''],
    ['new', mode === 'move' ? 'A new project, from this meeting' : 'New project…', ''],
  ];
  const selected = mode === 'move' ? (current?.projectId ?? 'none') : (current?.projectId ?? 'none');
  $('project-choices').replaceChildren(...choices.map(([id, name, note]) => {
    const label = el('label', undefined, 'project-choice');
    const radio = el('input');
    radio.type = 'radio'; radio.name = 'project-choice'; radio.value = id; radio.checked = id === selected;
    radio.onchange = renderProjectDialog;
    label.append(radio, el('span', name), ...(note ? [el('span', note, 'muted small')] : []));
    return label;
  }));
  $('new-project-name').value = '';
  $('new-project-repo').value = '';
  renderProjectDialog();
  $('project-dialog').showModal();
  $('project-choices').querySelector('input:checked')?.focus();
}
function renderProjectDialog() {
  const choice = $('project-choices').querySelector('input:checked')?.value;
  const here = status?.meetings.find(m => m.id === meetingId)?.projectId ?? 'none';
  $('project-dialog-go').disabled = projectDialogMode === 'move' && choice === here;
  $('new-project-fields').hidden = choice !== 'new';
  // Offered only for a project that has no glossary yet (§8.2).
  const target = projectView.projects.find(p => p.id === choice);
  $('use-glossary-row').hidden = !(projectDialogMode === 'move' && target && choice !== here && !target.hasGlossary);
}
$('close-project-dialog').onclick = () => $('project-dialog').close();
$('project-dialog').addEventListener('close', () => $('meeting-button').focus());
$('project-dialog-go').onclick = async () => {
  const choice = $('project-choices').querySelector('input:checked')?.value;
  const error = $('project-dialog-error');
  error.hidden = true;
  try {
    if (projectDialogMode === 'switch') {
      let target = choice === 'none' ? null : choice;
      if (choice === 'new') {
        const name = $('new-project-name').value.trim();
        if (!name) throw new Error('Give the project a name.');
        target = (await post('/api/projects', { name, repoPath: $('new-project-repo').value.trim() || null })).id;
        await loadProjects();
      }
      $('project-dialog').close();
      // After this click has finished bubbling (a click outside the menu closes it).
      setTimeout(() => { projectView.menuProject = target; renderMeetingMenu(); openMeetingMenu(); }, 0);
      return;
    }
    if (!meetingId) throw new Error('Choose a meeting first.');
    if (choice === 'new') {
      const name = $('new-project-name').value.trim();
      if (!name) throw new Error('Give the project a name.');
      await post('/api/projects', { name, repoPath: $('new-project-repo').value.trim() || null, fromMeetingId: meetingId });
      log(`Created the project “${name}” with this meeting’s materials and glossary.`);
    } else {
      await post(`${base()}/project`, { projectId: choice === 'none' ? null : choice, useMeetingGlossary: $('use-meeting-glossary').checked });
      log(choice === 'none' ? 'This meeting is no longer in a project.' : `Moved to “${projectView.projects.find(p => p.id === choice)?.name}”.`);
    }
    $('project-dialog').close();
    await loadProjects();
    await refreshStatus();
    await refreshDetail();
  } catch (e) { error.textContent = e.message; error.hidden = false; }
};
$('switch-project').onclick = guarded(() => openProjectDialog('switch'));
$('move-meeting').onclick = guarded(() => openProjectDialog('move'));
$('put-in-project').onclick = guarded(() => openProjectDialog('move'));

// Settings: This project (Project, Materials, Glossary) / This meeting (Export; Materials and Glossary without a project) / This Mac.
function renderSettingsNav() {
  const nav = $('settings').querySelector('.settings-nav');
  const button = name => nav.querySelector(`button[data-section="${name}"]`);
  const after = projectView.project ? button('project') : $('nav-meeting-label');
  after.after(button('materials'), button('glossary'));
  if (!projectView.project) $('nav-meeting-label').after(button('materials'), button('glossary'), button('export'));
  else $('nav-meeting-label').after(button('export'));
}
$('save-project-name').onclick = guarded(async () => {
  const { projectBase, send } = projectAccess();
  const project = await send(projectBase(), 'PATCH', { name: $('project-name').value });
  log(`Project renamed to “${project.name}”.`);
  await loadProjects(); await refreshDetail();
});
$('save-project-repo').onclick = guarded(async () => {
  const { projectBase, send, post } = projectAccess();
  const repoPath = $('project-repo').value.trim();
  if (repoPath && !confirm(`Memory files will be written to\n${repoPath}/project-memory/\n\nThe app writes nothing else in this folder.`)) return;
  await send(projectBase(), 'PATCH', { repoPath: repoPath || null });
  await post(`${projectBase()}/files/sync`, {});
  log(repoPath ? `Memory files now go to ${repoPath}/project-memory/.` : 'Memory files now go to the app’s data folder.');
  await refreshDetail(); await renderProjectFiles();
});
$('copy-agents-line').onclick = guarded(async () => { await navigator.clipboard.writeText($('agents-line').value); log('Copied the line for AGENTS.md / CLAUDE.md.'); });
$('check-repo').onclick = guarded(async () => {
  const { projectBase, post } = projectAccess();
  const result = await post(`${projectBase()}/repo/check`, {});
  log(result.proposed ? `${result.proposed} to-do(s) may be done; see Needs your OK in the Project tab.` : `Checked ${result.commits} commit(s); nothing looks finished${result.more ? ' (older commits were not read)' : ''}.`);
  await refreshProject();
});
const seenSkippedFiles = new Set();
function logSkippedFiles(projectId, files) {
  for (const name of files?.skippedFiles ?? []) {
    const key = JSON.stringify([projectId, name]);
    if (!seenSkippedFiles.has(key)) { seenSkippedFiles.add(key); log(`Memory file refused (${name})`, true); }
  }
}
async function renderProjectFiles() {
  if (!projectView.project) return;
  const { projectBase, api } = projectAccess();
  try {
    const data = await api(`${projectBase()}/memory`);
    const files = data.files;
    const line = $('project-files');
    line.classList.toggle('warn-text', files.state === 'not ours');
    line.textContent = files.state === 'repo missing' ? 'The repo folder is missing: memory files are paused. Save the folder’s new location above.'
      : files.state === 'not ours' ? 'Memory files are off: project-memory/ has files HearAlong didn’t write.'
      : files.folder ? `Memory files: ${files.folder}` : 'Memory files are written after the first change.';
    if (files.state === 'ok' && files.skipped > 0) {
      line.append(' · ', el('span', `${files.skipped} ${files.skipped === 1 ? 'file' : 'files'} skipped (links or over 1 MB)`, 'warn-text'));
    }
    logSkippedFiles(projectView.project.id, files);
  } catch { /* shown on the next refresh */ }
}
$('settings').querySelector('.settings-nav button[data-section="project"]').addEventListener('click', () => void renderProjectFiles());

// ---------- Plans (M7b): its meeting tab, and the project's "Plan after the notes" ----------
plansApi = await choosePlansApi({ pageId, segmentIds: () => lastSnapshot?.meetingId === meetingId ? lastSnapshot.segments.map(s => s.id) : [] });
plansView = createPlansView({
  optionsHost: $('plans-options-slot'),
  optionsInHead: () => !layoutView.compact,
  host: $('plans'), api: plansApi,
  hooks: {
    meetingId: () => meetingId,
    meetingTitle: () => status?.meetings.find(m => m.id === meetingId)?.title ?? '',
    showLine: (owner, segmentId) => scrollToSegment(owner, segmentId),
    visible: () => notesView.tab === 'plans' && (!layoutView.compact || layoutView.tab === 'plans'),
    noteCounts: () => notesView.owner === meetingId && notesView.data?.notes ? {
      questions: notesView.data.notes.notes.openQuestions.length, actions: notesView.data.notes.notes.actions.length,
    } : null,
    log,
  },
});
const planSettingSaves = new Map();
/** A pending save belongs to one project, not to the checkbox (which may show another project meanwhile). */
function renderPlanSetting() {
  const box = $('plan-after-notes'), project = projectView.project;
  if (!project || !plansApi) return;
  box.checked = planSettingSaves.get(project.id) ?? plansApi.planAfterNotes(project);
  box.setAttribute('aria-busy', String(planSettingSaves.has(project.id)));
}
$('plan-after-notes').onchange = async () => {
  const box = $('plan-after-notes'), project = projectView.project;
  if (!project) return;
  if (planSettingSaves.has(project.id)) { renderPlanSetting(); return; }
  const wanted = box.checked;
  planSettingSaves.set(project.id, wanted);
  inlineError(box, null);
  renderPlanSetting();
  try {
    const saved = await plansApi.setPlanAfterNotes(project.id, wanted);
    project.planAfterNotes = saved.planAfterNotes;
    const cached = projectView.projects.find(p => p.id === project.id);
    if (cached) cached.planAfterNotes = saved.planAfterNotes;
    if (projectView.project?.id === project.id) projectView.project.planAfterNotes = saved.planAfterNotes;
    log(saved.planAfterNotes ? `Plans are now made after each meeting’s notes in “${project.name}”.` : `Plans are made only on request in “${project.name}”.`);
  } catch (error) {
    log(error.message, true);
    if (projectView.project?.id === project.id) inlineError(box, error.message);
  } finally {
    planSettingSaves.delete(project.id);
    renderPlanSetting();
  }
};

updateTranscriptDownloads(meetingId);
// Initialize project-dependent visibility/count even when no meeting detail will ever call setProject().
setProject(null);
await refreshStatus();
await refreshSegments();
await refreshDetail();
setInterval(refreshSegments, 1000);
startPageSession(refreshStatus);
setInterval(refreshDetail, 3000);
showTab(notesView.tab);
applyLayout();
// Notes poll while the tab is open, or while a job runs (so the button state is right when the tab opens).
setInterval(() => {
  if (['notes', 'plans'].includes(notesView.tab) || notesView.data?.job?.state === 'running') void refreshNotes();
  if (notesView.tab === 'plans') void plansView?.refresh();
}, 3000);
// The board polls every 3 s (a local read; the quick model runs on the server's own schedule).
setInterval(() => { void refreshBoard(); }, 3000);
// Project memory reloads when the meeting detail (polled every 3 s) says it changed; see refreshDetail.
void loadProjects();
// Actions poll fast while any is queued or running (live status), slowly otherwise.
let actionsTick = 0;
setInterval(() => {
  const active = actionsView.jobs.some(j => j.state === 'queued' || j.state === 'running');
  if (active || ++actionsTick % 4 === 0) void refreshActions();
}, 1500);
