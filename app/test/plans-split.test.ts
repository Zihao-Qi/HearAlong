import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prompts from '../src/plans/prompt.ts';
import { parseOutline, replaceOutlineRefs, runPlanPass } from '../src/plans/pass.ts';
import { type PiTaskOptions, type PiTaskResult } from '../src/pi-task.ts';
import type { ExplorationContext } from '../src/explorations.ts';
import { planProgress } from '../src/progress.ts';

test('outline tolerates fences, bullets, whitespace and chatter, caps at eight', () => {
  const o = parseOutline('noise\n```text\n - P3 | Dock location | N1, N2\n* D | N7 | Already done\n```\n' + Array.from({ length: 9 }, (_, i) => `P${i + 4} | Topic ${i} | N${i + 3}`).join('\n'));
  assert.equal(o.plans.length, 8); assert.equal(o.plans[0].number, 3);
  assert.deepEqual(o.deferred, [{ item: 'N7', why: 'Already done' }]); assert.equal(o.review.length, 1);
  assert.equal(parseOutline('nothing here').plans.length, 0);
  assert.equal(parseOutline('D | N1 | settled').deferred.length, 1);
});
test('outline references are replaced recursively except the whole source object', () => {
  const o = parseOutline('P1 | Dock location | N1\nP2 | Caster repair | N2');
  const source = { ref: 'P2', path: 'P1/results.csv', url: 'https://example.org/P2', quote: 'P2 stays verbatim', metadata: { text: 'P1' } };
  assert.deepEqual(replaceOutlineRefs({ text: 'See P2, not XP1 or P20.', source, waitingOn: ['P1'] }, o.plans),
    { text: 'See “Caster repair”, not XP1 or P20.', source, waitingOn: ['“Dock location”'] });
});

