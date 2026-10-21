import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Run the actual form handler without a browser or unrelated page initialization.
const handler = app.slice(app.indexOf("$('tell-form').onsubmit"), app.indexOf('// Memory ids in answers'));

class Element {
  tag: string;
  textContent: string;
  className: string;
  children: Element[] = [];
  hidden = true;
  value = '';
  focused = false;
  onclick?: () => Promise<void> | void;
  onsubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  constructor(tag: string, text = '', className = '') {
    this.tag = tag;
    this.textContent = text;
    this.className = className;
  }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  focus() { this.focused = true; }
}

type TellResult = {
  plans: { summary: string; flags: string[]; changes: object[]; targets: Record<string, number> }[];
  dropped?: string[];
};

function fixture(result: TellResult) {
  const elements: Record<string, Element> = {
    'tell-form': new Element('form'), 'tell-input': new Element('input'), 'tell-result': new Element('div'),
  };
  elements['tell-input'].value = 'Mark the task done and replace the decision.';
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const ownership = app.slice(app.indexOf('let projectEpoch ='), app.indexOf('async function loadProjects'));
  runInNewContext(ownership + handler, {
    $: (id: string) => elements[id],
    el: (tag: string, text?: string, className?: string) => new Element(tag, text, className),
    guarded: (fn: unknown) => fn,
    projectView: { project: { id: 'project-1' }, tell: null },
    projectBase: () => '/api/projects/project-1', requestId: () => 'tell-1',
    post: async (url: string, body: Record<string, unknown>) => {
      calls.push({ url, body });
      return url.endsWith('/tell') ? result : {};
    },
    send: async () => {}, api: async () => ({}),
    noteRecent: () => {}, refreshProject: async () => {},
  });
  return {
    box: elements['tell-result'], input: elements['tell-input'], calls,
    submit: () => elements['tell-form'].onsubmit!({ preventDefault() {} }),
  };
}

const reasons = [
  'S1: a replacement decision must be at most 600 characters',
  '0123456789abcdef0123456789abcdef: Q-2 is not an open question',
];
const displayedReasons = [
  'Not applied: a replacement decision must be at most 600 characters',
  'Not applied: Q-2 is not an open question',
];

test('Tell the project shows dropped reasons below valid changes and applies only those changes', async () => {
  const plan = {
    summary: 'T-1 done', flags: ['AI unsure'],
    changes: [{ op: 'status', item: 'T-1', to: 'done' }], targets: { 'T-1': 2 },
  };
  const f = fixture({ plans: [plan], dropped: reasons });
  await f.submit();
  assert.equal(f.box.hidden, false);
  assert.deepEqual(f.box.children.map(node => node.textContent), [
    'T-1 done (AI unsure)', ...displayedReasons, '',
  ]);
  assert.deepEqual(f.box.children.slice(1, -1).map(node => node.className), ['muted small', 'muted small']);
  const actions = f.box.children.at(-1)!;
  assert.deepEqual(actions.children.map(node => node.textContent), ['Apply', 'Change']);
  await actions.children[0].onclick!();
  assert.equal(f.calls[1].url, '/api/projects/project-1/tell/apply');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].body)), {
    requestId: 'tell-1', text: 'Mark the task done and replace the decision.',
    changes: plan.changes, expect: plan.targets,
  });
});

test('Tell the project explains all dropped changes instead of saying no changes were found', async () => {
  const f = fixture({ plans: [], dropped: reasons });
  await f.submit();
  assert.deepEqual(f.box.children.map(node => node.textContent), [...displayedReasons, '']);
  assert.deepEqual(f.box.children.slice(0, -1).map(node => node.className), ['muted small', 'muted small']);
  const actions = f.box.children.at(-1)!;
  assert.deepEqual(actions.children.map(node => node.textContent), ['Close']);
  assert.equal(actions.children[0].focused, true);
  await actions.children[0].onclick!();
  assert.equal(f.box.hidden, true);
  assert.equal(f.input.focused, true);
  assert.equal(f.calls.length, 1, 'no changes were applied');
});

test('Tell the project keeps the no-changes message when there are no dropped changes', async () => {
  for (const result of [{ plans: [], dropped: [] }, { plans: [] }]) {
    const f = fixture(result);
    await f.submit();
    assert.equal(f.box.children[0].textContent, 'No changes found in that note.');
    assert.deepEqual(f.box.children.at(-1)!.children.map(node => node.textContent), ['Close']);
  }
});
