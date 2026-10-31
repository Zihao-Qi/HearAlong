import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';
import { Memory, type Change } from '../src/memory.ts';

const P = 'project-1';
const meeting = (index: number) => ({ kind: 'meeting' as const, meetingId: 'm1', section: 'actions', index, note: 'from the notes' });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-memory-'));
  const store = new MeetingStore(directory);
  let now = 1000;
  const memory = new Memory(store, () => now++);
  const apply = (changes: Change[], actor: 'ai' | 'user' = 'ai', expect?: Record<string, number>) => memory.apply(P, { requestId: randomUUID(), actor, changes, expect });
  return { store, memory, apply, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Undo refuses a create still used by an item the batch only linked', async () => {
  const f = await fixture();
  try {
    f.apply([{ op: 'create', type: 'todo', text: 'Existing', source: meeting(0) }]);
    const batch = f.apply([
      { op: 'create', type: 'todo', text: 'New', source: meeting(1) },
      { op: 'addSource', item: 'T-1', source: meeting(1) },
    ]);
    f.apply([{ op: 'merge', item: 'T-1', into: 'T-2', source: { kind: 'app' } }], 'user');
    assert.throws(() => f.memory.undo(P, batch.batch, randomUUID()), (e: any) => e.status === 409 && /T-2 is used by T-1/.test(e.message));
    assert.equal(f.memory.item(P, 'T-2')!.status, 'open');
    assert.deepEqual(f.memory.rebuild(P), f.memory.items(P));
  } finally { await f.close(); }
});

test('items get per-type ids; AI-recorded items are unconfirmed; the state equals a rebuild from the events', async () => {
  const f = await fixture();
  try {
    const result = f.apply([
      { op: 'create', type: 'todo', text: 'Replace the cracked feeding scoop', source: meeting(0) },
      { op: 'create', type: 'decision', text: 'Use amber lights during the evening feed', source: meeting(1) },
      { op: 'create', type: 'todo', text: '  Restock   quarantine gloves ', source: meeting(2) },
    ]);
    assert.deepEqual(Object.values(result.created), ['T-1', 'D-1', 'T-2']);
    const items = f.memory.items(P);
    assert.deepEqual(items.map(i => [i.id, i.status, i.confirmed, i.version]), [['D-1', 'in force', false, 1], ['T-1', 'open', false, 1], ['T-2', 'open', false, 1]]);
    assert.equal(f.memory.item(P, 'T-2')!.text, 'Restock quarantine gloves');
    const mine = f.apply([{ op: 'create', type: 'question', text: 'Is the spare pump rated for salt water?', source: { kind: 'app' } }], 'user');
    assert.equal(f.memory.item(P, mine.created['Q-1'])!.confirmed, true, 'the user\'s own items are confirmed');
    f.apply([{ op: 'status', item: 'T-1', to: 'done', source: { kind: 'chat', text: 'The new scoop is in the feeding cabinet' } }], 'user');
    assert.deepEqual(f.memory.rebuild(P), f.memory.items(P));
    assert.deepEqual(f.memory.timeline(P, 'T-1').map(e => e.op), ['create', 'status']);
  } finally { await f.close(); }
});

test('a stale view is refused and nothing is applied; a repeated request returns the first result', async () => {
  const f = await fixture();
  try {
    f.apply([{ op: 'create', type: 'todo', text: 'Clean the viewing glass', source: meeting(0) }]);
    f.apply([{ op: 'edit', item: 'T-1', text: 'Clean both viewing panes with acrylic-safe pads', source: { kind: 'app' } }], 'user');
    assert.throws(() => f.apply([{ op: 'status', item: 'T-1', to: 'done', source: { kind: 'app' } }, { op: 'create', type: 'todo', text: 'x', source: { kind: 'app' } }], 'user', { 'T-1': 1 }),
      (e: any) => e.status === 409 && e.stale === 'T-1');
    assert.equal(f.memory.item(P, 'T-1')!.status, 'open');
    assert.equal(f.memory.items(P).length, 1, 'the create in the refused batch did not happen');
    assert.equal(f.apply([{ op: 'create', type: 'todo', text: 'Next', source: { kind: 'app' } }]).created['T-2'], 'T-2', 'and used no id');
    const batch = { requestId: 'r-1', actor: 'user' as const, changes: [{ op: 'status' as const, item: 'T-1', to: 'done' as const, source: { kind: 'app' as const } }] };
    const first = f.memory.apply(P, batch);
    assert.deepEqual(f.memory.apply(P, batch), first, 'a retry is answered from the record');
    assert.throws(() => f.memory.apply(P, { ...batch, changes: [{ op: 'status', item: 'T-1', to: 'open', reason: 'no', source: { kind: 'app' } }] }), /already used/);
  } finally { await f.close(); }
});

