// Fix-round geometry and copy regressions. Real page, fictional data, explicit headless browser; all checks collect failures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { EXPLORE_PROMPT } from '../src/plans/index.ts';
import type { PiTaskOptions, PiTaskResult } from '../src/pi-task.ts';
const out = resolve(process.argv[2] ?? 'artifacts/progress-fix1'); await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'progress-fix1-page-'));
const quote = 'Keep the painted lanterns on the lower rack until the parade.';
const item = (text: string) => ({ text, cites: ['S1'], quote });
let writeExplore: () => void = () => { throw new Error('Explore has not started.'); };
const planAnswer = { plans: [{ label: 'Lantern batteries', question: 'Which batteries need replacing?', from: ['N1'], answerLine: null, stepLine: 'Check the lantern batteries',
  stateNow: [{ id: 'k1', text: 'The lanterns are kept on the lower rack', source: { type: 'transcript', ref: 'S1', quote } }], checks: [], answer: null,
  next: { text: 'Check each lantern battery before the parade', basis: ['k1'] }, followOn: [], waitingOn: [], decideAfter: [], changeIf: null,
  further: { state: 'ready', what: 'Compare the lantern battery readings', why: 'identify batteries that need replacing', minutes: 10 } }], deferred: [] };
const plans = async (prompt: string, options: PiTaskOptions): Promise<PiTaskResult> => {
  if (prompt === EXPLORE_PROMPT) {
    const writing = new Promise<void>(resolve => { writeExplore = resolve; });
    const wait = async (work: Promise<void>) => {
      options.signal?.throwIfAborted(); let stop!: () => void;
      try { await Promise.race([work, new Promise<void>((_, reject) => { stop = () => reject(new Error('Explore cancelled')); options.signal?.addEventListener('abort', stop, { once: true }); })]); }
      finally { options.signal?.removeEventListener('abort', stop); }
    };
    options.onEvent?.({ type: 'tool_execution_start', toolCallId: 'guide', toolName: 'read', args: { path: join(directory, 'guide.md') } });
    await wait(writing);
    options.onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"plans":[{"label":"Lantern batteries"}]}' } });
    await wait(new Promise<void>(() => {}));
  }
  if (!options.session) {
    await mkdir(options.sessionDir!, { recursive: true });
    await writeFile(join(options.sessionDir!, 'fake.jsonl'), 'fictional session');
  }
  return { text: JSON.stringify(planAnswer), ms: 1, tools: [], toolEvents: 0, toolResults: [], aborted: false, stopReason: 'stop', settled: true, exitCode: 0, exitSignal: null };
};
await dashboardSetup(directory);
const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null, plans,
  ai: { env: { ...process.env, MEETING_HEAVY_MODEL: 'example/stand-in' } },
  notes: async () => ({ text: JSON.stringify({ summary: [item('The painted lanterns are ready for the parade and stay on the rack.'), item('Crates stay here.'), item('Check the batteries.')],
    decisions: [item('Keep every painted lantern on the lower rack until the parade finishes, with the blue crates beside the workshop door.')], actions: [], openQuestions: [item('Which batteries need replacing?')], otherMatters: [], otherTalk: [] }) }) });
