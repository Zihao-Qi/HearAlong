import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ItemScanner, estimate, DurationHistory, planProgress, updatePlanProgress } from '../src/progress.ts';

test('scanner emits only complete objects in named top-level arrays across every split, fences and escapes', () => {
  const text = '```json\n' + JSON.stringify({ title: 'ignore', summary: [{ text: 'a [bracket] and "quote" \\ slash', nested: { text: 'not an item' } }, { text: 'second' }], otherTalk: [{ label: 'ignore' }] }) + '\n```';
  for (let split = 1; split < text.length; split++) {
    const items: unknown[] = [];
    const scanner = new ItemScanner(['summary'], (_section, item) => items.push(item));
    scanner.push(text.slice(0, split)); scanner.push(text.slice(split));
    assert.deepEqual(items, [{ text: 'a [bracket] and "quote" \\ slash', nested: { text: 'not an item' } }, { text: 'second' }]);
  }
  const items: unknown[] = [];
  const scanner = new ItemScanner(['plans'], (_, item) => items.push(item));
  for (const c of '{"plans":[{"label":"first"},{"label":"unfinished') scanner.push(c);
  assert.deepEqual(items, [{ label: 'first' }]);
});

test('estimates: absent history, median, transcript scaling, clamp and half-minute rounding', () => {
  assert.equal(estimate([], 100), null);
  const rows = [{ ms: 60_000, lines: 100 }, { ms: 120_000, lines: 200 }, { ms: 600_000, lines: 300 }];
  assert.equal(estimate(rows), 120000);
  assert.equal(estimate([{ ms: 60_000 }, { ms: 120_000 }]), 90000);
  assert.equal(estimate(rows, 200), 120000);
  assert.equal(estimate(rows, 1), 60000);
  assert.equal(estimate(rows, 10000), 240000);
  assert.equal(estimate([{ ms: 80_000 }]), 90000);
  assert.equal(estimate([{ ms: 59_000 }]), 60000);
});

test('history persists last ten successes atomically across kinds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'progress-test-'));
  try {
    const h = new DurationHistory(dir);
    await Promise.all(Array.from({ length: 12 }, (_, i) => h.record('notes', (i + 1) * 60_000, 100)));
    await h.record('plans', 30_000);
    assert.equal(await new DurationHistory(dir).estimate('notes', 100), 450000);
    assert.equal(await h.estimate('plans'), 60000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scanner recovers from preamble braces, quotes and unfinished candidates before actual JSON', () => {
  for (const preamble of ['The shape is {summary, actions}:\n', 'Unclosed {this is not JSON\n', 'A stray "quote before the payload:\n', 'Schema {"label":"words"} then:\n', 'Broken {"label":"unterminated\n']) {
    const payload = preamble + '```json\n{"summary":[{"text":"actual item with ` ticks and { braces"}]}\n```';
    for (let split = 1; split < payload.length; split++) {
      const items: unknown[] = [], scanner = new ItemScanner(['summary'], (_, item) => items.push(item));
      scanner.push(payload.slice(0, split)); scanner.push(payload.slice(split));
      assert.deepEqual(items, [{ text: 'actual item with ` ticks and { braces' }], preamble);
    }
  }
});

test('duration history validates roots, arrays and finite entries, then repairs on write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-corrupt-'));
  try {
    const h = new DurationHistory(dir), path = join(dir, 'job-durations.json');
    for (const corrupt of ['null', '[]', '42', '{"notes":{}}', '{"notes":[null,"wrong",{"ms":1e309},{"ms":-1},{"ms":120000,"lines":0}]}']) {
      await writeFile(path, corrupt);
      assert.equal(await h.estimate('notes', 100), null, corrupt);
      assert.equal(await h.estimate('plans'), null, corrupt);
      await h.record('notes', 120000, 100);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { notes: [{ ms: 120000, lines: 100 }], plans: [] });
    }
    await writeFile(path, '{"notes":[null,{"ms":60000,"lines":100},{"ms":"60000"},{"ms":120000,"lines":200}]}');
    assert.equal(await h.estimate('notes', 150), 90000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('plan expectations use questions only, with null when none remain', () => {
  assert.equal(planProgress(0, 0).expected, null);
  assert.equal(planProgress(0, 1).expected, 1);
});

test('estimates are numeric half minutes, at least one minute', () => {
  assert.equal(estimate([{ ms: 1000 }]), 60000);
  assert.equal(estimate([{ ms: 80000 }]), 90000);
});

test('plans scripted events: notes, materials, write, counts and latest; write does not regress', () => {
  const p = planProgress(42, 3);
  const scanner = new ItemScanner(['plans'], (_, item) => { p.written++; p.latest = item.label; });
  assert.equal(p.phase, 'notes'); assert.equal(p.expected, 3);
  updatePlanProgress(p, { type: 'tool_execution_start', toolName: 'read', args: { path: '/fictional/materials/guide.md' } }, scanner);
  assert.equal(p.phase, 'materials'); assert.deepEqual(p.materials, ['guide.md']);
  updatePlanProgress(p, { type: 'tool_execution_start', toolName: 'grep', args: { path: '/fictional/materials/guide.md' } }, scanner);
  updatePlanProgress(p, { type: 'tool_execution_end', toolName: 'fetch_content' }, scanner);
  updatePlanProgress(p, { type: 'tool_execution_end', toolName: 'calculate' }, scanner);
  updatePlanProgress(p, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"plans":[{"label":"Try the small sample"}]}' } }, scanner);
  assert.equal(p.phase, 'write'); assert.equal(p.written, 1); assert.equal(p.latest, 'Try the small sample');
  updatePlanProgress(p, { type: 'tool_execution_start', toolName: 'read', args: { path: 'table.csv' } }, scanner);
  assert.equal(p.phase, 'write'); assert.equal(p.pages, 1); assert.equal(p.checks, 1);
  assert.equal(planProgress(0, 10).expected, 8);
});
