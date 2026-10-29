import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { checkPlans } from '../src/plans/validate.ts';
import { PLAN_PROMPT, EXPLORE_PROMPT } from '../src/plans/prompt.ts';
import { PINS, fixture, pythonResult, rawPlan, tool } from './plans-fixture.ts';
// @ts-expect-error browser fixture module
import { STATES } from '../public/plans-fixtures-data.js';

const source = (await readFile(new URL('../public/plans.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
const render = (doc: any): string => runInNewContext(source + '\nplansMarkdown(doc)', { doc, stamp: (ms: number) => String(ms) });

test('calculate evidence records JavaScript and keeps the script and output in the checked plan', async () => {
  const f = await fixture();
  try {
    await f.evidence.record(tool('calculate', { code: 'console.log(6 * 7)' }, '42', { details: { runNumber: 1, stdout: '42\n', stderr: '', status: 'exit 0' } }));
    const saved = await f.evidence.read(), item = saved.items[0];
    assert.equal(item.tool, 'calc');
    assert.ok(item.tool === 'calc' && item.language === 'javascript');
    const checked = checkPlans({ plans: [rawPlan({ checks: [{ id: 'c1', run: 1, showed: 'Forty-two units' }, { id: 'c2', run: 2, showed: 'Missing run' }] })] }, { run: 'r1', refs: f.input.refs, evidence: saved, pins: PINS });
    assert.deepEqual(checked.evidence['r1:c1'].result, { ok: true, script: 'console.log(6 * 7)', output: '42\n', status: 'exit 0', language: 'javascript' });
    assert.equal(checked.evidence['r1:c2'].result.reason, 'no calculate call 2 was recorded');
    const doc = structuredClone(STATES['no-project'].page.current);
    doc.evidence['r-5e1c:c1'].result = checked.evidence['r1:c1'].result;
    assert.match(render(doc), /```javascript\nconsole\.log\(6 \* 7\)\n```/);
    assert.match(render(doc), /42/);
  } finally { await f.close(); }
});

test('legacy saved Python evidence and the existing plan fixture still render without migration', async () => {
  const doc = structuredClone(STATES['no-project'].page.current);
  const before = structuredClone(doc);
  assert.match(render(doc), /```python\nimport soundfile/);
  assert.deepEqual(doc, before);
  const f = await fixture();
  try {
    await f.evidence.record(pythonResult(1));
    const checked = checkPlans({ plans: [rawPlan({ checks: [{ id: 'c1', run: 1, showed: 'One unit' }] })] }, { run: 'r1', refs: f.input.refs, evidence: await f.evidence.read(), pins: PINS });
    assert.deepEqual(checked.evidence['r1:c1'].result, { ok: true, script: 'print(1)', output: '1\n', status: 'exit 0' });
  } finally { await f.close(); }
});

test('plan and Explore prompts request JavaScript/mathjs; all launch paths have no Python preparation', async () => {
  for (const prompt of [PLAN_PROMPT, EXPLORE_PROMPT]) {
    assert.match(prompt, /calculate/); assert.match(prompt, /JavaScript.*mathjs/); assert.match(prompt, /IEEE doubles.*BigNumber or fractions/);
    assert.doesNotMatch(prompt, /run_python|numpy|scipy|sympy/);
  }
  for (const file of ['actions.ts', 'plans/jobs.ts', 'explorations.ts', 'server.ts']) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /ensurePython|pythonStatus|stopPython|computeReady|options\.python|Preparing the Python|python-env/);
  }
  const actions = await readFile(new URL('../src/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /case 'calculate': return 'Running a calculation'/);
});
