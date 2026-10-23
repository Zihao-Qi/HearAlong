import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { piTaskArgs, runPiTask } from '../src/pi-task.ts';
import { EXPLORATION_LIMITS } from '../src/explorations.ts';
import { loadRunPlans } from '../src/plans/versions.ts';
const fixture = fileURLToPath(new URL('./fixtures/fake-plan-pi.ts', import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) assert.fail('timed out'); await sleep(20); }
}
async function setup(config: any = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'split-server-'));
  const material = join(directory, 'materials', 'guide.md'); await mkdir(join(directory, 'materials'));
  await writeFile(material, 'The guide was approved during the workshop on Monday morning.\nThe paper lanterns stay on the lower shelf until parade day.\nThe painted crates must remain beside the workshop door until Friday.');
  const configPath = join(directory, 'config.json'); await writeFile(configPath, JSON.stringify({ ...config, material }));
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null,
    ai: { env: { ...process.env, MEETING_HEAVY_MODEL: 'fiction/model' } },
    notes: async () => ({ text: JSON.stringify({ summary: [], decisions: [], actions: [], otherMatters: [], otherTalk: [], openQuestions: [1, 2, 3].map(n => ({ text: `Where should workshop item ${n} stay?`, cites: ['S1'], quote: 'Keep the lanterns and crates in their designated workshop locations' })) }) }),
    plans: async (prompt, options) => {
      try { return await runPiTask(prompt, { ...options, command: process.execPath,
        args: ['--experimental-strip-types', '--no-warnings', fixture, ...piTaskArgs(prompt, options)], env: { ...options.env, FAKE_PLAN_CONFIG: configPath } }); }
      catch (error) {
        // Deterministic timeout/abort race: the task timer can win while quota teardown is in flight.
        if (config.timeoutOnAbort && (error as any).reason === 'cancelled') throw Object.assign(new Error('Pi task exceeded its time.'), { reason: 'timeout' });
        throw error;
      }
    },
  });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(app.url + path, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(res.ok, await res.clone().text()); return res.json() as Promise<any>;
  };
  const meeting = app.store.createMeeting('Fictional lantern workshop');
  const chunk = await app.store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
  app.store.completeChunk(chunk.id, { text: 'Keep the lanterns and crates in their designated workshop locations until the parade.', words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const base = `/api/meetings/${meeting.id}`;
  await call(`${base}/materials`, 'POST', { path: join(directory, 'materials'), scope: 'meeting' });
  await call(`${base}/notes`, 'POST', {});
  await until(async () => Boolean((await call(`${base}/notes`)).notes));
  const started = await call(`${base}/plans/runs`, 'POST', { opId: 'split-test-operation' });
  const runId = started.run.id;
  const folder = join(directory, 'explorations', meeting.id, runId);
  const terminal = async () => { await until(() => !['running', 'waiting'].includes(app.explorations.get(runId)!.state)); return app.explorations.get(runId)!; };
  return { directory, app, call, base, runId, folder, terminal, page: () => call(`${base}/plans`),
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));

test('copied-session processes preserve arguments/cache, merge, coverage and colliding evidence IDs', async () => {
  const s = await setup({ writers: { 2: { delay: 350 } } });
  try {
    await until(async () => (await s.page()).run?.progress?.written === 1);
    const p = (await s.page()).run.progress;
    assert.deepEqual([p.phase, p.expected, p.exact, p.written, p.latest], ['write', 2, true, 1, 'Lantern shelf']);
    assert.equal((await s.terminal()).state, 'done');
    const page = await s.page(); const doc = await loadRunPlans(s.folder);
    assert.equal(doc!.prompt, '1.8'); assert.deepEqual(doc!.notCovered, []);
    assert.deepEqual(doc!.deferred.map(d => d.item), ['N3']);
    assert.deepEqual(page.current.plans.map((p: any) => p.label), ['Lantern shelf', 'Painted crates']);
    assert.match(page.current.plans[0].answer.text, /“Painted crates”/);
    const evidence = await readJson(join(s.folder, 'evidence.json'));
    const reads = evidence.items.filter((e: any) => e.tool === 'read');
    assert.equal(reads.length, 3); assert.equal(new Set(reads.map((e: any) => e.call)).size, 3);
    assert.deepEqual(reads.map((e: any) => e.requested.offset).sort(), [1, 2, 3]);
    assert.ok(Object.values(page.current.evidence).every((e: any) => e.result.ok), 'writer reads and stage-1 Python checks are real evidence');
    const a = await readJson(join(s.directory, 'stage1.json'));
    for (const name of ['p1', 'p2']) {
      const b = await readJson(join(s.directory, `${name}.json`));
      assert.equal(b.recorded, true); assert.equal(a.recorded, true);
      assert.deepEqual(a.args.slice(0, a.args.indexOf('--session-dir')), b.args.slice(0, b.args.indexOf('--session')));
      assert.deepEqual(b.env, { ...a.env, RUN_PYTHON_USED: '1' });
    }
    const usage = await readJson(join(s.folder, 'usage.json'));
    assert.deepEqual(usage.map((u: any) => [u.model, u.usage.input, u.usage.cacheRead]), [['fiction/model', 45000, 0], ['fiction/model', 290, 38000], ['fiction/model', 290, 38000]]);
    assert.ok(usage.every((u: any) => u.durationMs > 0 && u.passVersion === '1.8'));
  } finally { await s.close(); }
});
test('partial writer failure publishes a warning and leaves its notes uncovered; all failures publish nothing', async () => {
  for (const all of [false, true]) {
    const s = await setup({ writers: { 1: { invalid: true }, 2: all ? { empty: true } : {} } });
    try {
      const job = await s.terminal(); const page = await s.page();
      if (all) { assert.equal(job.state, 'failed'); assert.equal(page.current, null); assert.match(job.error!, /No plans could be written/); }
      else { assert.equal(job.state, 'done'); assert.deepEqual(page.current.warnings, ['1 plan could not be written: Lantern shelf.']); assert.deepEqual(page.current.notCovered.map((n: any) => n.item), ['N1']); }
    } finally { await s.close(); }
  }
});
test('rate limits in either stage fail with quota message; writer quota aborts the other process', async () => {
  for (const stage1 of [true, false]) {
    const s = await setup(stage1 ? { stage1: { rate: true } } : { writers: { 1: { rate: true, delay: 250 }, 2: { hang: true } } });
    try {
      const job = await s.terminal(); assert.equal(job.state, 'failed'); assert.match(job.error!, /model's quota is used up/); assert.equal((await s.page()).current, null);
      if (!stage1) assert.ok(existsSync(join(s.directory, 'p2.aborted')));
    } finally { await s.close(); }
  }
});
for (const stage of ['stage1', 'writers', 'fallback', 'timeout-race', 'retry-event'] as const) test(`rate-limit retry in ${stage} aborts the pass immediately and preserves quota over timeout`, async () => {
  const limit = EXPLORATION_LIMITS.plan; EXPLORATION_LIMITS.plan = 2000;
  const retry = { rate: true, retryRate: true, delay: 250 };
  const config = stage === 'stage1' || stage === 'timeout-race' || stage === 'retry-event' ? { stage1: { ...retry, retryEvent: stage === 'retry-event' }, timeoutOnAbort: stage === 'timeout-race' }
    : stage === 'fallback' ? { outline: 'unparseable', writers: { 0: retry } }
    : { writers: { 1: retry, 2: { hang: true } } };
  const s = await setup(config);
  try {
    const job = await s.terminal();
    assert.equal(job.state, 'failed', 'quota must not become a time-limit stop');
    assert.equal(job.stopped, null); assert.match(job.error!, /model's quota is used up/);
    const name = stage === 'writers' ? 'p1' : stage === 'fallback' ? 'fallback' : 'stage1';
    const emittedAt = Number(await readFile(join(s.directory, `${name}.rate`), 'utf8'));
    assert.ok(Date.now() - emittedAt < 1000, 'do not wait for Pi retries or the invocation timeout');
    assert.ok(s.app.cooldowns.pausedUntil('model'), 'the model cooldown remains set');
    assert.equal((await s.page()).current, null); assert.equal(await loadRunPlans(s.folder), null);
    for (const process of stage === 'writers' ? ['p1', 'p2'] : [name]) {
      assert.ok(existsSync(join(s.directory, `${process}.aborted`)), `${process} was aborted`);
      const { pid } = await readJson(join(s.directory, `${process}.json`));
      assert.throws(() => globalThis.process.kill(pid, 0), /ESRCH/, `${process} ended`);
    }
  } finally { EXPLORATION_LIMITS.plan = limit; await s.close(); }
});

test('Cancel during either stage ends every owned process and publishes nothing; close does the same', async () => {
  for (const when of ['stage1', 'writers', 'close']) {
    const s = await setup(when === 'stage1' ? { stage1: { hang: true } } : { writers: { 1: { hang: true }, 2: { hang: true } } });
    try {
      const names = when === 'stage1' ? ['stage1'] : ['p1', 'p2'];
      await until(() => names.every(n => existsSync(join(s.directory, `${n}.json`))));
      if (when === 'close') await s.app.close(); else await s.call(`${s.base}/plans/runs/${s.runId}/cancel`, 'POST', {});
      const job = await s.terminal(); assert.equal(job.state, when === 'close' ? 'interrupted' : 'cancelled');
      assert.equal(await loadRunPlans(s.folder), null);
      for (const n of names) {
        assert.ok(existsSync(join(s.directory, `${n}.aborted`)));
        const { pid } = await readJson(join(s.directory, `${n}.json`));
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
      }
    } finally { await s.close(); }
  }
});
test('the plan time limit spans both stages, not a fresh allowance per writer', async () => {
  const limit = EXPLORATION_LIMITS.plan; EXPLORATION_LIMITS.plan = 1500;
  const started = performance.now();
  const s = await setup({ stage1: { delay: 650 }, writers: { 1: { hang: true }, 2: { hang: true } } });
  try {
    const job = await s.terminal(); assert.equal(job.state, 'stopped'); assert.equal(job.stopped, 'time limit');
    assert.ok(performance.now() - started < 2300, 'stage 2 gets only the remaining time');
    assert.equal((await s.page()).current, null);
    for (const n of ['p1', 'p2']) assert.ok(existsSync(join(s.directory, `${n}.aborted`)));
  } finally { EXPLORATION_LIMITS.plan = limit; await s.close(); }
});
