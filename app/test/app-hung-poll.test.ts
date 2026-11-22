// #48: a poll guarded by a busy flag must not wait forever on one stalled request (headers or body), or every later
// refresh of that part of the page stops. Each read carries a time limit; once it fires, the guard is free again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const plans = await readFile(new URL('../public/plans.js', import.meta.url), 'utf8');
const between = (code: string, from: string, to: string) => { const start = code.indexOf(from), end = code.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return code.slice(start, end); };

/** A stand-in for AbortSignal.timeout whose deadline the test fires by hand, and a request that only ends when aborted. */
function stalls() {
  const timers: { ms: number; fire(): void }[] = [];
  const AbortSignal = { timeout(ms: number) { const c = new AbortController(); timers.push({ ms, fire: () => c.abort(new Error('timed out')) }); return c.signal; } };
  const hang = (signal?: AbortSignal) => new Promise((_, reject) => {
    if (!signal) return; // no deadline: this request never ends
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { timers, AbortSignal, hang };
}

test('notes: a stalled read times out after 10 s and the next poll runs', async () => {
  const s = stalls(); const calls: any[] = [];
  const nodes: Record<string, any> = {};
  const context: Record<string, any> = { AbortSignal: s.AbortSignal, meetingId: 'meeting', notesView: { busy: false, sequence: 0 }, plansView: null, renderNotes() {},
    $: (id: string) => nodes[id] ??= {}, api: (path: string, options?: { signal?: AbortSignal }) => { calls.push(path); return s.hang(options?.signal); } };
  runInNewContext(between(app, 'async function refreshNotes()', '// ---------- Notes options'), context);
  const first = context.refreshNotes();
  assert.deepEqual(s.timers.map(t => t.ms), [10000]);
  await context.refreshNotes();
  assert.equal(calls.length, 1, 'the guard holds while the first read is out');
  s.timers[0].fire(); await first;
  assert.equal(context.notesView.busy, false);
  void context.refreshNotes();
  assert.equal(calls.length, 2, 'the next poll asks again');
});

test('call status: a stalled poll times out after 5 s, counts as no helper, and the next poll runs', async () => {
  const s = stalls(); let calls = 0;
  const context: Record<string, any> = { AbortSignal: s.AbortSignal, helperAvailable: true, helperCheckedAt: 0, capture: null,
    api: (_path: string, options?: { signal?: AbortSignal }) => { calls++; return s.hang(options?.signal); } };
  runInNewContext(between(app, 'let appCapturePolling = false;', "$('start-mic').onclick"), context);
  const first = context.pollAppCapture();
  assert.deepEqual(s.timers.map(t => t.ms), [5000]);
  await context.pollAppCapture(); assert.equal(calls, 1);
  s.timers[0].fire(); await first;
  assert.equal(context.helperAvailable, false);
  void context.pollAppCapture(); assert.equal(calls, 2);
});

test('plans: polled reads carry a 10 s limit; changes keep none', async () => {
  const s = stalls(); const signals: [string, string, AbortSignal | undefined][] = [];
  const fetch = (path: string, options: { method: string; signal?: AbortSignal }) => {
    signals.push([options.method, path, options.signal]);
    return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) });
  };
  const context: Record<string, any> = { AbortSignal: s.AbortSignal, fetch, encodeURIComponent };
  runInNewContext(between(plans, 'export function realPlansApi', '/** The real API, or with').replace('export function', 'function') + '\nthis.api = realPlansApi({ pageId: "page" });', context);
  await context.api.getPlans('meeting');
  await context.api.getSubmission('meeting', 'op-1');
  await context.api.setPlanAfterNotes('project', true);
  assert.deepEqual(signals.map(([method, , signal]) => [method, Boolean(signal)]), [['GET', true], ['GET', true], ['PATCH', false]]);
  assert.deepEqual(s.timers.map(t => t.ms), [10000, 10000]);
});

test('notes: a timed-out poll shows nothing; another error shows until the next good answer clears it', async () => {
  const nodes: Record<string, any> = {};
  let reply: () => Promise<any> = async () => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); };
  const rendered: any[] = [];
  const context: Record<string, any> = { AbortSignal, meetingId: 'meeting', notesView: { busy: false, sequence: 0, owner: 'meeting', signature: null }, plansView: null,
    renderNotes(data: any) { rendered.push(data); Object.assign(context.$('notes-status'), { hidden: true, textContent: '' }); },
    $: (id: string) => nodes[id] ??= { hidden: true, textContent: '' }, api: () => reply() };
  runInNewContext(between(app, 'async function refreshNotes()', '// ---------- Notes options'), context);
  const good = { notes: { version: 1 }, job: null, stale: false, currentUntilMs: 0, enabled: true, coverage: null };
  reply = async () => good; await context.refreshNotes();
  assert.equal(rendered.length, 1);
  reply = async () => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); }; await context.refreshNotes();
  assert.equal(context.$('notes-status').hidden, true, 'a timeout says nothing');
  reply = async () => { throw new Error('Fictional server error'); }; await context.refreshNotes();
  assert.equal(context.$('notes-status').textContent, 'Fictional server error');
  reply = async () => good; await context.refreshNotes();
  assert.equal(rendered.length, 2, 'the same notes are drawn again');
  assert.equal(context.$('notes-status').hidden, true, 'and the message is gone');
});
