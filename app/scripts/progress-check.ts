// Real routes/jobs, scripted Pi events, disposable data and an explicitly chosen headless browser. No model/network calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { NotesFile, type NotesRunner } from '../src/notes.ts';
import { PlanVersions } from '../src/plans/index.ts';
import type { PiTaskOptions, PiTaskResult } from '../src/pi-task.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const out = resolve(process.argv[2] ?? 'artifacts/progress-check'); await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'progress-page-'));
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const gates: ReturnType<typeof gate>[] = [];
const hold = () => { const g = gate(); gates.push(g); return g; };
const wait = async (promise: Promise<unknown>, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  let stop!: () => void;
  try { await Promise.race([promise, new Promise((_, reject) => { stop = () => reject(new Error('Cancelled')); signal?.addEventListener('abort', stop, { once: true }); })]); }
  finally { signal?.removeEventListener('abort', stop); }
};
const until = async (fn: () => Promise<boolean>) => { for (let n = 0; n < 200; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Timed out'); };
const quote = 'Keep the painted lanterns on the lower shelf until the parade.';
const rawNotes = { title: 'Lantern workshop', summary: [{ text: 'The lanterns stay on the lower shelf.', cites: ['S1', 'S2'], quote }],
  decisions: [{ text: 'Use the lower shelf until the parade.', cites: ['S1'], quote }], actions: [],
  openQuestions: [{ text: 'Which lanterns need new batteries?', cites: ['S2'], quote: 'Which painted lanterns need new batteries before the parade' }],
  otherMatters: [], otherTalk: [] };
const rawPlan = { plans: [{ label: 'Lantern battery check', question: 'Which lanterns need new batteries?', from: ['N1'],
  answerLine: null, stepLine: 'Test the lantern batteries', stateNow: [], checks: [], answer: null,
  next: { text: 'Test each lantern battery and mark the discharged ones', basis: [] }, followOn: [], waitingOn: [], decideAfter: [], changeIf: null, further: null }], deferred: [] };
let mode: 'instant' | 'stream' = 'instant';
let notesRead = hold(), notesFinish = [hold(), hold(), hold()], notesSave = hold();
let notesAfterCommit: ReturnType<typeof gate> | null = null;
let planRead = hold(), planWrite = hold(), planFinish = hold(), planSave = hold();
let noteAborts = 0, planAborts = 0;
let split = false;
const notes: NotesRunner = async input => {
  if (mode === 'instant') return { text: JSON.stringify(rawNotes), model: 'stand-in' };
  const index = input.instructions.includes('notes: title,') ? 0 : input.instructions.includes('notes: decisions,') ? 1 : 2;
  const key = ['summary', 'decisions', 'otherMatters'][index];
  try {
    await wait(notesRead.promise, input.signal);
    input.onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `\`\`\`json\n{"${key}":[{"text":"Streamed ${key}"` } });
    input.onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '}]}' } });
    await wait(notesFinish[index].promise, input.signal);
    return { text: JSON.stringify(rawNotes), model: 'stand-in' };
  } catch (error) { if (input.signal.aborted) noteAborts++; throw error; }
};
const plans = async (_prompt: string, options: PiTaskOptions): Promise<PiTaskResult> => {
  const writing = Boolean(options.session);
  if (mode === 'stream') {
    try {
      if (!writing) {
        await wait(planRead.promise, options.signal);
        for (const file of ['guide.md', 'table.csv', 'draft.md', 'labels.md', 'guide.md']) {
          options.onEvent?.({ type: 'tool_execution_start', toolCallId: file, toolName: 'read', args: { path: join(directory, file) } });
          options.onEvent?.({ type: 'tool_execution_end', toolCallId: file, toolName: 'read', result: { content: [{ type: 'text', text: 'fictional material' }] } });
        }
        options.onEvent?.({ type: 'tool_execution_end', toolName: 'fetch_content', result: {} });
        options.onEvent?.({ type: 'tool_execution_end', toolName: 'run_python', result: {} });
        await wait(planWrite.promise, options.signal);
      } else {
        if (split && !/plan P[123] /.test(_prompt)) await wait(planFinish.promise, options.signal);
        const text = JSON.stringify(rawPlan);
        for (const delta of [text.slice(0, 25), text.slice(25)]) options.onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
        if (!split) await wait(planFinish.promise, options.signal);
      }
    } catch (error) { if (options.signal?.aborted) planAborts++; throw error; }
  }
  if (!writing) {
    await mkdir(options.sessionDir!, { recursive: true });
    await writeFile(join(options.sessionDir!, 'fake.jsonl'), 'fictional session');
  }
  // Exercise scanner progress only for a genuinely unparseable outline, not valid stage-1 plans JSON.
  const text = writing ? JSON.stringify(rawPlan) : split ? Array.from({ length: 8 }, (_, i) => `P${i + 1} | Lantern battery check | N1`).join('\n') : 'The outline could not be formatted.';
  return { text, ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [] };
};
const originalSave = NotesFile.prototype.save;
NotesFile.prototype.save = async function(record, signal, commit) {
  if (mode === 'stream') await wait(notesSave.promise, signal);
  const saved = await originalSave.call(this, record, signal, commit);
  if (notesAfterCommit) await notesAfterCommit.promise;
  return saved;
};
const originalPublish = PlanVersions.prototype.publish;
PlanVersions.prototype.publish = async function(...args) { if (mode === 'stream') await planSave.promise; return originalPublish.apply(this, args); };
await dashboardSetup(directory);
const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
// Consent must cover exactly the provider of MEETING_HEAVY_MODEL below.
await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...saved, aiMode: 'cloud', cloudConsent: { providers: ['example'], time: 1 } }));
await writeFile(join(directory, 'job-durations.json'), 'null'); // Optional corrupt history must not block the notes job.
const app = await startServer({ directory, port: 0, publicRoot: process.env.PROGRESS_PUBLIC_ROOT, notes, plans,
  ai: { env: { ...process.env, MEETING_HEAVY_MODEL: 'example/stand-in' } }, quick: null, heavy: null, recognizer: null, drafts: null, board: null, actions: null });
