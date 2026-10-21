import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';
import { Memory, type Item } from '../src/memory.ts';
import { Proposals, plan, sourcesFromNotes, lostMarks } from '../src/proposals.ts';
import type { NoteItem, NotesRecord } from '../src/notes.ts';
import { Cooldowns, QUOTA } from '../src/quota.ts';

const P = 'project-1';
const note = (section: NoteItem['section'], text: string, cite: string, owner: string | null = null): NoteItem =>
  ({ section, text, cites: [cite], startMs: 1000, quote: text.split(' ').slice(0, 4).join(' '), quoteIn: 'corrected', owner });
function notes(meetingId: string, version: number, items: NoteItem[]): NotesRecord {
  const sources = Object.fromEntries(items.flatMap(i => i.cites).map((c, n) => [c, { startMs: 1000 * n, endMs: 1000 * n + 900, text: `line ${c}`, originalText: `line ${c}`, revision: 0 }]));
  const by = (s: string) => items.filter(i => i.section === s);
  return { version, createdAt: 1, model: 'test', meetingId, title: 'M', input: { inputHash: `h${version}`, coverage: { untilMs: 0, chunks: 0, pendingChunks: 0, gaps: [], uncorrected: 0 }, glossaryVersion: null, segments: items.length, takenAt: 0 },
    notes: { suggestedTitle: null, summary: [], decisions: by('decisions'), actions: by('actions'), openQuestions: by('openQuestions'), otherMatters: [], needsReview: [], otherTalk: [] }, sources, dropped: [] };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-proposals-'));
  const store = new MeetingStore(directory);
  let now = 1000;
  const memory = new Memory(store, () => now++);
  const answers: unknown[] = [];
  const calls: string[] = [];
  const notesBy = new Map<string, NotesRecord>();
  const proposals = new Proposals(store, memory, { directory, clock: () => now++, notesFor: async id => notesBy.get(id) ?? null, projectOf: () => P,
    runner: async ({ inputPath }) => { calls.push(inputPath); return { text: JSON.stringify(answers.shift()) } as any; } });
  const run = async (meetingId: string) => { await proposals.start(meetingId); while (proposals.busy(meetingId)) await new Promise(r => setTimeout(r, 5)); return proposals.run(meetingId)!; };
  return { store, memory, proposals, answers, calls, notesBy, run, async close() { await proposals.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const seed = (memory: Memory, texts: [string, string][]) => memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: texts.map(([type, text]) => ({ op: 'create' as const, type: type as Item['type'], text, source: { kind: 'app' as const } })) });

test('chat and agent notes can propose superseding a decision', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['decision', 'Store the painted miniatures in the glass cabinet']]);
    const text = 'Use foam trays for the painted miniatures instead.';
    const runner = async () => ({ text: JSON.stringify({ results: [{ source: 'S1', changes: [{ kind: 'update', target: 'D-1', sure: true, supersede: true }] }] }) });
    const chat = await f.proposals.interpret(P, text, runner as any);
    const agent = await f.proposals.interpretNotes(P, [{ text, source: { kind: 'agent', note: text } }], runner as any);
    for (const result of [chat, agent]) {
      assert.deepEqual(result.dropped, []);
      assert.equal(result.plans.length, 1);
      assert.equal(result.plans[0].lane, 'ok');
      assert.deepEqual(result.plans[0].changes.map(c => c.op), ['create', 'supersede']);
    }
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: chat.plans[0].changes });
    assert.equal(f.memory.item(P, 'D-1')!.fields.supersededBy, 'D-2');
  } finally { await f.close(); }
});

