// Mutation/retry and keyboard regressions from the M7b page reviews, in the real browser DOM with the projected fixtures.
import type { Page } from 'playwright-core';

export async function plansLifecycleCheck(page: Page): Promise<[string, boolean][]> {
  return page.evaluate(async () => {
    const module = '/plans.js', fixtures = '/plans-fixtures.js';
    const { createPlansView, plansMarkdown } = await import(module);
    const { fixturePlansApi } = await import(fixtures);
    const fixture = (name = 'plans') => fixturePlansApi(name, {}, { latency: false, quiet: true });
    const base = await fixture().getPlans();
    const host = document.createElement('section');
    host.className = 'plans';
    document.body.append(host);
    const checks: [string, boolean][] = [];
    const check = (name: string, ok: boolean) => checks.push([`lifecycle: ${name}`, ok]);
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
      throw new Error('The page action did not settle.');
    };
    let view: any, owner = 'A';
    const setup = async (api: any) => {
      view?.reset();
      view = createPlansView({ host, api, hooks: { meetingId: () => owner, meetingTitle: () => 'Test', visible: () => false, log() {} } });
      await view.refresh();
    };
    const row = () => host.querySelectorAll('.plan')[1];
    const add = () => (row().querySelector('.plan-add') as HTMLButtonElement).click();
    const undo = () => (row().querySelector('.plan-undo') as HTMLButtonElement).click();
    const now = Date.now;
    try {
      // A pending Add remains focusable, and its Undo/status replacements keep that focus.
      await setup(fixture());
      (row().querySelector('.plan-add') as HTMLButtonElement).focus();
      add();
      await until(() => Boolean(row().querySelector('.plan-undo')));
      check('Add hands keyboard focus to Undo', document.activeElement === row().querySelector('.plan-undo'));
      const oldRows = [...host.querySelectorAll('.plan-row')];
      Date.now = () => now() + 16_000;
      view.render();
      check('expired Undo hands focus to focusable text', document.activeElement?.textContent === 'In to-dos' && (document.activeElement as HTMLElement).tabIndex === -1);
      check('detached row handles explain the old height-check flake', oldRows.every(r => r.getBoundingClientRect().height === 0)
        && [...host.querySelectorAll('.plan-row')].every(r => r.getBoundingClientRect().height > 0));
      Date.now = now;

      // An old meeting's completion must not clear the new meeting's pending state or its retained operation id.
      const requests: any[] = [];
      await setup({ getPlans: async () => structuredClone(base), addTodo: (_m: string, _v: number, _s: string, op: any) => new Promise((resolve, reject) => requests.push({ op, resolve, reject })) });
      add();
      view.reset(); owner = 'B'; await view.refresh(); add();
      requests[0].resolve({ result: { created: true }, todo: { state: 'in to-dos', generation: 1, project: 'A', todo: 'T-old' } });
      await new Promise(r => setTimeout(r, 20));
      check('late Add cannot contaminate another meeting', Boolean(row().querySelector('[aria-busy="true"]')) && !row().querySelector('.plan-undo'));
      requests[1].reject(new Error('Lost reply'));
      await until(() => !row().querySelector('[aria-busy="true"]'));
      add();
      check('late completion cannot delete another meeting’s retry id', requests[1].op.opId === requests[2].op.opId);
      requests[2].reject(new Error('Still offline'));
      await until(() => !row().querySelector('[aria-busy="true"]'));

      // A committed Add reply lost, followed by Undo in another tab: a replay says what happened AND the state now.
      const api = fixture();
      let first = true, addOp: any;
      await setup({ ...api, addTodo: async (...args: any[]) => {
        addOp = args;
        const result = await api.addTodo(...args);
        if (first) { first = false; await api.undoTodo(args[0], args[1], args[2], { opId: 'other-tab-undo', expect: result.todo.generation }); throw new Error('Lost reply'); }
        return result;
      } });
      add();
      await until(() => row().querySelector('.plan-add')?.textContent === 'Try again');
      add();
      await until(() => row().querySelector('.plan-add')?.textContent === 'Add to to-dos');
      check('historical Add replay never asserts current existence', !row().querySelector('.plan-done') && !row().querySelector('.plan-undo') && Boolean(addOp));

      // A lost Undo response keeps its id, even after the ordinary Undo window expires.
      const uapi = fixture(), ids: string[] = [];
      await setup({ ...uapi, undoTodo: async (...args: any[]) => {
        ids.push(args[3].opId);
        const result = await uapi.undoTodo(...args);
        if (ids.length === 1) throw new Error('Lost Undo reply');
        return result;
      } });
      add(); await until(() => Boolean(row().querySelector('.plan-undo')));
      undo(); await until(() => Boolean(host.querySelector('.plans-banner')));
      Date.now = () => now() + 16_000; view.render();
      check('unresolved Undo remains retryable after 15 seconds', Boolean(row().querySelector('.plan-undo')));
      undo(); await until(() => Boolean(row().querySelector('.plan-add')));
      check('Undo retries retain their operation id', ids.length === 2 && ids[0] === ids[1]);
      Date.now = now;

      // Explore's lost submission reply is retryable; after observing that run and then Cancel, a click is a new attempt.
      const eapi = fixture(), eids: string[] = [];
      await setup({ ...eapi, exploreFurther: async (...args: any[]) => { eids.push(args[3].opId); await eapi.exploreFurther(...args); throw new Error('Lost Explore reply'); } });
      (row().querySelector('.plan-chev') as HTMLButtonElement).click();
      (row().querySelector('.plan-explore button') as HTMLButtonElement).click();
      await until(() => Boolean(host.querySelector('.plans-banner')));
      await view.refresh();
      const run = view.data.run;
      await eapi.cancel('B', run.id); await view.refresh();
      (row().querySelector('.plan-explore button') as HTMLButtonElement).click();
      await until(() => eids.length === 2);
      check('Explore after a known cancellation gets a new operation id', eids[0] !== eids[1]);
      await new Promise(r => setTimeout(r, 10));

      // The run is cancelled elsewhere before this page ever sees its submission.
      const unseen = fixture(), unseenIds: string[] = [];
      let unseenFinished = 0;
      await setup({ ...unseen, exploreFurther: async (...args: any[]) => {
        unseenIds.push(args[3].opId);
        const result = await unseen.exploreFurther(...args);
        await unseen.cancel(args[0], result.run.id);
        unseenFinished++;
        throw new Error('Lost reply before observing the run');
      } });
      (row().querySelector('.plan-chev') as HTMLButtonElement).click();
      (row().querySelector('.plan-explore button') as HTMLButtonElement).click();
      await until(() => Boolean(host.querySelector('.plans-banner')));
      // No refresh/poll before the next click: it must resolve the old submission's identity itself.
      (row().querySelector('.plan-explore button') as HTMLButtonElement).click();
      await until(() => unseenFinished === 2);
      check('Explore after an unobserved cancellation gets a new operation id', unseenIds[0] !== unseenIds[1]);
      await view.refresh();
      check('an unobserved cancelled run keeps its Stopped before the end summary', host.textContent!.includes('Stopped before the end'));

      // Hold the refresh: measure only renders after the authoritative Add response, not the pending-state render.
      let releaseAdd!: () => void, releaseRefresh!: () => void;
      const addGate = new Promise<void>(r => { releaseAdd = r; });
      const refreshGate = new Promise<void>(r => { releaseRefresh = r; });
      let local = structuredClone(base), loads = 0;
      await setup({ getPlans: async () => { if (++loads > 1) await refreshGate; return structuredClone(local); },
        addTodo: async () => {
          await addGate;
          const todo = { state: 'in to-dos', generation: 1, project: local.project.id, todo: 'T-new' };
          local.current.plans[1].steps[0].todo = todo;
          return { result: { created: true }, todo };
        } });
      add();
      const content = host.querySelector('.plans-content')!;
      let renders = 0;
      const observer = new MutationObserver(records => { renders += records.filter(r => r.target === content && r.type === 'childList').length; });
      observer.observe(content, { childList: true });
      try {
        releaseAdd();
        await until(() => loads === 2);
        const undoNode = row().querySelector('.plan-undo');
        releaseRefresh();
        await new Promise(r => setTimeout(r, 60));
        check('Add renders exactly once when its refresh returns unchanged data', renders === 1 && Boolean(undoNode?.isConnected));
      } finally { releaseAdd(); releaseRefresh(); observer.disconnect(); }

      let data = await fixture('newer').getPlans();
      await setup({ getPlans: async () => structuredClone(data) });
      (host.querySelector('[data-focus="show-kept"]') as HTMLButtonElement).click();
      data.kept = null; await view.refresh();
      check('a disappearing kept result returns to current plans', !host.querySelector('[data-focus="hide-kept"]') && Boolean(host.querySelector('.plan-add')));
      const mixed = (await fixture('mixed').getPlans()).current;
      check('Markdown annotates unchecked follow-ons and document diagnostics', plansMarkdown(mixed).includes('freeze batch norm in every later run _(unchecked:')
        && plansMarkdown(mixed).includes('A deferred item names no note'));
    } finally { Date.now = now; view?.reset(); host.remove(); }
    return checks;
  });
}