test('status changes follow the table; reopening needs a reason; merged items are read-only', async () => {
  const f = await fixture();
  try {
    f.apply([{ op: 'create', type: 'todo', text: 'Rinse the filter sock', source: meeting(0) }, { op: 'create', type: 'todo', text: 'Rinse the same filter sock', source: meeting(1) },
      { op: 'create', type: 'question', text: 'Is the spare lid lockable?', source: meeting(2) }]);
    assert.throws(() => f.apply([{ op: 'status', item: 'T-1', to: 'answered', source: { kind: 'app' } }]), /cannot go from open to answered/);
    f.apply([{ op: 'status', item: 'T-1', to: 'done', source: { kind: 'app' } }]);
    assert.throws(() => f.apply([{ op: 'status', item: 'T-1', to: 'open', source: { kind: 'app' } }]), /needs a reason/);
    f.apply([{ op: 'status', item: 'T-1', to: 'open', reason: 'not finished', source: { kind: 'app' } }]);
    f.apply([{ op: 'answer', item: 'Q-1', text: 'Yes, the spare lid has a key lock.', source: { kind: 'agent', note: 'The stockroom inventory lists two keys' } }]);
    assert.deepEqual([f.memory.item(P, 'Q-1')!.status, f.memory.item(P, 'Q-1')!.fields.answer], ['answered', 'Yes, the spare lid has a key lock.']);
    assert.throws(() => f.apply([{ op: 'merge', item: 'T-2', into: 'Q-1', source: { kind: 'app' } }]), /same type/);
    f.apply([{ op: 'merge', item: 'T-2', into: 'T-1', source: { kind: 'app' } }]);
    assert.throws(() => f.apply([{ op: 'edit', item: 'T-2', text: 'B', source: { kind: 'app' } }]), /merged into T-1/);
    assert.deepEqual(f.memory.rebuild(P), f.memory.items(P));
  } finally { await f.close(); }
});

test('supersede by a decision made in the same batch, and Undo of the whole batch', async () => {
  const f = await fixture();
  try {
    f.apply([{ op: 'create', type: 'decision', text: 'Visitors may handle the shell samples', source: meeting(0) }]);
    const batch = f.apply([
      { op: 'create', ref: 'new1', type: 'decision', text: 'Shell samples are display-only', source: meeting(1) },
      { op: 'supersede', item: 'D-1', by: 'new1', source: meeting(1) },
    ]);
    assert.equal(batch.created.new1, 'D-2');
    assert.deepEqual([f.memory.item(P, 'D-1')!.status, f.memory.item(P, 'D-1')!.fields.supersededBy, f.memory.item(P, 'D-2')!.fields.supersedes], ['superseded', 'D-2', 'D-1']);
    f.memory.undo(P, batch.batch, randomUUID());
    assert.equal(f.memory.item(P, 'D-1')!.status, 'in force');
    assert.equal(f.memory.item(P, 'D-1')!.fields.supersededBy, undefined);
    assert.deepEqual([f.memory.item(P, 'D-2')!.status, f.memory.item(P, 'D-2')!.fields.reason], ['dropped', 'undone'], 'an undone create is kept, dropped');
    assert.throws(() => f.memory.undo(P, batch.batch, randomUUID()), /already undone/);
    assert.deepEqual(f.memory.rebuild(P), f.memory.items(P));
    assert.equal(f.apply([{ op: 'create', type: 'decision', text: 'Later', source: meeting(2) }]).created['D-3'], 'D-3', 'ids are never reused');
  } finally { await f.close(); }
});