test('over-long chat and agent replacement decisions are dropped without losing a final condition', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['decision', 'Store the painted miniatures in the glass cabinet']]);
    const condition = 'Only after the foam adhesive has cured.';
    const text = `${'Use foam trays for the painted miniatures. '.repeat(18)}${condition}`;
    assert.ok(text.length > 600 && text.length <= 1000, 'a valid chat input exceeds the item limit');
    assert.ok(text.indexOf(condition) > 600, 'clipping would lose the final condition');
    const runner = async () => ({ text: JSON.stringify({ results: [{ source: 'S1', changes: [{ kind: 'update', target: 'D-1', sure: true, supersede: true }] }] }) });
    const chat = await f.proposals.interpret(P, text, runner as any);
    const agent = await f.proposals.interpretNotes(P, [{ text, source: { kind: 'agent', note: text } }], runner as any);
    for (const result of [chat, agent]) {
      assert.deepEqual(result.plans, [], 'an over-long replacement must not be offered for acceptance');
      assert.equal(result.dropped.length, 1);
      assert.match(result.dropped[0], /replacement.*600 characters/i);
    }
    assert.equal(f.memory.item(P, 'D-1')!.status, 'in force');
    assert.equal(f.memory.item(P, 'D-2'), undefined);
  } finally { await f.close(); }
});

test('brief rewrites receive recorded answers, owners and conditions after changes', async () => {
  const f = await fixture();
  let proposals: Proposals | undefined;
  try {
    seed(f.memory, [['question', 'Which token trays?'], ['todo', 'Label the drawers'], ['decision', 'Use felt liners']]);
    f.memory.saveBrief(P, 'Sorting the club cupboard.', 'user', { kind: 'app' }, null);
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [
      { op: 'answer', item: 'Q-1', text: 'Use the cork trays.', source: { kind: 'app' } },
      { op: 'edit', item: 'T-1', owner: 'Tamsin', source: { kind: 'app' } },
      { op: 'edit', item: 'D-1', fields: { conditions: 'only for dry pieces' }, source: { kind: 'app' } },
    ] });
    let input = '';
    proposals = new Proposals(f.store, f.memory, { directory: f.store.directory, clock: () => 10_000, projectOf: () => P,
      notesFor: async () => notes('m1', 1, [note('actions', 'Nothing else to record.', 'a')]),
      runner: async () => ({ text: '{"results":[{"source":"S1","changes":[{"kind":"skip"}]}]}' }) as any,
      briefRunner: async ({ inputPath }) => { input = await readFile(inputPath, 'utf8'); return { text: '{"brief":"Updated."}' } as any; } });
    await proposals.start('m1');
    while (proposals.busy('m1')) await new Promise(r => setTimeout(r, 5));
    assert.equal(proposals.run('m1')!.state, 'done');
    assert.match(input, /Q-1 answer: Which token trays\? · owner: — · answer: Use the cork trays\./);
    assert.match(input, /T-1 edit: Label the drawers · owner: Tamsin/);
    assert.match(input, /D-1 edit: Use felt liners · owner: — · conditions: only for dry pieces/);
    assert.equal(f.memory.brief(P)!.text, 'Updated.');
  } finally { await proposals?.close(); await f.close(); }
});

