import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as prompts from '../src/plans/prompt.ts';
import { piTaskArgs } from '../src/pi-task.ts';

test('the JavaScript pass records version 1.9 with prompt version 1.8', () => {
  assert.equal(prompts.PLAN_PASS_VERSION, '1.9'); assert.equal(prompts.PLAN_PROMPT_VERSION, '1.8');
  assert.equal(createHash('sha256').update(prompts.PLAN_PROMPT).digest('hex'), prompts.PLAN_PROMPT_SHA256);
});
for (const name of ['PLAN_STAGE1', 'PLAN_STAGE2', 'PLAN_STAGE2_FALLBACK'] as const) test(`${name} is frozen with its own sha256`, () => {
  assert.equal(createHash('sha256').update(prompts[name]).digest('hex'), prompts[`${name}_SHA256`]);
});
test('stage 2 substitutes only the outline number in the frozen template', () => {
  assert.equal(prompts.planStage2(3), prompts.PLAN_STAGE2.replaceAll('{i}', '3'));
});
test('continuation replaces session flags, not tools, thinking, extensions or model', () => {
  const opts = { model: 'fiction/model', cwd: '.', tools: 'read,calculate', readRoots: [], extensions: ['extension.ts'], thinking: 'low' as const };
  const a = piTaskArgs('read', { ...opts, sessionDir: 'stage1' });
  const b = piTaskArgs('write', { ...opts, session: 'copy.jsonl', sessionDir: 'ignored' });
  assert.deepEqual(a.slice(0, a.indexOf('--session-dir')), b.slice(0, b.indexOf('--session')));
  assert.deepEqual(b.slice(b.indexOf('--session')), ['--session', 'copy.jsonl', '--', 'write']);
});