const meeting = app.store.createMeeting('Lantern workshop');
const chunk = await app.store.addPcm(meeting.id, 'mic:fiction', 0, 0, 16000, Buffer.alloc(64000));
app.store.completeChunk(chunk.id, { text: quote, words: [], backend: 'stand-in', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
await fetch(`${app.url}/api/meetings/${meeting.id}/notes`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
const errors: string[] = [], failures: string[] = [], shots: string[] = [], measurements: unknown[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail ? JSON.stringify(detail) : ''}`); if (!ok) failures.push(name); };
assert.ok(process.env.MEETING_TEST_CHROME);
const browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      await context.addInitScript(id => { localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes'); localStorage.setItem('compact-tab', 'notes'); localStorage.setItem('board-width', '400'); }, meeting.id);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(app.url); await page.locator('.notes-summary .note-sentence').first().waitFor();
      const shot = async (name: string) => { const file = `${width}-${name}.png`; await page.screenshot({ path: join(out, file) }); shots.push(file); };
      const checkExploreLayout = async () => {
        const layout = await page.evaluate(() => {
          const compact = document.body.classList.contains('layout-compact');
          const card = document.querySelector('#plans .plans-card')!;
          const panel = card.closest('.pane-body')!;
          const options = [...document.querySelectorAll('.options-button')].filter(n => (n as HTMLElement).offsetParent);
          const cancel = document.querySelector('#plans .progress-cancel'); const style = cancel ? getComputedStyle(cancel) : null;
          return { selected: document.getElementById(compact ? 'ctab-plans' : 'tab-plans')!.getAttribute('aria-selected'), options: options.length,
            normalOptions: options.length === 1 && Boolean(options[0].closest(compact ? '#plans .plans-head' : '#plans-options-slot')),
            gutter: card.getBoundingClientRect().left - panel.getBoundingClientRect().left, expectedGutter: compact ? 12 : 20,
            textFocus: [...card.querySelectorAll('.plan-text')].some(n => n.matches(':focus-visible')),
            cancelStyle: style ? { decoration: style.textDecorationLine, size: style.fontSize, color: style.color, height: cancel!.getBoundingClientRect().height } : null };
        });
        check(`${width}: Explore has PLANS selected`, layout.selected === 'true', layout);
        check(`${width}: Explore has one normally placed Options control`, layout.options === 1 && layout.normalOptions, layout);
        check(`${width}: Explore keeps the normal pane gutter`, Math.abs(layout.gutter - layout.expectedGutter) <= 0.5, layout);
        check(`${width}: Explore has no artificial focus box on row text`, !layout.textFocus, layout);
        if (layout.cancelStyle) check(`${width}: real Explore Cancel is an underlined text action`, layout.cancelStyle.decoration === 'underline' && layout.cancelStyle.size === '14px' && layout.cancelStyle.height >= 44, layout.cancelStyle);
        measurements.push({ width, exploreLayout: layout });
      };
      const flow = await page.locator('.notes-summary').evaluate(p => {
        const first = (n: Element) => { const range = document.createRange(); range.setStart(n.firstChild!, 0); range.setEnd(n.firstChild!, 1); return range.getBoundingClientRect().toJSON(); };
        return { left: p.getBoundingClientRect().left, links: [...p.querySelectorAll('.note-sentence')].map(n => ({ tag: n.tagName, href: n.getAttribute('href'), rect: first(n) })) };
      });
      check(`${width}: sentence controls are real transcript links`, flow.links.every(n => n.tag === 'A' && n.href?.startsWith('#transcript-')));
      check(`${width}: summary sentences flow mid-line`, flow.links.slice(1).some(n => n.rect.x > flow.left + 2), flow);
      const session = await context.newCDPSession(page);
      const root = await session.send('DOM.getDocument', { depth: -1 });
      const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.root.nodeId, selector: '#notes-body .notes-list > li' });
      for (const nodeId of nodeIds) {
        const { node } = await session.send('DOM.describeNode', { nodeId });
        const marker = node.pseudoElements?.find(n => n.pseudoType === 'marker');
        assert.ok(marker, 'Chrome exposes the actual list marker geometry');
        const { model } = await session.send('DOM.getBoxModel', { backendNodeId: marker.backendNodeId });
        const centre = (model.content[1] + model.content[5]) / 2;
        const line = await page.locator('#notes-body .notes-list > li').nth(nodeIds.indexOf(nodeId)).evaluate(li => {
          const text = li.querySelector('.note-sentence')!.firstChild!; const r = document.createRange(); r.setStart(text, 0); r.setEnd(text, 1);
          const first = r.getBoundingClientRect(); return { top: first.top, bottom: first.top + parseFloat(getComputedStyle(li).lineHeight), itemHeight: li.getBoundingClientRect().height };
        });
        check(`${width}: bullet centre is in first line ±2px`, centre >= line.top - 2 && centre <= line.bottom + 2, { centre, ...line });
        measurements.push({ width, marker: centre, line });
      }
      await session.detach(); await shot('flow-and-bullets');
      const sentence = page.locator('.notes-summary .note-sentence').first();
      await sentence.focus(); await page.keyboard.press('Enter');
      await page.locator('#transcript .cited').waitFor();
      check(`${width}: prevented default fragment navigation`, new URL(page.url()).hash === '');
      check(`${width}: cited background without stripe`, await page.locator('#transcript .cited').first().evaluate(n => getComputedStyle(n).boxShadow === 'none'));
      await shot('transcript-mark');
      if (width === 390) await page.locator('#ctab-notes').click();
      const headerCases = await page.evaluate(async () => {
        const module = '/plans.js'; const { progressCard } = await import(module);
        const host = document.getElementById('notes-progress')!; host.hidden = false;
        const card = progressCard('plans', { phase: 'write', startedAt: Date.now() - 90_000, estimate: 630_000, questions: 1, pages: 1, checks: 1, written: 1, expected: 1 }, () => {});
        host.replaceChildren(card);
        const heading = card.querySelector('.progress-heading')!;
        const formatted = heading.textContent;
        const details = card.textContent;
        progressCard('plans', { phase: 'write', startedAt: Date.now() - 65_000, estimate: 60_000 }, () => {}, card);
        const expired = heading.textContent;
        progressCard('plans', { phase: 'write', startedAt: Date.now(), estimate: null }, () => {}, card);
        const absent = heading.textContent;
        heading.textContent = 'Making plans · 12:34 of about 10½ min';
        const r = document.createRange(); r.selectNodeContents(heading);
        const lines = [...r.getClientRects()], cancel = card.querySelector('.progress-cancel')!.getBoundingClientRect();
        return { formatted, expired, absent, details, lineCount: lines.length, textCentre: lines[0] ? (lines[0].top + lines[0].bottom) / 2 : 0, cancelCentre: (cancel.top + cancel.bottom) / 2, overflow: card.scrollWidth > card.clientWidth };
      });
      check(`${width}: compact estimate wording`, headerCases.formatted === 'Making plans · 1:30 of about 10½ min', headerCases);
      check(`${width}: expired and absent estimates omitted`, headerCases.expired === 'Making plans · 1:05' && headerCases.absent === 'Making plans · 0:00');
      check(`${width}: header and Cancel share exactly one line`, headerCases.lineCount === 1 && Math.abs(headerCases.textCentre - headerCases.cancelCentre) <= 2 && !headerCases.overflow, headerCases);
      check(`${width}: singular wording and expected reached`, Boolean(headerCases.details?.includes('1\u00a0open\u00a0question') && !headerCases.details.includes('open decisions') && headerCases.details.includes('1\u00a0web\u00a0page · 1\u00a0check\u00a0run') && headerCases.details.includes('1 so far')));
      measurements.push({ width, header: headerCases }); await shot('long-progress-heading');
      await page.locator(width === 390 ? '#ctab-plans' : '#tab-plans').click();
      await page.locator('#plans .plans-content').waitFor();
      if (!(await page.locator('#plans .plan-row').count())) await page.locator('#plans .plans-primary').click();
      await page.locator('#plans .plan-row').first().waitFor();
      await page.locator('#plans .plan-chev').first().click();
      await page.locator('#plans .plan-explore button').click();
      await page.locator('#plans [data-phase="materials"][data-state="now"]').waitFor();
      await page.evaluate(() => { (window as any).fix1Explore = { row: document.querySelector('#plans .plan-row'), control: document.activeElement }; });
      check(`${width}: Explore further has a progress card`, await page.locator('#plans .job-progress').count() === 1);
      check(`${width}: running plans have no idle text`, await page.locator('#plans .plans-idle, #plans .plans-reading').count() === 0);
      await checkExploreLayout();
      await shot('explore-materials');
      writeExplore();
      await page.locator('#plans .progress-latest').waitFor();
      const stable = await page.evaluate(() => {
        const s = (window as any).fix1Explore;
        return { row: s.row === document.querySelector('#plans .plan-row'), focus: s.control === document.activeElement, latest: document.querySelector('#plans .progress-latest')?.textContent };
      });
      check(`${width}: Explore updates retain actual row and focus`, stable.row && stable.focus && stable.latest === 'Latest: Lantern batteries', stable);
      await checkExploreLayout(); await shot('explore-write');
      await page.locator('#plans .progress-cancel').click();
      await page.locator('#plans .job-progress').waitFor({ state: 'hidden' });
      const cancelled = await (await page.request.get(`${app.url}/api/meetings/${meeting.id}/plans`)).json();
      check(`${width}: Explore Cancel works`, cancelled.run?.state === 'cancelled' && cancelled.current?.version === 1 && /Explore further on[\s\S]*was stopped/.test(await page.locator('#plans').innerText()));
      await checkExploreLayout(); await shot('explore-cancelled');
    } finally { await context.close(); }
  }
  check('no page errors', errors.length === 0, errors);
  await writeFile(join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await writeFile(join(out, 'index.md'), shots.map(s => `- [${s}](${s})`).join('\n'));
  assert.deepEqual(failures, []);
} finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