test('the split: sure additions are automatic; unsure, closed, duplicate, conditional and changed meaning wait for an OK', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['todo', 'Ask Tamsin where the club keeps the spare padlock keys'], ['question', 'Can the blue cupboard hold the large game boxes?'],
      ['todo', 'Pack 12 blank scorecards into each demo kit'], ['decision', 'Keep the wooden tokens in the blue cupboard']]);
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'status', item: 'T-1', to: 'done', source: { kind: 'app' } }] });
    const items = f.memory.items(P);
    // Sources are numbered by section: decisions, then actions, then open questions.
    const record = notes('m2', 1, [
      note('decisions', 'If the lids fit, stack the green token trays.', 'f'),
      note('decisions', 'Move the wooden tokens to the rolling trolley.', 'h'),
      note('actions', 'Attach felt pads to the demo boards.', 'a'),
      note('actions', 'Pack 48 blank scorecards into each demo kit.', 'd'),
      note('actions', 'Ask Tamsin about the spare padlock keys again.', 'e'),
      note('actions', 'Keep the wooden tokens in the blue cupboard and count them.', 'g'),
      note('openQuestions', 'Can the blue cupboard hold our large game boxes?', 'b'),
      note('openQuestions', 'Where can the large game boxes be stored?', 'c'),
    ]);
    const sources = sourcesFromNotes(record);
    const { plans, dropped } = plan({ results: [
      { source: 'S1', changes: [{ kind: 'new' }] },
      { source: 'S2', changes: [{ kind: 'update', target: 'D-1', sure: true, supersede: true }, { kind: 'update', target: 'T-99', status: 'done' }] },
      { source: 'S3', changes: [{ kind: 'new' }] },
      { source: 'S4', changes: [{ kind: 'same', target: 'T-2', sure: true }] },
      { source: 'S5', changes: [{ kind: 'same', target: 'T-1', sure: true }] },
      { source: 'S6', changes: [{ kind: 'new' }] },
      { source: 'S7', changes: [{ kind: 'same', target: 'Q-1', sure: true }] },
      { source: 'S8', changes: [{ kind: 'same', target: 'Q-1', sure: false, reason: 'related, not the same' }] },
    ] }, sources, items);
    assert.deepEqual(plans.map(p => [p.kind, p.lane]), [['new', 'ok'], ['update', 'ok'], ['new', 'auto'], ['same', 'ok'], ['same', 'ok'], ['new', 'auto'], ['same', 'auto'], ['same', 'ok']]);
    assert.match(plans[0].flags.join(), /conditional/);
    assert.match(plans[3].flags.join(), /48/, 'a number the target lacks');
    assert.match(plans[4].flags.join(), /T-1 is done/);
    assert.equal(plans[5].flags.length, 0, 'a to-do resembling a decision is not a duplicate across types');
    assert.deepEqual(plans[7].flags, ['AI unsure']);
    assert.equal(dropped.length, 1, 'an unknown target is dropped, not shown');
    assert.deepEqual(lostMarks('Do not sleeve cards if damp', 'Sleeve cards'), ['<negation>', '<condition>']);
  } finally { await f.close(); }
});

test('a run records sure additions as separate unconfirmed batches, keeps the rest pending, and reruns remember everything', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['todo', 'Ask Tamsin where the club keeps the spare padlock keys']]);
    f.notesBy.set('m2', notes('m2', 1, [note('actions', 'Clean the felt-lined dice trays.', 'a'), note('actions', 'Ask Tamsin where the spare padlock keys are kept.', 'b'),
      note('openQuestions', 'Will the folding tables fit the larger playmats?', 'c'), note('actions', 'Count the wooden tokens.', 'd')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'new' }] }, { source: 'S2', changes: [{ kind: 'same', target: 'T-1', sure: true }] },
      { source: 'S3', changes: [{ kind: 'update', target: 'T-1', sure: true, status: 'done' }] }, { source: 'S4', changes: [{ kind: 'new' }] }] });
    const run = await f.run('m2');
    assert.equal(run.state, 'done', run.error ?? '');
    assert.deepEqual([run.summary!.auto, run.summary!.ok], [3, 1]);
    const items = f.memory.items(P);
    assert.deepEqual(items.map(i => [i.id, i.confirmed]), [['Q-1', false], ['T-1', true], ['T-2', false]], 'new items are unconfirmed; T-1 stays confirmed');
    const t1 = f.memory.timeline(P, 'T-1');
    assert.deepEqual([t1.at(-1)!.op, t1.at(-1)!.confirmed], ['addSource', false]);
    const batches = new Set(f.memory.events(P).filter(e => e.op !== 'create' || e.item !== 'T-1').map(e => e.batch));
    assert.equal(batches.size, 3, 'each automatic change has its own batch (its own Undo)');
    const [pending] = f.proposals.list(P);
    assert.equal(pending.summary, 'T-1 done · Ask Tamsin where the club keeps the spare padlock keys');
    // Undo one automatic item, reject the proposal: a rerun of the same notes calls no model and brings nothing back.
    const q = f.memory.events(P).find(e => e.item === 'Q-1')!;
    f.memory.undo(P, q.batch, randomUUID());
    f.proposals.undone(P, q.batch);
    f.proposals.reject(P, pending.id);
    const calls = f.calls.length;
    const again = await f.run('m2');
    assert.equal(f.calls.length, calls, 'nothing new to ask about');
    assert.deepEqual([again.summary!.auto, again.summary!.ok], [0, 0]);
    assert.equal(f.memory.item(P, 'Q-1')!.status, 'dropped');
    assert.equal(f.proposals.list(P).length, 0);
  } finally { await f.close(); }
});

