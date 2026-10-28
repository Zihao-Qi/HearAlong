// The Plans tab of a meeting (M7b; docs/design/M7b-exploration.md §2b data, §3 UI, layout D1 "one tidy row").
// One row per decision: a short label, its answer line and/or its step line, Add to to-dos and a chevron on the right; the details
// open on click. The first three rows show, the rest fold under "N more". It shows what GET …/plans gives (the server's
// projection, src/plans/view.ts) and works nothing out itself: freshness, to-do states, checks and evidence all come from it.
// All server calls go through one API object (realPlansApi); with ?plans-fixture=<state> in the page URL, plans-fixtures.js
// answers them instead (a dev switch, off unless asked for).
import { stamp } from '/live-shared.js';
// A progress card owns only its own DOM; neither polling nor its clock touches saved notes/plans.
const progressNode = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const elapsedClock = startedAt => { const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function tickProgress(card) {
  const startedAt = Number(card.dataset.startedAt), estimate = Number(card.dataset.estimate);
  const rounded = Math.max(60_000, Math.round(estimate / 30_000) * 30_000);
  const minutes = rounded / 60_000;
  const about = estimate > 0 && Number.isFinite(estimate) && Date.now() - startedAt <= rounded
    ? ` of about ${Math.floor(minutes)}${minutes % 1 ? '½' : ''} min` : '';
  card.querySelector('.progress-heading').textContent = `${card.dataset.kind === 'notes' ? 'Writing notes' : 'Making plans'} · ${elapsedClock(startedAt)}${about}`;
}
const progressPlural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`.replaceAll(' ', '\u00a0');
const progressCountKnown = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
let progressClockStarted = false;
const progressIcons = {
  done: '<path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#23693F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  now: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="#C9D0DB" stroke-width="2"/><path class="progress-spin" d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="#2F56C6" stroke-width="2" stroke-linecap="round"/>',
  todo: '<circle cx="8" cy="8" r="6" fill="none" stroke="#C9D0DB" stroke-width="1.5"/>'
};
export function progressCard(kind, p, cancel, existing = null) {
  if (!progressClockStarted) { progressClockStarted = true; setInterval(() => document.querySelectorAll('.job-progress').forEach(tickProgress), 1000); }
  const node = progressNode;
  const card = existing ?? node('div', 'job-progress');
  if (!existing) {
    const header = node('div', 'progress-header');
    const button = node('button', 'text-action progress-cancel', 'Cancel'); button.type = 'button';
    button.setAttribute('aria-label', kind === 'notes' ? 'Cancel writing notes' : kind === 'explore' ? 'Cancel Explore further' : 'Cancel planning');
    header.append(node('span', 'progress-heading'), button);
    card.append(header, node('div', 'progress-steps'));
  }
  card.querySelector('.progress-cancel').onclick = cancel;
  card.dataset.kind = kind; card.dataset.startedAt = p.startedAt; card.dataset.estimate = p.estimate ?? '';
  tickProgress(card);
  const signature = JSON.stringify(p);
  if (card.dataset.progress === signature) return card;
  card.dataset.progress = signature;
  const phases = kind === 'notes' ? ['read', 'write', 'check'] : ['notes', 'materials', 'write', 'check'];
  const current = phases.indexOf(p.phase);
  const step = (phase, label, detail, latest, reserveDetail = false) => {
    const state = phases.indexOf(phase) < current ? 'done' : phase === p.phase ? 'now' : 'todo';
    const row = node('div', 'progress-step'); row.dataset.phase = phase; row.dataset.state = state;
    const icon = node('span', 'progress-icon');
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${progressIcons[state]}</svg>`;
    const body = node('div', 'progress-step-body');
    const title = node('div', 'progress-label', label); title.setAttribute('aria-label', `${label}: ${state === 'now' ? 'in progress' : state === 'todo' ? 'not started' : 'done'}`);
    body.append(title);
    if (detail || reserveDetail) body.append(node('div', `progress-detail${reserveDetail ? ' progress-detail-reserved' : ''}`, detail));
    if (kind === 'notes' && phase === 'write' && p.phase !== 'read') {
      const parts = node('div', 'progress-parts');
      for (const [key, label] of [['project', 'Project points'], ['tasks', 'Decisions and to-dos'], ['other', 'Other matters']]) {
        const part = p.parts?.[key] ?? {};
        const line = node('div', 'progress-part'); line.dataset.part = key;
        line.append(node('span', 'progress-part-label', label), node('span', 'progress-count', progressCountKnown(part.count) ? String(part.count) : ''), node('span', 'progress-part-done', part.done ? '✓' : ''));
        parts.append(line);
      }
      body.append(parts);
    }
    if (latest) body.append(node('div', 'progress-latest', `Latest: ${kind === 'notes' ? `“${latest}”` : latest}`));
    row.append(icon, body); return row;
  };
  const writtenDetail = progressCountKnown(p.written) ? p.exact && p.expected != null ? `${p.written} of ${p.expected}` : p.expected != null && p.written < p.expected ? `${p.written} of about ${p.expected}` : `${p.written} so far` : '';
  const steps = kind === 'notes' ? [
    step('read', 'Read the transcript', progressCountKnown(p.minutes) && progressCountKnown(p.lines) ? `${p.minutes} min · ${p.lines} lines` : '', null, true),
    step('write', 'Write the notes', p.phase === 'write' ? 'Three parts at once' : '', p.phase === 'write' ? p.latest : null),
    step('check', 'Check every quote', p.phase === 'check' ? 'Against the lines each item cites' : '')
  ] : [
    step('notes', 'Read the notes', progressCountKnown(p.questions) ? progressPlural(p.questions, 'open question') : '', null, true),
    step('materials', 'Read your materials', [...(p.materials ?? []).slice(0, 3), ...((p.materials?.length ?? 0) > 3 ? [`+${p.materials.length - 3}\u00a0more`] : []), ...(p.pages ? [progressPlural(p.pages, 'web page')] : []), ...(p.checks ? [progressPlural(p.checks, 'check run', 'checks run')] : [])].join(' · ')),
    step('write', 'Write the plans', current >= 2 ? writtenDetail : '', p.phase === 'write' ? p.latest : null, current >= 2),
    step('check', 'Check every source', p.phase === 'check' ? 'Quotes, files and the check' : '')
  ];
  card.querySelector('.progress-steps').replaceChildren(...steps);
  return card;
}
// ---------- End job progress ----------

export const TRUST = 'Sources checked, not the ideas themselves.';
const SHOWN = 3;
const UNDO_MS = 15_000;
const ACTIVE = new Set(['waiting', 'running']);

// ---------- The API object ----------

/**
 * The routes of the Plans section. An error carries the HTTP status, the server's `code` ("generation", "too long", "no
 * project", "other project", "unchecked", "busy", "version", "not ready"…) and, for a generation conflict, `current`: the
 * step's state now. A lost reply has no status.
 */