test('Undo is refused after a later change, and for a create another item uses', async () => {
  const f = await fixture();
  try {
    const created = f.apply([{ op: 'create', type: 'decision', text: 'Old', source: meeting(0) }]);
    const edited = f.apply([{ op: 'edit', item: 'D-1', text: 'Old, reworded', source: { kind: 'app' } }], 'user');
    f.apply([{ op: 'status', item: 'D-1', to: 'reversed', source: { kind: 'app' } }], 'user');
    assert.throws(() => f.memory.undo(P, edited.batch, randomUUID()), /D-1 changed since/);
    // A merge into T-1 does not change T-1 itself, but T-2 now points at it: undoing T-1's creation is refused.
    const target = f.apply([{ op: 'create', type: 'todo', text: 'Target', source: meeting(1) }]);
    f.apply([{ op: 'create', type: 'todo', text: 'Duplicate', source: meeting(2) }]);
    f.apply([{ op: 'merge', item: 'T-2', into: 'T-1', source: { kind: 'app' } }], 'user');
    assert.throws(() => f.memory.undo(P, target.batch, randomUUID()), /T-1 is used by T-2/);
    assert.ok(created.batch);
  } finally { await f.close(); }
});

test('"raised again" attachments: unconfirmed when AI-recorded, confirmable, and undone on their own', async () => {
  const f = await fixture();
  try {
    f.apply([{ op: 'create', type: 'todo', text: 'Check the nursery heater', source: meeting(0) }]);
    f.apply([{ op: 'confirm', item: 'T-1' }], 'user');
    f.apply([{ op: 'addSource', item: 'T-1', source: { kind: 'meeting', meetingId: 'm2', quote: 'The nursery water still feels cool; inspect the heater today.' } }]);
    const [, , attach] = f.memory.timeline(P, 'T-1');
    assert.deepEqual([attach.op, attach.confirmed, f.memory.item(P, 'T-1')!.confirmed], ['addSource', false, true], 'the item stays confirmed');
    f.apply([{ op: 'confirm', item: 'T-1', event: attach.id }], 'user');
    assert.equal(f.memory.timeline(P, 'T-1').at(-1)!.ref, attach.id);
    assert.equal(f.memory.item(P, 'T-1')!.version, 1, 'links and confirmations leave the version: nothing the user sees changed');
    const again = f.apply([{ op: 'addSource', item: 'T-1', source: { kind: 'meeting', meetingId: 'm3' } }]);
    f.memory.undo(P, again.batch, randomUUID());
    assert.equal(f.memory.timeline(P, 'T-1').find(e => e.batch === again.batch)!.undone, true);
    assert.deepEqual(f.memory.rebuild(P), f.memory.items(P));
  } finally { await f.close(); }
});

test('Undo across meetings: an AI-recorded item raised again later can still be undone, and so can the link alone', async () => {
  const f = await fixture();
  try {
    const created = f.apply([{ op: 'create', type: 'todo', text: 'Rehang the quarantine sign', source: meeting(0) }]);
    const link = f.apply([{ op: 'addSource', item: 'T-1', source: { kind: 'meeting', meetingId: 'm2' } }]);
    f.memory.undo(P, link.batch, randomUUID());
    assert.equal(f.memory.item(P, 'T-1')!.status, 'open', 'undoing the link leaves the item');
    f.apply([{ op: 'addSource', item: 'T-1', source: { kind: 'meeting', meetingId: 'm3' } }]);
    f.memory.undo(P, created.batch, randomUUID());
    assert.deepEqual([f.memory.item(P, 'T-1')!.status, f.memory.item(P, 'T-1')!.fields.reason], ['dropped', 'undone']);
    f.apply([{ op: 'edit', item: 'T-1', text: 'Rehang the quarantine sign with stainless hooks', source: { kind: 'app' } }], 'user');
    assert.throws(() => f.memory.undo(P, link.batch, randomUUID()), /already undone/);
    assert.deepEqual(f.memory.rebuild(P), f.memory.items(P));
  } finally { await f.close(); }
});

test('the brief keeps every version, and a rewrite based on an older version is refused', async () => {
  const f = await fixture();
  try {
    const first = f.memory.saveBrief(P, 'The touch pool is drained for cleaning.', 'ai', { kind: 'meeting', meetingId: 'm1' }, null);
    f.memory.saveBrief(P, 'The touch pool is clean and ready to refill.', 'user', { kind: 'app' }, first.version);
    assert.throws(() => f.memory.saveBrief(P, 'AI rewrite from v1', 'ai', null, first.version), (e: any) => e.status === 409 && e.current.version === 2);
    assert.deepEqual(f.memory.briefVersions(P).map(v => [v.version, v.actor]), [[2, 'user'], [1, 'ai']]);
    f.memory.restoreBrief(P, 1, 2);
    assert.deepEqual([f.memory.brief(P)!.text, f.memory.brief(P)!.actor], ['The touch pool is drained for cleaning.', 'ai'], 'an AI version brought back stays labelled AI');
  } finally { await f.close(); }
});