test('accepting checks the versions the proposal saw; Change match applies the user\'s choice; Undo of a rejection', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['todo', 'Wash the dice trays'], ['todo', 'Ask Tamsin about spare padlocks']]);
    f.notesBy.set('m2', notes('m2', 1, [note('actions', 'The dice trays are washed.', 'a'), note('actions', 'Message Tamsin about the spare padlocks.', 'b')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'update', target: 'T-1', sure: true, status: 'done' }] },
      { source: 'S2', changes: [{ kind: 'same', target: 'T-1', sure: false }] }] });
    await f.run('m2');
    const [done, match] = f.proposals.list(P);
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'edit', item: 'T-1', text: 'Wash the dice trays again', source: { kind: 'app' } }] });
    assert.throws(() => f.proposals.accept(P, done.id, { requestId: randomUUID() }), (e: any) => e.status === 409 && e.stale === 'T-1');
    assert.equal(f.proposals.get(P, done.id).status, 'pending', 'still waiting, shown as changed since proposed');
    f.proposals.accept(P, done.id, { requestId: randomUUID(), expect: { 'T-1': f.memory.item(P, 'T-1')!.version } });
    assert.equal(f.memory.item(P, 'T-1')!.status, 'done');
    // Change match: the user picks T-2 instead; the change is recorded as theirs, confirmed, with the meeting as source.
    f.proposals.accept(P, match.id, { requestId: randomUUID(), changes: [{ op: 'addSource', item: 'T-2', source: { kind: 'app' } }], expect: {} });
    const attach = f.memory.timeline(P, 'T-2').at(-1)!;
    assert.deepEqual([attach.op, attach.confirmed, attach.source?.kind, attach.actor], ['addSource', true, 'meeting', 'user']);
    assert.throws(() => f.proposals.accept(P, match.id, { requestId: randomUUID() }), /already accepted/);
  } finally { await f.close(); }
});

test('links and confirmations never make a proposal stale; Undo of an Accept brings it back; regenerated notes take back what only they gave', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['todo', 'Ask Tamsin where the club keeps the spare padlock keys']]);
    f.notesBy.set('m2', notes('m2', 1, [note('actions', 'Ask Tamsin where the spare padlock keys are kept.', 'a'), note('actions', 'Tamsin has identified the spare key drawer.', 'b'),
      note('actions', 'Count the wooden tokens.', 'c')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'same', target: 'T-1', sure: true }] }, { source: 'S2', changes: [{ kind: 'update', target: 'T-1', sure: true, status: 'done' }] },
      { source: 'S3', changes: [{ kind: 'new' }] }] });
    await f.run('m2');
    const [done] = f.proposals.list(P);
    // The same run recorded "raised again" on T-1, and the user confirms what is new: the waiting change is not stale.
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'confirm', item: 'T-2' }] });
    const accepted = f.proposals.accept(P, done.id, { requestId: randomUUID() });
    assert.equal(f.memory.item(P, 'T-1')!.status, 'done');
    // Undo of an Accept: the change waits for an OK again, seen against T-1 as it is now.
    f.memory.undo(P, accepted.batch, randomUUID());
    assert.deepEqual(f.proposals.undone(P, accepted.batch), { reopened: done.id });
    assert.equal(f.proposals.get(P, done.id).status, 'pending');
    f.proposals.accept(P, done.id, { requestId: randomUUID() });
    // Regenerated notes: the link came only from a note that is gone and is still unconfirmed, so it is taken back; T-2 was confirmed and stays.
    f.notesBy.set('m2', notes('m2', 2, [note('actions', 'Tamsin has identified the spare key drawer.', 'b'), note('actions', 'Cut felt liners for the token trays.', 'd')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'new' }] }] }); // only the new note is asked about
    const rerun = await f.run('m2');
    assert.equal(rerun.summary!.retracted, 1);
    assert.equal(f.memory.timeline(P, 'T-1').find(e => e.op === 'addSource')!.undone, true);
    assert.deepEqual(f.memory.items(P).map(i => [i.id, i.status]), [['T-1', 'done'], ['T-2', 'open'], ['T-3', 'open']]);
    // Moving the meeting away withdraws what it still has waiting.
    f.notesBy.set('m2', notes('m2', 3, [note('actions', 'Tamsin has identified the spare key drawer.', 'b'), note('actions', 'Cut felt liners for the token trays.', 'd'), note('actions', 'The wooden tokens are counted.', 'e')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'update', target: 'T-2', sure: true, status: 'done' }] }] });
    await f.run('m2');
    assert.equal(f.proposals.list(P).length, 1);
    f.proposals.withdrawMeeting('m2');
    assert.equal(f.proposals.list(P).length, 0);
  } finally { await f.close(); }
});

