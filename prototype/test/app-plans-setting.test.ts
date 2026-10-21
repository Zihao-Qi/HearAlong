import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const setting = app.slice(app.indexOf('const planSettingSaves ='), app.indexOf("$('export').href = meetingId", app.indexOf('const planSettingSaves =')));

test('a plan-setting save belongs to its project: switching projects and saving the second one cannot be overwritten by the first reply', async () => {
  const a = { id: 'A', name: 'A', planAfterNotes: false }, b = { id: 'B', name: 'B', planAfterNotes: false };
  const projectView = { project: a, projects: [a, b] };
  const box = { checked: false, setAttribute() {}, onchange: async () => {} };
  const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const errors: (string | null)[] = [];
  const context = {
    $: () => box, projectView, log() {}, inlineError: (_box: unknown, message: string | null) => errors.push(message),
    plansApi: { planAfterNotes: (p: typeof a) => p.planAfterNotes,
      setPlanAfterNotes: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
  };
  runInNewContext(`${setting}\nglobalThis.render = renderPlanSetting;`, context);
  const render = (context as typeof context & { render: () => void }).render;
  box.checked = true;
  const saveA = box.onchange();
  projectView.project = b; render();
  assert.equal(box.checked, false, 'B loads while A is saving');
  box.checked = true;
  const saveB = box.onchange();
  assert.equal(pending.length, 2, 'B can be saved independently');
  pending[0].resolve({ planAfterNotes: true });
  await saveA;
  assert.equal(a.planAfterNotes, true, 'A’s cached value is saved even while B is shown');
  assert.equal(box.checked, true, 'B’s pending value stays');
  pending[1].reject(new Error('B could not save'));
  await saveB;
  assert.equal(box.checked, false, 'B reverts to its own saved value, not A’s');
  assert.equal(errors.at(-1), 'B could not save');
  projectView.project = a; render();
  assert.equal(box.checked, true);
});

test('a failed save in a project no longer shown cannot put an error beside another project’s setting', async () => {
  const a = { id: 'A', name: 'A', planAfterNotes: false }, b = { id: 'B', name: 'B', planAfterNotes: true };
  const projectView = { project: a, projects: [a, b] };
  const box = { checked: true, setAttribute() {}, onchange: async () => {} };
  let reject!: (error: Error) => void;
  const errors: (string | null)[] = [];
  const context = { $: () => box, projectView, log() {}, inlineError: (_box: unknown, message: string | null) => errors.push(message),
    plansApi: { planAfterNotes: (p: typeof a) => p.planAfterNotes, setPlanAfterNotes: () => new Promise((_resolve, r) => { reject = r; }) } };
  runInNewContext(setting, context);
  const save = box.onchange();
  projectView.project = b;
  reject(new Error('A could not save')); await save;
  assert.equal(box.checked, true);
  assert.deepEqual(errors, [null]);
});