export function realPlansApi({ pageId }) {
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(path, {
      method,
      headers: { 'X-Page': pageId, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : {};
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status, code: data.code ?? null, current: data.current });
    return data;
  };
  const plans = meetingId => `/api/meetings/${encodeURIComponent(meetingId)}/plans`;
  const step = (meetingId, version, stepId, verb) => `${plans(meetingId)}/${encodeURIComponent(version)}/steps/${encodeURIComponent(stepId)}/${verb}`;
  return {
    fixture: null,
    /** GET …/plans → { enabled, notes, project, run, current, kept } (src/plans/view.ts PlansPage). */
    getPlans: meetingId => request(plans(meetingId)),
    getSubmission: (meetingId, opId) => request(`${plans(meetingId)}/runs?opId=${encodeURIComponent(opId)}`),
    /** Plan / Plan again: a new run based on the newest version. → { run, replayed } */
    startPlan: (meetingId, { opId }) => request(`${plans(meetingId)}/runs`, 'POST', { opId }),
    /** Cancel a waiting or running run (plan pass or Explore further). → { run } */
    cancel: (meetingId, runId) => request(`${plans(meetingId)}/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {}),
    /** Add to to-dos (§2b): once per operation id and generation. → { result, todo: the step's state now } */
    addTodo: (meetingId, version, stepId, { expect, opId }) => request(step(meetingId, version, stepId, 'todo'), 'POST', { expect, opId }),
    /** Undo of a to-do just added, by its step; a retry keeps its operation id. → { batch, todo } */
    undoTodo: (meetingId, version, stepId, { expect, opId }) => request(step(meetingId, version, stepId, 'undo'), 'POST', { expect, opId }),
    /** Explore further on one plan, only on the user's click. → { run, replayed } */
    exploreFurther: (meetingId, version, planId, { opId }) =>
      request(`${plans(meetingId)}/${encodeURIComponent(version)}/plans/${encodeURIComponent(planId)}/explore`, 'POST', { opId }),
    /** The project setting "Plan after the notes" (off by default), as the meeting detail's project has it. */
    planAfterNotes: project => Boolean(project?.planAfterNotes),
    /** → the project as saved. */
    setPlanAfterNotes: (projectId, on) => request(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', { planAfterNotes: Boolean(on) }),
  };
}

/** The real API, or with ?plans-fixture=<state> in the URL the fixture API (development only; nothing turns it on by itself). */
export async function choosePlansApi(ctx, search = location.search) {
  const name = new URLSearchParams(search).get('plans-fixture');
  if (name === null) return realPlansApi(ctx);
  const { fixturePlansApi } = await import('/plans-fixtures.js');
  const api = fixturePlansApi(name || 'plans', ctx);
  // The setting stays in the fixture: the server's project is never changed from a fixture page.
  const saved = new Map();
  return { ...api, planAfterNotes: project => saved.has(project?.id) ? saved.get(project.id) : Boolean(project?.planAfterNotes),
    setPlanAfterNotes: async (projectId, on) => { const project = await api.setPlanAfterNotes(projectId, on); saved.set(projectId, project.planAfterNotes); return project; } };
}

// ---------- Words ----------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
/** "today 14:20", "Oct 9, 14:20". */
export function wallClock(ms) {
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? `today ${clock(ms)}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock(ms)}`;
}
/** "3 pages read · 1 check run": zero counts are left out. */
function progressWords(p = {}) {
  return [p.files ? `${plural(p.files, 'file')} read` : '', p.pages ? `${plural(p.pages, 'page')} read` : '', p.checks ? `${plural(p.checks, 'check')} run` : '']
    .filter(Boolean).map(w => ` · ${w}`).join('');
}
const sentence = text => `${String(text ?? '').trim().replace(/[.!?]+$/, '')}.`;
/** What a waiting run waits for, as the server says it; the quota's end in this page's clock. */
function waitingWords(waiting) {
  if (waiting?.until) return `Waiting for the model’s quota, until about ${clock(waiting.until)}.`;
  return sentence(waiting?.reason ?? 'Waiting to start');
}
const PROJECT_CODES = new Set(['no project', 'other project']);
const FLAG = { unchecked: 'Unchecked', 'too long': 'Too long to add' };

// ---------- The model: what each plan's row and details show (all of it from the server) ----------

const nextStep = plan => plan.steps.find(s => s.kind === 'next') ?? null;
const follows = plan => plan.steps.filter(s => s.kind === 'follow');
/** An answer counts as an answer only when every source it rests on checked out. */
function answerPrefix(answer) { return answer.check !== 'checked' ? 'Unchecked:' : answer.complete ? 'Answer:' : 'So far:'; }
/** The plan's evidence (its own items and every id its answer and steps rest on), split into what checked out and what did not. */
function evidenceOf(plan, doc) {
  const items = plan.evidence.map(id => doc.evidence[id] ?? { id, kind: 'state', text: `Unknown source ${id}`, source: null, result: { ok: false, reason: 'not in the evidence registry' } });
  return { good: items.filter(e => e.result.ok), failed: items.filter(e => !e.result.ok) };
}
/** The plan's other review items (not evidence): a dropped reference, a step without text, an estimate over 20 min; and row texts. */
function diagnostics(plan, doc) {
  return [...plan.review.filter(r => !doc.evidence[r.item]).map(r => `${r.item === 'from' ? 'References' : r.item === 'further' ? 'Explore further' : r.item}: ${r.reason}.`),
    ...plan.rowFlags.map(f => `Row text: ${f}.`)];
}
function sourceLabel(e) {
  const s = e.source;
  if (!s) return '';
  if (s.type === 'file') return `${s.root ? `${s.root}/` : ''}${s.path}:${e.result.line ?? s.line ?? '?'}${e.result.page ? ` (p. ${e.result.page})` : ''}`;
  if (s.type === 'transcript') return stamp(s.startMs ?? 0);
  if (s.type === 'web') { try { const u = new URL(s.url); return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`; } catch { return s.url; } }
  return '';
}
/** Explore further: ready within 20 minutes (or without an estimate) has its button; over 20 or blocked is text. */
function furtherOf(plan) {
  const f = plan.further;
  if (!f) return null;
  if (f.state === 'blocked') return { kind: 'blocked', text: `${f.what ? `${sentence(f.what).slice(0, -1)} ` : ''}(${f.why || 'it waits for someone'})` };
  if (f.minutes !== null && f.minutes > 20) return { kind: 'over', text: `${f.what ? `${sentence(f.what).slice(0, -1)}, ` : ''}estimated at ${f.minutes} min, more than the 20-minute limit` };
  return { kind: 'ready', estimate: f.minutes ? `about ${f.minutes} min · stops at 20` : 'stops at 20 min', what: f.what };
}

// ---------- Markdown (Download) ----------