test('signs and owners are protected; impossible status changes are dropped, not shown', () => {
  assert.deepEqual(lostMarks('Set the frost tile penalty to -8 coins', 'Set the frost tile penalty to +8 coins'), ['-8']);
  assert.deepEqual(lostMarks('Keep paint water at < 23 degrees', 'Keep paint water at 23 degrees'), ['<23']);
  const items: Item[] = [
    { project: P, id: 'T-1', type: 'todo', status: 'open', text: 'Wash the dice trays', owner: 'Tamsin', fields: {}, confirmed: true, mergedInto: null, version: 1, createdAt: 0, updatedAt: 0 },
    { project: P, id: 'D-1', type: 'decision', status: 'in force', text: 'Keep the wooden tokens in the blue cupboard', owner: null, fields: {}, confirmed: true, mergedInto: null, version: 1, createdAt: 0, updatedAt: 0 },
    { project: P, id: 'Q-1', type: 'question', status: 'open', text: 'Will cork trays fit the drawer?', owner: null, fields: {}, confirmed: true, mergedInto: null, version: 1, createdAt: 0, updatedAt: 0 },
  ];
  const sources = sourcesFromNotes(notes('m2', 1, [note('actions', 'Wash the dice trays.', 'a', 'Oona'), note('actions', 'The wooden tokens stay in the blue cupboard.', 'b')]));
  const { plans, dropped } = plan({ results: [{ source: 'S1', changes: [{ kind: 'same', target: 'T-1', sure: true }] },
    { source: 'S2', changes: [{ kind: 'update', target: 'D-1', sure: true, status: 'done' }, { kind: 'update', target: 'Q-1', sure: true, status: 'answered' }] }] }, sources, items);
  assert.deepEqual([plans[0].lane, plans[0].flags], ['ok', ['owner Oona here, Tamsin on T-1']]);
  assert.equal(plans.length, 1);
  assert.equal(dropped.length, 2, 'a decision is never "done"; a question is answered with its answer, not a bare status');
});