const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
const call = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(app.url + path, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
const errors: string[] = [], shots: string[] = [], firstReads: unknown[] = [];
assert.ok(process.env.MEETING_TEST_CHROME, 'Use an explicit headless shell');
const browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
try {
  for (const width of [1280, 390]) {
    mode = 'instant';
    const meeting = app.store.createMeeting('Lantern workshop');
    for (const [i, text] of [quote, 'Which painted lanterns need new batteries before the parade?'].entries()) {
      const chunk = await app.store.addPcm(meeting.id, 'mic:script', i, i * 30_000, 16000, Buffer.alloc(16000 * 4));
      app.store.completeChunk(chunk.id, { text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    }
    const base = `/api/meetings/${meeting.id}`;
    assert.equal((await fetch(app.url + base + '/notes/cancel', { method: 'POST', headers: { Origin: app.url } })).status, 403, 'Cancel requires a session');
    assert.equal((await fetch(app.url + base + '/notes/cancel', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.invalid' } })).status, 403, 'Cancel requires the dashboard origin');
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      await context.addInitScript(id => { localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes'); localStorage.setItem('compact-tab', 'notes'); }, meeting.id);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      let dimensionsAvailable = false;
      await page.route('**/api/meetings/*/notes', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch(), data = await response.json();
        if (!dimensionsAvailable && data.job?.state === 'running') delete data.job.progress;
        await route.fulfill({ response, json: data });
      });
      await page.goto(app.url);
      await page.evaluate(() => {
        const bad: string[] = [];
        const observer = new MutationObserver(() => {
          const text = document.getElementById('notes-progress')!.textContent ?? '';
          if (/\b0 (?:min|lines)\b/.test(text)) bad.push(text);
        });
        observer.observe(document.getElementById('notes-progress')!, { childList: true, subtree: true, characterData: true });
        (window as any).firstReadCounts = { bad, observer };
      });
      const shot = async (name: string) => { const file = `${width}-${name}.png`; await page.screenshot({ path: join(out, file) }); shots.push(file); };
      const startNotes = () => call(base + '/notes', 'POST', {});
      const startPlan = () => call(base + '/plans/runs', 'POST', { opId: `progress-${randomUUID()}` });
      const cancelNotes = page.locator('#notes-progress .progress-cancel');
      mode = 'stream'; notesRead = hold(); notesFinish = [hold(), hold(), hold()]; notesSave = hold();
      await startNotes();
      await page.locator('#notes-progress .progress-step[data-phase="read"][data-state="now"]').waitFor({ timeout: 6000 });
      assert.equal(await page.locator('.notes-bar').isVisible(), false, 'no extra row');
      assert.doesNotMatch(await page.locator('#notes-progress').innerText(), /\b0 (?:min|lines)\b/, 'first read never invents zero transcript dimensions');
      assert.equal(await page.locator('#notes-progress [data-phase="read"] .progress-detail').textContent(), '', 'unknown dimensions have no detail text');
      const writeTop = (await page.locator('#notes-progress [data-phase="write"]').boundingBox())!.y;
      await shot('notes-first-read-unknown');
      dimensionsAvailable = true;
      await page.waitForFunction(() => document.querySelector('#notes-progress [data-phase="read"] .progress-detail')?.textContent === '1 min · 2 lines');
      assert.equal(await page.locator('#notes-progress [data-phase="read"] .progress-detail').innerText(), '1 min · 2 lines');
      const stepShift = (await page.locator('#notes-progress [data-phase="write"]').boundingBox())!.y - writeTop;
      assert.ok(Math.abs(stepShift) <= 0.5, 'revealing dimensions does not move following steps');
      const invented = await page.evaluate(() => { const state = (window as any).firstReadCounts; state.observer.disconnect(); return state.bad; });
      assert.deepEqual(invented, [], 'no transient zero dimensions appeared between paints');
      firstReads.push({ width, unknownDetail: '', knownDetail: '1 min · 2 lines', followingStepShiftPx: stepShift, invented });
      if (width === 1280) assert.doesNotMatch(await page.locator('#notes-progress .progress-heading').innerText(), /of about|usually/, 'no history means no estimate');
      await shot('notes-first-read');
      const oldJobId = (await call(base + '/notes')).job.id;
      const cancelReply = page.waitForResponse(r => r.url().endsWith('/notes/cancel') && r.request().method() === 'POST');
      await cancelNotes.click();
      const cancelled = await cancelReply;
      assert.deepEqual(cancelled.request().postDataJSON(), { jobId: oldJobId }, 'Cancel sends the displayed identity');
      assert.equal((await cancelled.json()).outcome, 'cancelled');
      await until(async () => (await call(base + '/notes')).job === null);
      assert.equal(noteAborts, width === 1280 ? 3 : 9);
      await shot('notes-first-cancelled');
      mode = 'instant'; await startNotes(); await until(async () => Boolean((await call(base + '/notes')).notes));
      await page.locator('.notes-summary a').first().waitFor();
      mode = 'stream'; notesRead = hold(); notesFinish = [hold(), hold(), hold()]; notesSave = hold();
      await startNotes(); await page.locator('#notes-progress [data-phase="read"][data-state="now"]').waitFor();
      const staleCancel = await fetch(app.url + base + '/notes/cancel', { method: 'POST', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: oldJobId }) });
      assert.equal(staleCancel.status, 409, 'an old card cannot cancel the new job');
      assert.equal((await call(base + '/notes')).job.state, 'running');
      const sentence = page.locator('.notes-summary a').first();
      await sentence.focus(); await sentence.evaluate(n => { (window as any).savedSentence = n; });
      const firstClock = await page.locator('#notes-progress .progress-heading').innerText();
      await page.waitForTimeout(1200);
      assert.notEqual(await page.locator('#notes-progress .progress-heading').innerText(), firstClock, 'clock ticks each second');
      assert.equal(await sentence.evaluate(n => n === document.activeElement), true);
      await shot('notes-again-read');
      notesRead.release();
      await page.waitForFunction(() => document.querySelector('#notes-progress [data-part="project"] .progress-count')?.textContent === '1');
      assert.match(await page.locator('#notes-progress .progress-latest').innerText(), /Streamed/);
      assert.equal(await sentence.evaluate(n => n === (window as any).savedSentence && n === document.activeElement), true, 'actual focused node survives progress');
      assert.equal(await sentence.isVisible(), true, 'old notes remain readable');
      notesFinish[2].release();
      await page.waitForFunction(() => document.querySelector('#notes-progress [data-part="other"] .progress-part-done')?.textContent === '✓');
      await shot('notes-write-other-done');
      notesFinish[0].release(); notesFinish[1].release();
      await page.locator('#notes-progress [data-phase="check"][data-state="now"]').waitFor();
      assert.deepEqual(await page.locator('#notes-progress .progress-part-done').allTextContents(), ['✓', '✓', '✓']);
      await shot('notes-check');
      notesSave.release(); await until(async () => (await call(base + '/notes')).notes.version === 2);
      await page.waitForFunction(() => document.getElementById('notes-progress')?.hidden);
      await shot('notes-finished');
      notesRead = hold(); notesFinish = [hold(), hold(), hold()]; notesSave = hold();
      await startNotes(); await page.locator('#notes-progress .progress-cancel').waitFor();
      await cancelNotes.click(); await until(async () => (await call(base + '/notes')).job === null);
      assert.equal((await call(base + '/notes')).notes.version, 2, 'Cancel keeps old notes');
      await shot('notes-again-cancelled');
      notesRead = hold(); notesFinish = [hold(), hold(), hold()]; notesSave = hold(); notesAfterCommit = hold();
      notesRead.release(); notesFinish.forEach(g => g.release()); notesSave.release();
      await startNotes(); await until(async () => (await call(base + '/notes')).notes.version === 3);
      const committedId = (await call(base + '/notes')).job.id;
      await page.waitForFunction(id => document.getElementById('notes-progress')?.dataset.jobId === id, committedId);
      const savedReply = page.waitForResponse(r => r.url().endsWith('/notes/cancel') && r.request().method() === 'POST');
      await cancelNotes.click(); assert.equal((await (await savedReply).json()).outcome, 'already-saved');
      await page.waitForFunction(() => document.getElementById('notes-body')?.dataset.record?.endsWith(':3'));
      assert.equal(await page.locator('.notes-summary a').isVisible(), true, 'Cancel after commit shows the newly saved notes');
      await shot('notes-cancel-after-commit');
      notesAfterCommit.release(); notesAfterCommit = null;
      await until(async () => (await call(base + '/notes')).job === null);
      await writeFile(join(directory, 'job-durations.json'), '{"plans":[null,{"ms":1e309}]}'); // Nor the plan job.
      mode = 'instant'; await startPlan(); await until(async () => Boolean((await call(base + '/plans')).current));
      await page.locator(width === 390 ? '#ctab-plans' : '#tab-plans').click();
      await page.locator('.plan-row').first().waitFor();
      mode = 'stream'; planRead = hold(); planWrite = hold(); planFinish = hold(); planSave = hold();
      await startPlan();
      await page.locator('#plans [data-phase="notes"][data-state="now"]').waitFor();
      const planClock = await page.locator('#plans .progress-heading').innerText();
      await page.waitForTimeout(1200);
      assert.notEqual(await page.locator('#plans .progress-heading').innerText(), planClock, 'plans clock ticks too');
      await shot('plans-read-notes');
      const planFocus = page.locator('.plan-chevron').first();
      const focusTarget = await planFocus.count() ? planFocus : page.locator('.plan-row button').first();
      await focusTarget.focus(); await focusTarget.evaluate(n => { (window as any).savedPlanControl = n; });
      planRead.release();
      await page.locator('#plans [data-phase="materials"][data-state="now"]').waitFor();
      assert.match(await page.locator('#plans .progress-detail').allTextContents().then(a => a.join(' ')), /guide.md · table.csv · draft.md · \+1\u00a0more · 1\u00a0web\u00a0page · 1\u00a0check\u00a0run/);
      await shot('plans-materials');
      planWrite.release();
      await page.waitForFunction(() => document.querySelector('#plans .progress-latest')?.textContent?.includes('Lantern battery check'));
      assert.match(await page.locator('#plans [data-phase="write"] .progress-detail').innerText(), /1 so far/);
      assert.equal(await focusTarget.evaluate(n => n === document.activeElement && n === (window as any).savedPlanControl), true);
      await shot('plans-write');
      planFinish.release();
      await page.locator('#plans [data-phase="check"][data-state="now"]').waitFor(); await shot('plans-check');
      planSave.release(); await until(async () => (await call(base + '/plans')).current.version === 2);
      await page.waitForFunction(() => !document.querySelector('#plans .job-progress'));
      await shot('plans-finished');
      planRead = hold(); await startPlan(); await page.locator('#plans .progress-cancel').waitFor();
      await page.locator('#plans .progress-cancel').click();
      await until(async () => (await call(base + '/plans')).run?.state === 'cancelled');
      assert.equal((await call(base + '/plans')).current.version, 2); assert.equal(planAborts, width === 1280 ? 1 : 2);
      await shot('plans-cancelled');
      split = true; planRead = hold(); planWrite = hold(); planFinish = hold(); planSave = hold();
      planRead.release(); planWrite.release();
      await startPlan();
      await page.waitForFunction(() => document.querySelector('#plans [data-phase="write"] .progress-detail')?.textContent === '3 of 8');
      assert.match(await page.locator('#plans .progress-latest').innerText(), /Lantern battery check/);
      assert.match(await page.locator('#plans [data-phase="write"]').innerText(), /Write the plans.*3 of 8/s);
      await shot('plans-exact-three-of-eight');
      planFinish.release(); planSave.release();
      await until(async () => (await call(base + '/plans')).current.version === 3);
      await until(async () => !(await call(base + '/plans')).run);
      split = false;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'first-read.json'), JSON.stringify(firstReads, null, 2));
  await writeFile(join(out, 'index.md'), '# Progress states (1280 and 390 px)\n\n' + shots.map(s => `- [${s}](${s})`).join('\n'));
  console.log(`Progress checks passed: ${shots.length} screenshots; no page errors.`);
} finally {
  gates.forEach(g => g.release());
  await browser.close(); await app.close();
  NotesFile.prototype.save = originalSave; PlanVersions.prototype.publish = originalPublish;
  await rm(directory, { recursive: true, force: true });
}