/** The plans as Markdown: the question, the answer and steps in full, their sources, what needs review and what was not planned. */
export function plansMarkdown(doc, { title = 'Meeting', project = null, notesAt = null } = {}) {
  const lines = [`# Plans — ${title}`, ''];
  lines.push(`${doc.version ? `Version ${doc.version} · ` : 'Kept plans (not a version) · '}made ${new Date(doc.at).toLocaleString()}. ${TRUST}`, '');
  for (const w of doc.warnings) lines.push(`> ${w}`, '');
  if (doc.freshness) lines.push(`_${doc.freshness.label}${doc.freshness.changed.includes('notes') && notesAt ? ` (${new Date(notesAt).toLocaleString()})` : ''}._`, '');
  if (doc.message) lines.push(doc.message, '');
  const todoWords = step => step.todo?.state === 'in to-dos' ? ` _(in to-dos, ${step.todo.todo})_` : step.todo?.state === 'already in to-dos' ? ` _(already in to-dos, ${step.todo.todo})_` : '';
  const unchecked = step => step.check === 'unchecked' ? ' _(unchecked: a source it rests on did not check out)_' : '';
  doc.plans.forEach((plan, i) => {
    lines.push(`## ${i + 1}. ${plan.label}`, '', `**Question:** ${plan.question}`, '');
    if (plan.owner) lines.push(`**For:** ${plan.owner}`, '');
    if (plan.freshness.label && !doc.freshness) lines.push(`_${plan.freshness.label}._`, '');
    if (plan.origin.kind === 'explore') lines.push(`_Revised by Explore further, ${new Date(plan.origin.at).toLocaleString()}._`, '');
    if (plan.answer) {
      const head = plan.answer.check !== 'checked' ? 'Answer (unchecked)' : plan.answer.complete ? 'Answer' : 'So far';
      lines.push(`**${head}:** ${plan.answer.text}`, '');
      if (plan.answer.open) lines.push(`**Still open:** ${plan.answer.open}`, '');
    }
    const next = nextStep(plan);
    if (next) lines.push(`**Next:** ${next.text}${unchecked(next)}${todoWords(next)}`, '');
    const then = follows(plan);
    if (then.length) lines.push('**Then:**', ...then.map(f => `- If ${f.if}: ${f.text}${unchecked(f)}${todoWords(f)}`), '');
    if (plan.waitingOn.length) lines.push(`**Waiting on:** ${plan.waitingOn.join('; ')}`, '');
    if (plan.decideAfter.length) lines.push(`**Decide after:** ${plan.decideAfter.join('; ')}`, '');
    const further = furtherOf(plan);
    if (further?.kind === 'ready') lines.push(`**Explore further:** ${further.estimate}${further.what ? ` — ${further.what}` : ''}`, '');
    else if (further) lines.push(`**Explore further:** ${further.text}`, '');
    const { good, failed } = evidenceOf(plan, doc);
    if (good.length) {
      lines.push('**Sources:**');
      for (const e of good) {
        if (e.kind === 'check') lines.push(`- Quick check (run ${e.pythonRun}): ${e.text}`, '', '```python', e.result.script ?? '', '```', '', '```', e.result.output ?? '', '```');
        else lines.push(`- ${e.text} — ${e.source?.type === 'web' ? e.source.url : e.source?.type === 'transcript' ? `transcript ${sourceLabel(e)}` : sourceLabel(e)}: “${e.source?.quote ?? ''}”${e.result.changed ? ' (changed since it was read)' : ''}`);
      }
      lines.push('');
    }
    const notes = diagnostics(plan, doc);
    if (failed.length || notes.length) lines.push('**Needs review:**', ...failed.map(e => `- ${e.source?.quote ? `“${e.source.quote}”` : e.text} — ${e.result.reason ?? 'did not check out'}`), ...notes.map(n => `- ${n}`), '');
    lines.push(`From the notes: ${plan.from.join(', ')}.${plan.changeIf ? ` Would change the plan: ${plan.changeIf}` : ''}`, '');
  });
  if (doc.dropped.length || doc.review.length) lines.push('## Needs review', ...doc.dropped.map(d => `- “${d.question || `Plan ${d.plan}`}”: left out because ${d.reason}.`), ...doc.review.map(r => `- ${r}`), '');
  if (doc.deferred.length || doc.notCovered.length) {
    lines.push('## Not planned', ...doc.deferred.map(d => `- ${d.text ?? d.item} (${d.item}) — ${d.why}`), ...doc.notCovered.map(d => `- ${d.text} (${d.item}) — not covered by any plan`), '');
  }
  if (project) lines.push(`_Project: ${project.name}._`, '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---------- The view ----------

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** Names a control for focus across renders; text that replaces a focused control can take the focus too (tabindex -1). */
const focusKey = (node, key) => {
  node.dataset.focus = key;
  if (node.tagName !== 'BUTTON' && node.tagName !== 'A') node.tabIndex = -1;
  return node;
};
function button(text, className, key, onClick) {
  const b = focusKey(el('button', text, className), key);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}
const CHEVRON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

/**
 * The Plans tab's content in `host`. hooks: meetingId(), meetingTitle(), showLine(owner, segmentId), visible(), log(message, error).
 * Local state (open rows, the fold, pending adds, operation ids) lives here; the plans themselves always come from the API.
 * Every mutation belongs to the meeting shown when it started: `epoch` changes with the meeting, and a late reply of another
 * meeting's mutation changes nothing here.
 */
export function createPlansView({ host, api, hooks, optionsHost, optionsInHead = () => false }) {
  const v = {
    owner: null, data: null, signature: null, sequence: 0, epoch: 0, busy: false, timer: 0,
    open: new Set(), quotes: new Set(), more: false, aside: false, review: false, earlier: new Set(), showKept: null,
    adding: new Set(), ops: new Map(), failed: new Map(), undo: new Map(), notice: null, menu: false, menuOpener: 'options',
  };
  const content = el('div', undefined, 'plans-content');
  const live = el('p', undefined, 'visually-hidden');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  host.replaceChildren(content, live);
  // Controls are rendered once, either in the panel head or the supplied wide-layout slot.
  const findControl = selector => content.querySelector(selector) ?? optionsHost?.querySelector(selector);
  const announce = text => { const epoch = v.epoch; live.textContent = ''; requestAnimationFrame(() => { if (epoch === v.epoch) live.textContent = text; }); };
  /** One operation id per attempt, kept until its outcome is known (a retry after a lost reply reuses it). */
  const opId = key => { if (!v.ops.has(key)) v.ops.set(key, { id: crypto.randomUUID(), at: Date.now() }); return v.ops.get(key).id; };
  /** Whether a reply arrived (a refusal is an outcome; a lost reply or a server failure is not, and keeps the id). */
  const answered = error => typeof error?.status === 'number' && error.status >= 400 && error.status < 500;

  function reset() {
    v.sequence++;
    v.epoch++;
    Object.assign(v, { owner: null, data: null, signature: null, busy: false, more: false, aside: false, review: false, showKept: null, notice: null, menu: false });
    for (const set of [v.open, v.quotes, v.earlier, v.adding]) set.clear();
    for (const map of [v.ops, v.failed, v.undo]) map.clear();
    clearTimeout(v.timer);
    content.replaceChildren();
    optionsHost?.replaceChildren();
    host.hidden = true;
  }

  async function refresh(force = false) {
    const owner = hooks.meetingId();
    if (!owner) { reset(); return; }
    if (v.busy && !force) return;
    v.busy = true;
    const sequence = ++v.sequence;
    try {
      const data = await api.getPlans(owner);
      const submissions = await Promise.all([...v.ops].filter(([key]) => key.startsWith('plan:') || key.startsWith('explore:'))
        .map(async ([key, o]) => ({ key, o, run: (await api.getSubmission(owner, o.id)).run })));
      if (sequence !== v.sequence || owner !== hooks.meetingId()) return;
      const signature = JSON.stringify(data);
      // Compare with what is actually shown, including authoritative mutation replies applied locally.
      const changed = v.owner !== owner || signature !== JSON.stringify(v.data);
      const withoutProgress = value => JSON.stringify(value ? { ...value, run: value.run ? { ...value.run, progress: null } : null } : null);
      const progressOnly = changed && v.owner === owner && withoutProgress(data) === withoutProgress(v.data);
      // Equal snapshots retain the objects captured by the existing controls' handlers.
      if (changed) v.data = data;
      v.owner = owner; v.signature = signature; v.lastError = null;
      // A Plan or Explore further whose reply was lost: once its run has ended, the next click is a new attempt.
      for (const { key, o, run } of submissions) {
        if (v.ops.get(key) === o && run && !ACTIVE.has(run.state)) v.ops.delete(key);
      }
      // Eligibility refusals are now explained by the authoritative slots/banner, not repeated as another warning.
      const clearRefusal = Boolean(v.notice?.refusal);
      if (clearRefusal || (changed && v.notice && Date.now() - v.notice.at > 2000)) v.notice = null;
      if (progressOnly && !clearRefusal && content.querySelector('.job-progress')) updateProgress(data.run, content.querySelector('.job-progress'));
      else if (changed || clearRefusal) render();
    } catch (error) {
      // A server without the plans routes (404) shows no section; any other error is logged once, not on every poll.
      if (sequence === v.sequence && error.status === 404) { v.data = null; v.signature = null; render(); }
      else if (sequence === v.sequence && v.lastError !== error.message) hooks.log(`Could not load the plans: ${error.message}`, true);
      if (sequence === v.sequence) v.lastError = error.message;
    } finally {
      if (sequence === v.sequence) {
        v.busy = false;
        // A run in progress is followed closely; otherwise the Plans tab's polling calls refresh.
        clearTimeout(v.timer);
        if (ACTIVE.has(v.data?.run?.state) && hooks.visible()) v.timer = setTimeout(() => void refresh(), 1500);
      }
    }
  }

  /** Runs an action from a control: one at a time per control; an error is announced, logged and shown above the plans. */
  const act = (control, fn) => async () => {
    if (control.dataset.running) return;
    const epoch = v.epoch;
    v.notice = null;
    control.dataset.running = '1';
    control.setAttribute('aria-busy', 'true');
    try { await fn(epoch); }
    catch (error) {
      if (epoch !== v.epoch) return;
      hooks.log(error.message, true);
      v.notice = { kind: 'warn', text: error.message, at: Date.now() };
      announce(error.message);
      render();
      if (answered(error)) void refresh(true);
    } finally { delete control.dataset.running; control.removeAttribute('aria-busy'); }
  };

  // ---------- Actions ----------

  async function submissionOp(key, owner, epoch) {
    const old = v.ops.get(key);
    if (old) {
      const { run } = await api.getSubmission(owner, old.id);
      if (epoch !== v.epoch) return null;
      if (run && !ACTIVE.has(run.state) && v.ops.get(key) === old) v.ops.delete(key);
    }
    return opId(key);
  }
  async function startPlan(epoch) {
    const owner = v.owner, key = `plan:${v.data?.current?.version ?? 0}`;
    try {
      const id = await submissionOp(key, owner, epoch);
      if (!id) return;
      const result = await api.startPlan(owner, { opId: id });
      if (epoch !== v.epoch) return;
      v.ops.delete(key);
      v.showKept = null;
      await refresh(true);
      if (epoch !== v.epoch) return;
      announce(result.replayed && !ACTIVE.has(result.run.state) ? 'That plan run has already ended.' : 'Planning started.');
    } catch (error) { if (epoch === v.epoch && answered(error)) v.ops.delete(key); throw error; }
  }
  async function cancelRun(epoch, run) {
    await api.cancel(v.owner, run.id);
    if (epoch !== v.epoch) return;
    await refresh(true);
    if (epoch !== v.epoch) return;
    announce(run.kind === 'explore' ? 'Explore further cancelled.' : 'Planning cancelled.');
  }
  async function explore(epoch, doc, plan) {
    const owner = v.owner, key = `explore:${doc.version}:${plan.id}`;
    try {
      const id = await submissionOp(key, owner, epoch);
      if (!id) return;
      const result = await api.exploreFurther(owner, doc.version, plan.id, { opId: id });
      if (epoch !== v.epoch) return;
      v.ops.delete(key);
      await refresh(true);
      if (epoch !== v.epoch) return;
      announce(result.replayed && !ACTIVE.has(result.run.state) ? `Explore further on “${plan.label}” has already ended.` : `Explore further started on “${plan.label}”.`);
    } catch (error) { if (epoch === v.epoch && answered(error)) v.ops.delete(key); throw error; }
  }
  /**
   * Add to to-dos: the generation the page saw and one operation id per attempt (kept for a retry after a lost reply). The reply
   * says what this operation did and the step's state now; the page shows the state now (a replayed old result may have been
   * undone since), and offers Undo only for a to-do this page just made.
   */
  async function addTodo(doc, plan, step) {
    const key = `${doc.version}:${step.id}`;
    if (v.adding.has(key)) return;
    const epoch = v.epoch;
    const pending = [...v.ops.keys()].find(k => k.startsWith(`todo:${key}:`));
    const expect = pending ? Number(pending.split(':').at(-1)) : step.todo.generation;
    const op = pending ?? `todo:${key}:${expect}`;
    v.adding.add(key); v.failed.delete(key); v.notice = null;
    render();
    try {
      const { result, todo } = await api.addTodo(v.owner, doc.version, step.id, { expect, opId: opId(op) });
      if (epoch !== v.epoch) return;
      v.ops.delete(op);
      step.todo = todo; // shown at once; the next load confirms it
      if (todo.state === 'in to-dos' && result.created && !result.replayed) v.undo.set(key, { until: Date.now() + UNDO_MS, generation: todo.generation });
      announce(todo.state === 'in to-dos' ? `Added to the project’s to-dos${plan.owner ? `, for ${plan.owner}` : ''}.`
        : todo.state === 'already in to-dos' ? `Already in to-dos (${todo.todo}).` : 'It was added and then undone; it is not in the to-dos now.');
      setTimeout(() => { if (epoch === v.epoch) render(); }, UNDO_MS + 50);
    } catch (error) {
      if (epoch !== v.epoch) return;
      if (answered(error)) v.ops.delete(op);
      // A refusal is shown by the step's state (the next load); a stale page gets the state now at once.
      if (error.code === 'generation' && error.current) step.todo = error.current;
      if (!answered(error)) v.failed.set(key, error.message);
      else v.notice = { kind: 'warn', text: error.message, at: Date.now(), refusal: PROJECT_CODES.has(error.code) || Boolean(FLAG[error.code]) };
      announce(`Not added: ${error.message}`);
      hooks.log(error.message, true);
    } finally {
      if (epoch === v.epoch) {
        v.adding.delete(key);
        render();
        await refresh(true);
      }
    }
  }
  async function undoTodo(epoch, doc, step) {
    const key = `${doc.version}:${step.id}`;
    const u = v.undo.get(key);
    if (!u) return;
    const op = `undo:${key}:${u.generation}`;
    try {
      const { todo } = await api.undoTodo(v.owner, doc.version, step.id, { expect: u.generation, opId: opId(op) });
      if (epoch !== v.epoch) return;
      v.ops.delete(op);
      v.undo.delete(key);
      step.todo = todo;
      render();
      await refresh(true);
      if (epoch !== v.epoch) return;
      announce(todo.state === 'in to-dos' || todo.state === 'already in to-dos' ? 'That to-do was removed; the step has since been added again.' : 'Removed from the to-dos.');
    } catch (error) {
      if (epoch === v.epoch && answered(error)) { v.ops.delete(op); v.undo.delete(key); }
      throw error;
    }
  }
  function download(doc) {
    const md = plansMarkdown(doc, { title: hooks.meetingTitle(), project: v.data.project, notesAt: v.data.notes?.at ?? null });
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = el('a');
    a.href = url;
    a.download = `${(hooks.meetingTitle() || 'meeting').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'meeting'}-plans${doc.version ? `-v${doc.version}` : '-kept'}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    announce('Plans downloaded as Markdown.');
  }

  // ---------- Rendering ----------

  function render() {
    const data = v.data;
    const before = host.contains(document.activeElement) || optionsHost?.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    optionsHost?.replaceChildren();
    if (!data) { host.hidden = true; return; }
    // The kept plans shown are those of one run: once they are gone (another run started or ended), the current ones show.
    if (v.showKept && data.kept?.run !== v.showKept) v.showKept = null;
    const run = data.run;
    const active = ACTIVE.has(run?.state);
    const kept = v.showKept ? data.kept : null;
    const doc = kept ?? data.current;
    host.hidden = false;
    if (!data.notes && !doc && !run) {
      content.replaceChildren(el('p', 'Plans are made from the notes. Write the notes first.', 'plans-no-notes'));
      return;
    }
    const parts = [head(doc, run, active, kept)];
    parts.push(...notices(doc, run, active, kept));
    if (!active && !doc) parts.push(idlePanel(run));
    if (doc) parts.push(...body(doc, kept));
    content.replaceChildren(...parts.filter(Boolean));
    // The focus stays where it was; when that control is gone (a step that can no longer be added), on its plan's chevron.
    if (before) {
      const plan = /(?:^|[:.])(p\d+)(?=[.:]|$)/.exec(before)?.[1];
      (findControl(`[data-focus="${CSS.escape(before)}"]`) ?? (plan ? content.querySelector(`[data-focus="chev:${plan}"]`) : null))?.focus();
    }
  }

  // Only the per-plan projection determines freshness, including while viewing kept plans.
  const stalePlans = doc => (doc?.plans ?? []).filter(p => !p.freshness.current);
  const notesWarning = /^(?:Missing speech: |The transcript changed after the notes were written\.$|\d+ audio chunk\(s\) were still being transcribed when the notes were written\.$|\d+ line\(s\) had not been checked for misheard terms\.$)/;

  function closeMenu(returnFocus = false) {
    if (!v.menu) return;
    v.menu = false;
    render();
    if (returnFocus) (findControl(`[data-focus="${v.menuOpener}"]`) ?? findControl('[data-focus="options"]'))?.focus();
  }
  function openMenu(opener = 'options', last = false) {
    v.menu = true; v.menuOpener = opener;
    render();
    const items = (optionsInHead() && optionsHost ? optionsHost : content).querySelectorAll('[role="menuitem"]');
    items[last ? items.length - 1 : 0]?.focus();
  }
  function toggleMenu(opener) { if (v.menu && v.menuOpener === opener) closeMenu(true); else openMenu(opener); }
  // A toggle re-renders its own control before the click bubbles; use the original event path, not the detached target.
  document.addEventListener('click', event => { if (!event.composedPath().some(node => node.classList?.contains('plans-head') || node.classList?.contains('plans-options-wrap'))) closeMenu(); });
  document.addEventListener('focusin', event => { if (!content.querySelector('.plans-head')?.contains(event.target) && !optionsHost?.contains(event.target)) closeMenu(); });

  function head(doc, run, active, kept) {
    const replaceable = active && run.state === 'waiting' && run.kind === 'plan' && run.origin === 'auto';
    if (!doc && !replaceable) return null;
    const row = el('div', undefined, 'plans-head');
    if (stalePlans(doc).length) {
      const stale = button('Made before the notes changed', 'plans-link plans-stale', 'plans-stale', () => toggleMenu('plans-stale'));
      stale.setAttribute('aria-haspopup', 'menu');
      row.append(stale);
    }
    const tools = optionsInHead() && optionsHost ? optionsHost : row;
    const options = button('Options', 'button options-button', 'options', () => toggleMenu('options'));
    options.insertAdjacentHTML('beforeend', '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
    options.setAttribute('aria-haspopup', 'menu');
    options.setAttribute('aria-expanded', String(v.menu));
    options.setAttribute('aria-controls', 'plans-menu');
    options.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openMenu('options', event.key === 'ArrowUp'); }
    };
    tools.append(options);
    if (!v.menu) return row.children.length ? row : null;
    const menu = el('div', undefined, 'menu notes-menu plans-menu');
    menu.id = 'plans-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Plans options');
    const again = button('Plan again', 'menu-item', 'plan-again', null);
    again.setAttribute('role', 'menuitem'); again.tabIndex = -1;
    again.setAttribute('aria-disabled', String(!v.data.enabled || (active && !replaceable)));
    if (replaceable) again.setAttribute('aria-label', 'Plan now, in place of the automatic plan run that waits');
    again.onclick = act(again, async epoch => {
      if (again.getAttribute('aria-disabled') === 'true') return;
      closeMenu(true); await startPlan(epoch);
    });
    menu.append(again);
    if (doc) {
      const dl = button('Download (.md)', 'menu-item', 'download', () => { closeMenu(true); download(doc); });
      dl.setAttribute('role', 'menuitem'); dl.tabIndex = -1;
      menu.append(dl);
      const about = el('div', undefined, 'notes-about');
      about.setAttribute('role', 'note');
      about.setAttribute('aria-label', 'Plans details');
      about.append(el('p', `Made at ${new Date(doc.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}.`, 'notes-warning'));
      if (stalePlans(doc).length) {
        about.append(el('p', 'Made before the notes changed.', 'notes-warning'));
        for (const label of new Set(stalePlans(doc).map(p => p.freshness.label).filter(Boolean))) {
          if (sentence(label) !== 'Made before the notes changed.') about.append(el('p', sentence(label), 'notes-warning'));
        }
      }
      about.append(el('p', 'Sources are checked, not the ideas themselves.', 'notes-warning'));
      for (const w of doc.warnings) if (!notesWarning.test(w)) about.append(el('p', w, 'notes-warning'));
      menu.append(about);
    }
    menu.onkeydown = event => {
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    tools.append(menu);
    return row.children.length ? row : null;
  }

  function banner(text, kind = 'warn', extra = []) {
    const box = el('div', undefined, `plans-banner ${kind}`);
    box.append(el('span', text), ...extra);
    return box;
  }

  function updateProgress(run, existing = null) {
    const card = progressCard(run.kind === 'explore' ? 'explore' : 'plans', { phase: 'notes', startedAt: run.startedAt ?? run.createdAt, ...run.progress }, () => cancelRun(v.epoch, run).catch(error => hooks.log(error.message, true)), existing);
    card.classList.add('plans-status');
    return card;
  }

  function notices(doc, run, active, kept) {
    const out = [];
    const current = v.data.current;
    if (active && run.state === 'running') out.push(updateProgress(run));
    else if (active) {
      const line = el('div', undefined, `plans-status${run.state === 'waiting' ? ' waiting' : ''}`);
      line.setAttribute('role', 'status');
      let text;
      if (run.state === 'waiting') {
        const what = run.kind === 'explore' ? `Explore further on “${run.label}”: ` : run.origin === 'auto' ? 'Planning after the notes: ' : '';
        const words = waitingWords(run.waiting);
        text = what ? `${what}${words[0].toLowerCase()}${words.slice(1)}` : words;
      } else if (run.kind === 'explore') text = `Exploring “${run.label}”${progressWords(run.progress)} · the plan updates when it is done`;
      else text = `${current ? 'Planning again' : 'Planning'}${progressWords(run.progress)}${current ? '. The plans below stay until the new ones are ready.' : ''}`;
      const cancel = button('Cancel', 'plans-link', 'cancel', null);
      cancel.setAttribute('aria-label', run.kind === 'explore' ? 'Cancel Explore further' : 'Cancel planning');
      cancel.onclick = act(cancel, epoch => cancelRun(epoch, run));
      line.append(el('span', text), cancel);
      out.push(line);
    } else if (run) {
      const when = current ? ` The plans below are the ones from ${wallClock(current.at)}.` : '';
      const stopWhy = run.state === 'interrupted' || run.stopped === 'quit' || run.stopped === 'crash' ? 'when HearAlong closed'
        : run.stopped === 'time limit' ? `at the ${run.limitMinutes}-minute limit` : run.stopped === 'quota' ? 'to leave the model’s quota to the recording' : '';
      const error = sentence(run.error ?? 'an error').slice(0, -1);
      if (run.state === 'cancelled') out.push(banner(`Stopped before the end. ${run.kind === 'explore'
        ? `Explore further on “${run.label}” was stopped; the plan is unchanged.` : `No new plans were published.${when}`} What it read and checked is kept with the run.`));
      else if (run.kind === 'explore') {
        out.push(banner(run.outcome === 'refused' ? `Explore further on “${run.label}”: ${sentence(run.message)}`
          : run.state === 'failed' ? `Explore further on “${run.label}” did not finish: ${error}. The plan is unchanged.`
          : `Explore further on “${run.label}” stopped ${stopWhy || 'before the end'}; the plan is unchanged, and what it found is kept with the run.`));
      } else if (run.outcome === 'refused') out.push(banner(`${sentence(run.message)}${when}`));
      else if (run.state === 'failed') out.push(banner(`${current ? 'Planning again' : 'Planning'} did not finish: ${error}.${when}`));
      else out.push(banner(current ? `Planning again stopped before the end, ${stopWhy || 'early'}.${when}`
        : `Stopped before the end${stopWhy ? `, ${stopWhy}` : ''}, before the plans were written. What it read and checked is kept with the run; no plans come from it.`));
    }
    if (v.data.kept && !kept) {
      const k = v.data.kept, n = k.newest;
      const what = k.kind === 'explore' ? 'Explore further' : 'Planning again';
      const show = button('Show the kept plans', 'plans-link', 'show-kept', () => { v.showKept = k.run; v.open.clear(); render(); });
      out.push(banner(`${what} finished after a newer version appeared${n ? ` (${n.kind === 'explore' ? 'Explore further' : 'another plan pass'}, ${wallClock(n.at)})` : ''}, so its plans were kept aside. The newer version is shown.`, 'quiet', [show]));
    }
    if (kept) {
      const back = button('Back to the current plans', 'plans-link', 'hide-kept', () => { v.showKept = null; v.open.clear(); render(); });
      out.push(banner(`These are the kept plans from ${wallClock(kept.finishedAt)}. They are not a version of the plans, so their steps cannot be added to to-dos; Plan again makes a new one.`, 'quiet', [back]));
    }
    if (v.notice) out.push(banner(v.notice.text, v.notice.kind));
    if (!doc) return out;
    // Document warnings live in Options, not above the rows. Markdown keeps every warning.
    if (doc.addable && !kept) {
      const made = doc.addable.madeIn?.name ?? 'another project';
      if (doc.addable.code === 'no project') out.push(banner('Put this meeting in a project (meeting menu) to add steps to its to-dos.', 'quiet'));
      else out.push(banner(`These plans were made in “${made}”; the meeting is now in “${v.data.project?.name ?? 'another project'}”. Plan again to add steps to its to-dos. To-dos already added stay in “${made}”.`, 'quiet'));
    }
    return out;
  }

  function idlePanel(run) {
    const box = el('div', undefined, 'plans-idle');
    if (!v.data.enabled) { box.append(el('span', 'Planning needs the AI models, which are off (see Settings).')); return box; }
    const counts = hooks.noteCounts?.();
    const topics = counts ? [counts.questions ? plural(counts.questions, 'open question') : '', counts.actions ? plural(counts.actions, 'action') : ''].filter(Boolean).join(' and ') : '';
    box.append(el('span', `Answers and next steps for ${topics ? `the ${topics}` : 'the open questions and actions'} in the notes. About 2 minutes.`));
    const plan = button(run && run.state !== 'cancelled' ? 'Plan again' : 'Plan', 'button primary plans-primary', 'plan', null);
    plan.onclick = act(plan, epoch => startPlan(epoch));
    box.append(plan);
    return box;
  }

  function body(doc, kept) {
    const out = [];
    if (doc.status === 'nothing to plan') out.push(el('div', 'The notes leave no open decision to plan. Every action item already has a clear next step.', 'plans-panel'));
    if (doc.status === 'all plans failed checks') {
      const box = el('div', undefined, 'plans-panel');
      box.append(el('p', `No plan passed the source checks, so none is shown as a plan. What failed is under Needs review. Plan again may do better.`));
      out.push(box);
    }
    if (doc.status === 'plans' && doc.plans.length) {
      const list = el('div', undefined, 'plans-list');
      const shown = v.more ? doc.plans : doc.plans.slice(0, SHOWN);
      list.append(...shown.map(p => planRow(doc, p, kept)));
      if (doc.plans.length > SHOWN) {
        const more = button(v.more ? 'Show fewer' : `${doc.plans.length - SHOWN} more`, 'plans-toggle', 'more', () => { v.more = !v.more; render(); });
        more.setAttribute('aria-expanded', String(v.more));
        const wrap = el('div', undefined, 'plans-more');
        wrap.append(more);
        list.append(wrap);
      }
      out.push(list);
    }
    // What the checks left out, and the answer's own diagnostics: one disclosure, closed until asked for.
    const reviewItems = [...doc.dropped.map(d => textBlock(`“${d.question || `Plan ${d.plan}`}”`, `left out because ${d.reason}.`)), ...doc.review.map(r => el('span', r))];
    if (reviewItems.length) out.push(disclosure('review', `Needs review (${reviewItems.length})`, () => reviewItems));
    const asideItems = [...doc.deferred.map(d => textBlock(d.text ?? d.item, `${sentence(d.why)} (${d.item})`)),
      ...doc.notCovered.map(d => textBlock(d.text, `not covered by any plan (${d.item}).`))];
    if (asideItems.length) out.push(disclosure('aside', `Not planned (${asideItems.length})`, () => asideItems));
    // Rows and their folds share one surface, like the Notes sections and folds.
    const card = el('div', undefined, 'plans-card');
    card.append(...out);
    return [card];
  }

  function textBlock(strong, rest) {
    const line = el('span');
    line.append(el('b', strong), ` — ${rest}`);
    return line;
  }
  function disclosure(key, label, items) {
    const box = el('div', undefined, 'plans-aside');
    const open = v[key];
    const toggle = button(label, 'plans-aside-toggle', key, () => { v[key] = !v[key]; render(); });
    toggle.setAttribute('aria-expanded', String(open));
    box.append(toggle);
    if (open) {
      const list = el('div', undefined, 'plans-aside-list');
      list.append(...items());
      box.append(list);
    }
    return box;
  }

  /** Whether a step gets a slot: Add, In to-dos, Already in to-dos, or why not (unchecked, too long). A project's refusal is said once above. */
  const hasSlot = step => Boolean(step?.todo) && !(step.todo.state === 'not eligible' && PROJECT_CODES.has(step.todo.code));
  /** The control in a step's slot: Add to to-dos, In to-dos (with Undo for a moment), Already in to-dos, or why not. */
  function slot(doc, plan, step, where) {
    const box = el('div', undefined, 'plan-slot');
    const key = `${doc.version}:${step.id}`;
    const fk = `slot:${where}:${key}`;
    const t = step.todo;
    if (t.state === 'in to-dos') {
      const done = el('span', 'In to-dos', 'plan-done');
      box.append(done);
      const u = v.undo.get(key);
      if (u && u.generation === t.generation && (u.until > Date.now() || v.ops.has(`undo:${key}:${u.generation}`))) {
        const undo = button('Undo', 'plans-link plan-undo', fk, null);
        undo.setAttribute('aria-label', `Undo adding “${plan.label}” to the to-dos`);
        undo.onclick = act(undo, epoch => undoTodo(epoch, doc, step));
        box.append(undo);
      } else focusKey(done, fk);
      return box;
    }
    if (t.state === 'already in to-dos') {
      // The id never breaks at its hyphen: "Already in to-dos" / "(T-12)".
      const done = focusKey(el('span', 'Already in to-dos ', 'plan-done'), fk);
      done.append(el('span', `(${t.todo})`, 'nowrap'));
      box.append(done);
      return box;
    }
    if (t.state === 'not eligible') { box.append(focusKey(el('span', FLAG[t.code] ?? 'Not added', 'plan-flag'), fk)); return box; }
    // On a row it is the row's one button; on a follow-on inside the details it is a text action, like the others there.
    const failed = v.failed.has(key);
    const add = button(failed ? 'Try again' : 'Add to to-dos', where === 'row' ? 'button plan-add' : 'plans-link plan-left plan-add-link', fk, () => void addTodo(doc, plan, step));
    add.setAttribute('aria-label', `${failed ? 'Try again: add' : 'Add'} “${step.kind === 'follow' ? `If ${step.if}: ${step.text}` : plan.stepLine ?? step.text}” to the to-dos${plan.owner ? `, for ${plan.owner}` : ''}`);
    // Keep the pending control focusable: disabling it here loses the keyboard's place before Undo or text replaces it.
    if (v.adding.has(key)) { add.setAttribute('aria-disabled', 'true'); add.setAttribute('aria-busy', 'true'); }
    box.append(add);
    return box;
  }

  function planRow(doc, plan, kept) {
    const section = el('section', undefined, 'plan');
    section.setAttribute('aria-label', plan.label);
    const open = v.open.has(plan.id);
    const detailsId = `plan-details-${plan.id}`;
    const toggle = () => { if (v.open.has(plan.id)) v.open.delete(plan.id); else v.open.add(plan.id); render(); };
    const next = nextStep(plan);
    const withSlot = !kept && hasSlot(next);
    const row = el('div', undefined, `plan-row${withSlot ? '' : ' no-slot'}`);
    const text = button(undefined, 'plan-text', `text:${plan.id}`, toggle);
    text.setAttribute('aria-expanded', String(open));
    text.setAttribute('aria-controls', detailsId);
    const label = el('span', undefined, 'plan-label');
    label.append(el('span', plan.label));
    if (plan.owner) label.append(el('span', `for ${plan.owner}`, 'plan-for'));
    text.append(label);
    if (plan.answer) {
      const a = el('span', undefined, 'plan-answer');
      a.append(el('b', answerPrefix(plan.answer)), ` ${plan.answerLine ?? plan.answer.text}`);
      text.append(a);
    }
    if (next) {
      const step = el('span', undefined, 'plan-step');
      step.append(el('b', 'Next:'), ` ${plan.stepLine ?? next.text}`);
      text.append(step);
    }
    row.append(text);
    if (withSlot) row.append(slot(doc, plan, next, 'row'));
    const chev = button(undefined, 'plan-chev', `chev:${plan.id}`, toggle);
    chev.innerHTML = CHEVRON;
    chev.setAttribute('aria-expanded', String(open));
    chev.setAttribute('aria-controls', detailsId);
    chev.setAttribute('aria-label', `Details: ${plan.label}`);
    row.append(chev);
    section.append(row);
    if (open) section.append(details(doc, plan, detailsId, kept));
    return section;
  }

  function line(heading, text, className = '') {
    const p = el('p', undefined, `plan-line ${className}`.trim());
    if (heading) p.append(el('b', heading), ' ');
    p.append(text);
    return p;
  }

  function details(doc, plan, id, kept) {
    const box = el('div', undefined, 'plan-details');
    box.id = id;
    const next = nextStep(plan);
    const key = next ? `${doc.version}:${next.id}` : null;
    if (key && v.failed.has(key)) box.append(line('Could not add:', `${sentence(v.failed.get(key))} Try again.`, 'plan-warn'));
    if (next?.todo?.state === 'not eligible' && next.todo.code === 'too long') box.append(line('Not added:', next.todo.reason, 'plan-warn'));
    if (plan.origin.kind === 'explore') box.append(el('p', `Revised by Explore further, ${wallClock(plan.origin.at)}${plan.origin.minutes ? ` (${plan.origin.minutes} min)` : ''}.`, 'plan-line plan-muted'));
    box.append(line('The question:', plan.question));
    if (plan.answer) {
      const heading = plan.answer.check !== 'checked' ? 'Unchecked answer:' : plan.answer.complete ? 'The answer:' : 'So far, in full:';
      box.append(line(heading, plan.answer.text));
      if (plan.answer.check !== 'checked') box.append(el('p', `A source this answer rests on did not check out${plan.answer.reason ? ` (${plan.answer.reason})` : ''}, so it is not shown as an answer.`, 'plan-line plan-warn'));
      if (plan.answer.open) box.append(line('Still open:', plan.answer.open));
    }
    if (next) {
      box.append(line('The full step:', next.text));
      if (next.check === 'unchecked') box.append(el('p', 'Unchecked: a source this step rests on did not check out, so it cannot become a to-do.', 'plan-line plan-warn'));
    }
    const then = follows(plan);
    if (then.length) {
      box.append(el('span', 'Then', 'plan-sub'));
      const list = el('div', undefined, 'plan-then');
      for (const f of then) {
        const item = el('div', undefined, 'plan-follow');
        item.append(el('span', `If ${f.if}: ${sentence(f.text)}`));
        if (!kept && hasSlot(f)) item.append(slot(doc, plan, f, 'follow'));
        list.append(item);
      }
      box.append(list);
    }
    if (plan.waitingOn.length) box.append(line('Waiting on:', plan.waitingOn.join('; ')));
    if (plan.decideAfter.length) box.append(line('Decide after:', plan.decideAfter.join('; ')));
    const run = v.data.run;
    const exploring = ACTIVE.has(run?.state) && run.kind === 'explore' && run.plan === plan.id;
    const further = furtherOf(plan);
    if (exploring) box.append(el('p', 'Exploring now; the status is above the plans.', 'plan-line plan-muted'));
    else if (further?.kind === 'ready' && !kept && doc.version != null && v.data.enabled) {
      const wrap = el('div', undefined, 'plan-explore');
      const go = button('Explore further', 'plans-link', `explore:${plan.id}`, null);
      go.setAttribute('aria-label', `Explore further: ${plan.label}, ${further.estimate.replace(' · ', ', ')}`);
      go.disabled = ACTIVE.has(run?.state);
      if (go.disabled) go.title = 'One plan pass or exploration at a time; this one can start when the current one is done.';
      go.onclick = act(go, epoch => explore(epoch, doc, plan));
      wrap.append(go, el('span', further.estimate, 'plan-muted'));
      box.append(wrap);
      if (further.what) box.append(el('p', further.what, 'plan-line plan-muted'));
    } else if (further && further.kind !== 'ready') box.append(line('Explore further:', further.text));
    const { good, failed } = evidenceOf(plan, doc);
    const states = good.filter(e => e.kind !== 'check'), checks = good.filter(e => e.kind === 'check');
    if (states.length) {
      box.append(el('span', 'State now', 'plan-sub'));
      const list = el('div', undefined, 'plan-sources');
      list.append(...states.map(e => source(plan, e)));
      box.append(list);
    }
    for (const c of checks) {
      box.append(el('span', 'Quick check', 'plan-sub'), el('p', c.text, 'plan-line'));
      const k = `${plan.id}:${c.id}`;
      const open = v.quotes.has(k);
      const t = button(open ? 'Hide the script and its output' : 'Show the script and its output', 'plans-link plan-left', `script:${k}`, () => { if (open) v.quotes.delete(k); else v.quotes.add(k); render(); });
      t.setAttribute('aria-expanded', String(open));
      box.append(t);
      if (open) box.append(el('pre', c.result.script ?? '', 'plan-code'), el('pre', c.result.output ?? '', 'plan-code plan-output'));
    }
    const notes = diagnostics(plan, doc);
    if (failed.length || notes.length) {
      const review = el('div', undefined, 'plan-review');
      review.append(el('b', 'Needs review'));
      for (const e of failed) {
        const what = e.kind === 'check' ? `Quick check ${e.pythonRun ?? ''}`.trim() : e.source?.quote ? `“${e.source.quote}”` : e.text;
        review.append(el('p', `${what}${e.source ? ` (${e.source.type === 'transcript' ? 'transcript' : sourceLabel(e)})` : ''}: ${e.result.reason ?? 'did not check out'}.`, 'plan-line'));
      }
      for (const n of notes) review.append(el('p', n, 'plan-line'));
      box.append(review);
    }
    box.append(el('p', `From the notes: ${plan.from.join(', ')}.${plan.changeIf ? ` Would change the plan: ${plan.changeIf}` : ''}`, 'plan-line plan-muted'));
    if (plan.earlier) {
      const k = `${plan.id}:earlier`;
      const open = v.earlier.has(k);
      const t = button('Earlier version', 'plans-toggle plan-left', `earlier:${plan.id}`, () => { if (open) v.earlier.delete(k); else v.earlier.add(k); render(); });
      t.setAttribute('aria-expanded', String(open));
      box.append(t);
      const was = plan.earlier.stepLine ? `Next: ${sentence(plan.earlier.stepLine)}` : plan.earlier.answerLine ? `Answer: ${sentence(plan.earlier.answerLine)}` : '';
      if (open) box.append(el('p', `Version ${plan.earlier.version}, ${wallClock(plan.earlier.at)} — ${was} A to-do already added from it keeps its own text.`, 'plan-line plan-earlier'));
    }
    return box;
  }

  /** One "state now" item: what it states, and its source, which opens its quoted line. */
  function source(plan, e) {
    const item = el('div', undefined, 'plan-source');
    item.append(el('span', e.text));
    const k = `${plan.id}:${e.id}`;
    const open = v.quotes.has(k);
    const where = e.source?.type === 'transcript' ? `Transcript ${sourceLabel(e)}` : sourceLabel(e);
    const t = button(where, 'plan-cite', `src:${k}`, () => { if (open) v.quotes.delete(k); else v.quotes.add(k); render(); });
    t.setAttribute('aria-expanded', String(open));
    t.setAttribute('aria-label', `${where}: ${open ? 'hide' : 'show'} the quoted words`);
    item.append(t);
    if (open) {
      item.append(el('blockquote', `“${e.source?.quote ?? ''}”`, 'plan-quote'));
      if (e.result.changed) item.append(el('p', 'This file changed after it was read; the quote is from the version read.', 'plan-line plan-muted'));
      if (e.source?.type === 'transcript' && e.source.segmentId) {
        const go = button('Show in the transcript', 'plans-link plan-left', `line:${k}`, () => hooks.showLine(v.owner, e.source.segmentId));
        item.append(go);
      }
      if (e.source?.type === 'web') {
        const a = focusKey(el('a', 'Open the page', 'plans-link plan-left'), `url:${k}`);
        a.href = e.source.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        item.append(a);
      }
    }
    return item;
  }

  host.hidden = true;
  return { refresh, reset, render, closeMenu, get data() { return v.data; } };
}