test('regenerated notes: a flagged match still waits for an OK; an item another meeting raised again stays; every effect of a gone note is taken back', async () => {
  const f = await fixture();
  try {
    // Meeting m1 recorded T-1 automatically; meeting m3 raised it again. Regenerating m1 must not drop it.
    f.notesBy.set('m1', notes('m1', 1, [note('actions', 'Pack 12 blank scorecards into each demo kit.', 'a'), note('actions', 'Count the wooden tokens.', 'b')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'new' }] }, { source: 'S2', changes: [{ kind: 'new' }] }] });
    await f.run('m1');
    f.notesBy.set('m3', notes('m3', 1, [note('actions', 'Count the wooden tokens again.', 'c')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'same', target: 'T-2', sure: true }] }] });
    await f.run('m3');
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'confirm', item: 'T-1' }] });
    // Regenerated m1: "12" became "48" (the model wrongly says same as T-1), and "Count the wooden tokens" is gone.
    f.notesBy.set('m1', notes('m1', 2, [note('actions', 'Pack 48 blank scorecards into each demo kit.', 'a')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'same', target: 'T-1', sure: true }] }] });
    const rerun = await f.run('m1');
    assert.equal(rerun.summary!.retracted, 0, 'T-2 is also supported by m3, so it stays');
    assert.equal(f.memory.item(P, 'T-2')!.status, 'open');
    const [flagged] = f.proposals.list(P);
    assert.match(flagged.flags.join(), /48/, 'the changed number waits for the user even though T-1 already has a source from m1');
    // One note, two effects: an automatic link and a change waiting for an OK. Rejecting the change keeps the link's record,
    // so when the note goes, the link is taken back too.
    f.notesBy.set('m4', notes('m4', 1, [note('actions', 'Tokens counted; count them again after club night.', 'd')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'same', target: 'T-2', sure: true }, { kind: 'update', target: 'T-2', sure: false, status: 'done' }] }] });
    await f.run('m4');
    const update = f.proposals.list(P).find(p => p.meetingId === 'm4')!;
    f.proposals.reject(P, update.id);
    f.notesBy.set('m4', notes('m4', 2, []));
    assert.equal((await f.run('m4')).summary!.retracted, 1);
    assert.equal(f.memory.timeline(P, 'T-2').filter(e => e.op === 'addSource' && !e.undone).length, 1, 'only m3\'s link is left');
  } finally { await f.close(); }
});

test('notes rewritten during a run: nothing from the old notes is recorded, and memory updates again from the new ones', async () => {
  const f = await fixture();
  try {
    f.notesBy.set('m2', notes('m2', 1, [note('actions', 'Old note.', 'a')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'new' }] }] });
    // The model call saves newer notes before it answers (as a regeneration finishing meanwhile would).
    const runner = (f.proposals as any).options.runner;
    (f.proposals as any).options.runner = async (input: any) => { f.notesBy.set('m2', notes('m2', 2, [note('actions', 'New note.', 'b')])); (f.proposals as any).options.runner = runner; return runner(input); };
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'new' }] }] });
    await f.proposals.start('m2');
    for (let i = 0; i < 200 && (f.proposals.busy('m2') || f.proposals.run('m2')?.state !== 'done'); i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(f.memory.items(P).map(i => i.text), ['New note.']);
  } finally { await f.close(); }
});

test('Accept all is all or nothing; a meeting\'s run is looked up per project; recent user changes are listed for Undo', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['todo', 'Wash the dice trays'], ['todo', 'Ask Tamsin about spare padlocks']]);
    const base = { source: { kind: 'file' as const, file: 'todos.md' }, sourceText: 'x', section: null, kind: 'update' as const, lane: 'ok' as const, flags: [], alternatives: [], reason: '' };
    f.proposals.propose(P, 'capture:c1', [
      { ...base, key: 'k1', changes: [{ op: 'status', item: 'T-1', to: 'done', source: base.source }], targets: { 'T-1': 1 }, summary: 'T-1 done' },
      { ...base, key: 'k2', changes: [{ op: 'status', item: 'T-2', to: 'done', source: base.source }], targets: { 'T-2': 1 }, summary: 'T-2 done' },
    ] as any, { capture: 'c1' });
    const [a, b] = f.proposals.list(P);
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'edit', item: 'T-2', text: 'Ask Tamsin for the padlock serial numbers', source: { kind: 'app' } }] });
    assert.throws(() => f.proposals.acceptAll(P, [{ id: a.id }, { id: b.id }], 'r1'), /changed since/);
    assert.deepEqual([f.memory.item(P, 'T-1')!.status, f.proposals.get(P, a.id).status], ['open', 'pending'], 'nothing applied when one fails');
    const batches = f.proposals.acceptAll(P, [{ id: a.id }, { id: b.id, expect: { 'T-2': f.memory.item(P, 'T-2')!.version } }], 'r2');
    assert.equal(Object.keys(batches).length, 2);
    assert.deepEqual(f.memory.items(P).map(i => i.status), ['done', 'done']);
    // The user's own edit is listed for its Undo window; accepted proposals (they have their row's Undo) are not.
    const recent = f.memory.recentUserChanges(P, 0, new Set(Object.values(batches)));
    assert.ok(recent.some(r => r.items.some(i => i.id === 'T-2')), 'the edit of T-2');
    assert.ok(!recent.some(r => Object.values(batches).includes(r.batch)));
    // Runs per project: a meeting moved to another project has no run there yet.
    f.notesBy.set('m2', notes('m2', 1, [note('actions', 'Count the wooden tokens.', 'a')]));
    f.answers.push({ results: [{ source: 'S1', changes: [{ kind: 'new' }] }] });
    await f.run('m2');
    assert.equal(f.proposals.run('m2', P)!.state, 'done');
    assert.equal(f.proposals.run('m2', 'another-project'), null);
  } finally { await f.close(); }
});