const result = (text: string): PiTaskResult => ({ text, model: 'fiction/model', usage: { input: 290, output: 100, cacheRead: 38000 }, ms: 10, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [] });
async function harness(outline: string, writers: (prompt: string, options: PiTaskOptions) => Promise<PiTaskResult>, input = '# Notes\nN1 Choose the dock\nN2 Repair the caster') {
  const folder = await mkdtemp(join(tmpdir(), 'plans-split-'));
  const inputPath = join(folder, 'input.md');
  await writeFile(inputPath, input);
  const calls: { prompt: string; options: PiTaskOptions }[] = [];
  const progress = planProgress(0, 4); const controller = new AbortController();
  const ctx = { folder, cwd: folder, signal: controller.signal, pi: async (prompt: string, options: PiTaskOptions) => {
    calls.push({ prompt, options });
    if (calls.length === 1) {
      await mkdir(options.sessionDir!, { recursive: true }); await writeFile(join(options.sessionDir!, 'original.jsonl'), 'session');
      options.onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: outline } });
      assert.notEqual(progress.phase, 'write'); assert.equal(progress.written, 0);
      return result(outline);
    }
    assert.equal(await readFile(options.session!, 'utf8'), 'session');
    return writers(prompt, options);
  } } as unknown as ExplorationContext;
  const options = { model: 'fiction/model', thinking: 'low' as const, files: [inputPath], tools: 'read,calculate', extensions: ['calculate.ts'], env: { CALCULATE_MAX_RUNS: '3', CALCULATE_MS: '60000' } };
  return { folder, calls, progress, controller, run: () => runPlanPass(ctx, options, () => {}, progress), close: () => rm(folder, { recursive: true, force: true }) };
}
test('writers merge in outline order, ignore extra plans/deferred, report exact progress and provenance', async () => {
  const h = await harness('P1 | Dock | N1\nP2 | Caster | N2\nD | N3 | settled', async (prompt) => {
    const n = prompt.includes('plan P1 ') ? 1 : 2;
    if (n === 1) await new Promise(r => setTimeout(r, 30));
    return result(JSON.stringify({ plans: [{ label: n === 1 ? 'Dock' : 'Caster', question: 'See P2', from: [`N${n}`] }, { label: 'extra' }], deferred: [{ item: 'N4', why: 'wrong' }] }));
  });
  try {
    const r = await h.run(); assert.deepEqual((r.answer as any).plans.map((p: any) => p.label), ['Dock', 'Caster']);
    assert.deepEqual((r.answer as any).deferred, [{ item: 'N3', why: 'settled' }]);
    assert.equal((r.answer as any).plans[0].question, 'See “Caster”'); assert.equal(r.review.length, 2);
    assert.deepEqual([h.progress.exact, h.progress.expected, h.progress.written, h.progress.latest], [true, 2, 2, 'Dock']);
    for (const c of h.calls.slice(1)) {
      assert.deepEqual(c.options.tools, h.calls[0].options.tools); assert.deepEqual(c.options.extensions, h.calls[0].options.extensions);
      assert.deepEqual(c.options.thinking, h.calls[0].options.thinking); assert.deepEqual(c.options.model, h.calls[0].options.model);
      assert.equal(c.options.files, undefined); assert.deepEqual(c.options.env, { ...h.calls[0].options.env, CALCULATE_USED: '0' });
    }
    const usage = JSON.parse(await readFile(join(h.folder, 'usage.json'), 'utf8')); assert.equal(usage.length, 3); assert.equal(usage[1].usage.cacheRead, 38000);
  } finally { await h.close(); }
});
test('only deferred skips writers; unparseable outline continues one fallback copy', async () => {
  for (const outline of ['D | N1 | done', 'unparseable']) {
    const h = await harness(outline, async prompt => { assert.equal(prompt, prompts.PLAN_STAGE2_FALLBACK); return result('{"plans":[],"deferred":[]}'); });
    try {
      const r = await h.run(); assert.deepEqual((r.answer as any).plans, []);
      assert.equal(h.calls.length, outline === 'unparseable' ? 2 : 1);
      if (outline !== 'unparseable') assert.deepEqual([h.progress.exact, h.progress.expected], [true, 0]);
    } finally { await h.close(); }
  }
});
test('meeting P-names in either notes or transcript are not rewritten as outline references', async () => {
  for (const input of ['# Notes\nN1 Compare phase P2 with phase one.', '# Notes\nN1 Choose the dock\n# Transcript\nS1 [00:00] Participant P2 will inspect the dock.']) {
    const h = await harness('P1 | Dock | N1\nP2 | Caster | N2', async () => result(JSON.stringify({ plans: [{ question: 'Compare P2 with P1.', next: { text: 'Ask P2.' } }] })), input);
    try {
      const r = await h.run();
      for (const p of (r.answer as any).plans) {
        assert.equal(p.question, 'Compare P2 with “Dock”.');
        assert.equal(p.next.text, 'Ask P2.');
      }
    } finally { await h.close(); }
  }
});
test('stage-1 plans JSON is used directly with exact completed progress, including an empty plans array', async () => {
  for (const plans of [[], [{ label: 'Dock' }, { label: 'Caster' }]]) {
    const answer = { plans, deferred: [{ item: 'N3', why: 'Settled' }] };
    const h = await harness('```json\n' + JSON.stringify(answer) + '\n```', async () => { assert.fail('stage 2 must not run for plans JSON'); });
    try {
      const r = await h.run();
      assert.deepEqual(r.answer, answer); assert.equal(h.calls.length, 1);
      assert.deepEqual([h.progress.exact, h.progress.expected, h.progress.written], [true, plans.length, plans.length]);
    } finally { await h.close(); }
  }
});
test('JSON without a plans array still continues the one-writer fallback', async () => {
  const h = await harness('{"plans":null,"other":"not plans"}', async prompt => {
    assert.equal(prompt, prompts.PLAN_STAGE2_FALLBACK); return result('{"plans":[],"deferred":[]}');
  });
  try {
    const r = await h.run(); assert.deepEqual(r.answer, { plans: [], deferred: [] });
    assert.equal(h.calls.length, 2); assert.notEqual(h.progress.exact, true);
  } finally { await h.close(); }
});
test('one failed copy preserves others with warning; all failed copies fail the pass', async () => {
  for (const all of [false, true]) {
    const h = await harness('P1 | Dock | N1\nP2 | Caster | N2', async prompt => {
      if (all || prompt.includes('plan P1 ')) throw new Error('writer failed');
      return result('{"plans":[{"label":"Caster","from":["N2"]}]}');
    });
    try {
      if (all) await assert.rejects(h.run(), /No plans could be written/);
      else { const r = await h.run(); assert.equal((r.answer as any).plans.length, 1); assert.deepEqual(r.warnings, ['1 plan could not be written: Dock.']); }
    } finally { await h.close(); }
  }
});
for (const fails of [true, false]) test(`usage write failure preserves ${fails ? 'the provider error' : 'a successful pass'}`, async t => {
  const originalError = new Error('429 rate limit from provider');
  const answer = { plans: [], deferred: [{ item: 'N1', why: 'Already settled' }] };
  const h = await harness(fails ? 'unparseable' : JSON.stringify(answer), async () => { throw originalError; });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  try {
    // A directory at the output path deterministically fails only the optional provenance write.
    await mkdir(join(h.folder, 'usage.json'));
    if (fails) await assert.rejects(h.run(), error => error === originalError);
    else assert.deepEqual((await h.run()).answer, answer);
    assert.ok(warnings.some(w => /usage/i.test(w)), 'the failed provenance write must be warned about');
  } finally { await h.close(); }
});

test('rate limit in a writer aborts siblings and wins over their cancellation errors', async () => {
  let aborted = false;
  const h = await harness('P1 | Dock | N1\nP2 | Caster | N2', async (prompt, options) => {
    if (prompt.includes('plan P1 ')) { await new Promise(r => setTimeout(r, 30)); throw new Error('429 rate limit'); }
    return new Promise((_, reject) => options.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }));
  });
  try { await assert.rejects(h.run(), /429 rate limit/); assert.equal(aborted, true); } finally { await h.close(); }
});