test('a target changed during the run, or a duplicate recorded meanwhile, sends an automatic change to the user', async () => {
  const f = await fixture();
  try {
    seed(f.memory, [['todo', 'Ask Tamsin about spare padlocks']]);
    const record = notes('m2', 1, [note('actions', 'Ask Tamsin about the spare cupboard padlocks.', 'a'), note('actions', 'Cut felt liners for the token trays.', 'b')]);
    const sources = sourcesFromNotes(record);
    const items = f.memory.items(P);
    const { plans } = plan({ results: [{ source: 'S1', changes: [{ kind: 'same', target: 'T-1', sure: true }] }, { source: 'S2', changes: [{ kind: 'new' }] }] }, sources, items);
    assert.deepEqual(plans.map(p => p.lane), ['auto', 'auto']);
    f.memory.apply(P, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'edit', item: 'T-1', text: 'Ask Tamsin about the padlock serial numbers', source: { kind: 'app' } },
      { op: 'create', type: 'todo', text: 'Cut felt liners for token trays', source: { kind: 'app' } }] });
    const outcome = f.proposals.publish(P, 'm2', 'run-1', plans, new Set(sources.map(s => s.key)));
    assert.deepEqual([outcome.auto, outcome.ok], [0, 2]);
    assert.deepEqual(f.proposals.list(P).map(p => p.flags.at(-1)), ['T-1 changed during the run', 'possible duplicate of T-2']);
  } finally { await f.close(); }
});

test('server: notes for a meeting in a project start a memory run; Tell the project interprets and applies', async () => {
  const { startServer } = await import('../src/server.ts');
  const directory = await mkdtemp(join(tmpdir(), 'meeting-proposals-server-'));
  const prompts: string[] = [];
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null,
    notes: async ({ instructions }) => {
      prompts.push(instructions.slice(0, 40));
      if (instructions.startsWith('You keep a research project')) {
        return { text: JSON.stringify(prompts.filter(p => p.startsWith('You keep')).length === 1
          ? { results: [{ source: 'S1', changes: [{ kind: 'new' }] }, { source: 'S2', changes: [{ kind: 'new' }] }] }
          : { results: [{ source: 'S1', changes: [{ kind: 'update', target: 'T-1', sure: true, status: 'done' }] }] }) } as any;
      }
      if (instructions.startsWith('Rewrite the project brief')) return { text: JSON.stringify({ brief: 'The club is locating spare card sleeves.' }) } as any;
      return { text: JSON.stringify({ actions: [{ text: 'Check which cupboard holds spare card sleeves.', cites: ['S1'], quote: 'Check which cupboard holds spare card sleeves' }],
        openQuestions: [{ text: 'Can the new playmats fit on the folding tables?', cites: ['S2'], quote: 'Can the new playmats fit on the folding tables' }] }) } as any;
    } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, method = 'GET', body?: unknown) => fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const meeting = app.store.createMeeting('Tabletop club supplies');
    for (const [i, line] of ['Check which cupboard holds spare card sleeves.', 'Can the new playmats fit on the folding tables?'].entries()) {
      const chunk = await app.store.addPcm(meeting.id, 'mic:t', i, i * 20_000, 16000, Buffer.alloc(16000 * 4, i + 1));
      app.store.completeChunk(chunk.id, { text: line, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' } as any);
    }
    const project = await (await call('/api/projects', 'POST', { name: 'Tabletop cupboard', fromMeetingId: meeting.id })).json();
    assert.equal((await call(`/api/meetings/${meeting.id}/notes`, 'POST')).status, 202);
    const settled = async () => { for (let i = 0; i < 200; i++) { const r = (await (await call(`/api/meetings/${meeting.id}/memory/run`)).json()).run; if (r && r.state !== 'running') return r; await new Promise(r => setTimeout(r, 10)); } throw new Error('no run'); };
    const run = await settled();
    assert.equal(run.state, 'done', run.error ?? '');
    const memory = await (await call(`/api/projects/${project.id}/memory`)).json();
    assert.deepEqual(memory.items.map((i: any) => [i.id, i.confirmed]), [['Q-1', false], ['T-1', false]]);
    assert.equal(memory.brief.text, 'The club is locating spare card sleeves.');
    // "Tell the project…": interpreted (nothing written), then applied as the user's own change with the sentence as source.
    const told = await (await call(`/api/projects/${project.id}/tell`, 'POST', { text: 'I found the sleeves in cupboard C.' })).json();
    assert.equal(told.plans[0].summary, 'T-1 done · Check which cupboard holds spare card sleeves.');
    assert.equal((await (await call(`/api/projects/${project.id}/memory`)).json()).items.find((i: any) => i.id === 'T-1').status, 'open');
    const applied = await call(`/api/projects/${project.id}/tell/apply`, 'POST', { requestId: 'tell-1', text: 'I found the sleeves in cupboard C.', changes: told.plans[0].changes, expect: told.plans[0].targets });
    assert.equal(applied.status, 200);
    const t1 = await (await call(`/api/projects/${project.id}/memory/items/T-1`)).json();
    assert.deepEqual([t1.item.status, t1.timeline.at(-1).source], ['done', { kind: 'chat', text: 'I found the sleeves in cupboard C.' }]);
    const moved = await call(`/api/meetings/${meeting.id}/project`, 'POST', { projectId: null });
    assert.equal(moved.status, 200, 'nothing running any more');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('memory updates wait behind the shared quota cooldown, and a rate limit of the brief rewrite reaches it too', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-proposals-quota-'));
  const store = new MeetingStore(directory);
  QUOTA.pollMs = 20;
  let now = Date.now();
  const cooldowns = new Cooldowns(() => now);
  const calls: string[] = [];
  const record = notes('m1', 1, [note('actions', 'Pack 48 blank scorecards into each demo kit.', 'a')]);
  const proposals = new Proposals(store, new Memory(store, () => now), { directory, clock: () => now, notesFor: async () => record, projectOf: () => P, cooldowns,
    runner: async () => { calls.push('proposals'); return { text: JSON.stringify({ results: [{ source: 'S1', changes: [{ kind: 'new', sure: true }] }] }) }; },
    briefRunner: async () => { calls.push('brief'); throw new Error('Pi task error: You have hit your usage limit (429).'); } });
  try {
    cooldowns.hit('model', 'actions');
    await proposals.start('m1');
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(calls, [], 'no model call while the quota is out');
    assert.ok(proposals.busy('m1'), 'the update waits (a move waits for it)');
    now += 6 * 60_000;
    while (proposals.busy('m1')) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(calls, ['proposals', 'brief']);
    const run = proposals.run('m1')!;
    assert.equal(run.state, 'done', 'the run goes on without a new brief');
    assert.match(String(run.summary?.brief), /not updated: .*usage limit/);
    assert.ok(cooldowns.pausedUntil('model'), "the brief's rate limit started a new cooldown");
  } finally { QUOTA.pollMs = 1000; await proposals.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
