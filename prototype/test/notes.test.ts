import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { NotesJobs, NotesFile, notesInstructions, assignsTo, mergeGaps, checkNotesRun, notesInput, notesMarkdown, takeSnapshot, validateNotes, type NotesRunner, type Snapshot } from '../src/notes.ts';
import { piTaskArgs, runPiTask, type PiTaskResult } from '../src/pi-task.ts';
import { Cooldowns } from '../src/quota.ts';
import type { Recognition } from '../src/recognizer.ts';

const recognition = (text: string, retries = 0): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries });
const LINES = [
  'Keep the striped waistcoats on rail B until the matinee ends.',
  'Ask Tamsin which drawer holds the spare buckles.',
  'Tamsin will label the hat boxes before rehearsal.',
  'Has the lobby fern been watered today?',
  'The watering can is beside the yellow bench.',
  'Can we fit the feathered hats into stackable boxes?',
];

async function fixture(lines = LINES) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-notes-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Community theatre costume inventory');
  for (const [i, line] of lines.entries()) {
    const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * 20_000, 16000, Buffer.alloc(16000 * 4, i + 1));
    store.completeChunk(chunk.id, recognition(line));
  }
  return { directory, store, meeting, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const refs = (snapshot: Snapshot) => Object.fromEntries(snapshot.segments.map((s, i) => [i + 1, s.ref]));

test('citations, quotes, owners and off-topic ranges are checked against the snapshot', async () => {
  const f = await fixture();
  try {
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    const S = refs(snapshot);
    const { notes, dropped } = validateNotes({
      title: 'Matinee wardrobe storage',
      summary: [{ text: 'The waistcoats remain on rail B through the matinee.', cites: [S[1]], quote: 'Keep the striped waistcoats on rail B until the matinee ends' }],
      decisions: [
        { text: 'Leave the waistcoats on rail B until the matinee ends.', cites: [S[1]], quote: 'Keep the striped waistcoats on rail B' },
        { text: 'Leave the waistcoats on rail B until the matinee ends.', cites: [S[1]], quote: 'Keep the striped waistcoats on rail B' }, // duplicate
        { text: 'The watering can belongs beside the yellow bench.', cites: [S[2], S[5]], quote: 'The watering can is beside the yellow bench' }, // rests on non-project talk
        { text: 'Use a real but wrong citation.', cites: [S[6]], quote: 'Keep the striped waistcoats on rail B' }, // quote is outside S6's three-line window
        { text: 'Cite a line that does not exist.', cites: ['S99'], quote: 'x' },
      ],
      actions: [
        { text: 'Locate the spare buckles by asking Tamsin.', owner: 'Tamsin', ownerQuote: 'Ask Tamsin which', cites: [S[2]], quote: 'Ask Tamsin which drawer holds the spare buckles' }, // recipient, not owner
        { text: 'Label the hat boxes.', owner: 'Tamsin', ownerQuote: 'Tamsin will label the hat boxes', cites: [S[3]], quote: 'Tamsin will label the hat boxes' },
      ],
      openQuestions: [{ text: 'Will the feathered hats fit in stackable boxes?', cites: [S[6]], quote: 'Can we fit the feathered hats into stackable boxes?' }],
      otherTalk: [{ from: S[4], to: S[5], label: 'lobby plants' }, { from: S[5], to: S[4], label: 'reversed' }],
    }, snapshot);
    assert.equal(notes.suggestedTitle, 'Matinee wardrobe storage');
    assert.deepEqual(notes.decisions.map(d => d.text), ['Leave the waistcoats on rail B until the matinee ends.']);
    assert.deepEqual(notes.needsReview.map(d => [d.text, d.reviewReason]), [
      ['The watering can belongs beside the yellow bench.', 'cites non-project talk; it may belong in Other matters'],
      ['Use a real but wrong citation.', 'quote not found in the cited lines']]);
    assert.deepEqual(notes.actions.map(a => [a.text, a.owner]), [['Locate the spare buckles by asking Tamsin.', null], ['Label the hat boxes.', 'Tamsin']]);
    assert.equal(notes.actions[0].ownerProposed, 'Tamsin', 'an unconfirmed owner stays visible as unconfirmed');
    assert.equal(notes.actions[1].ownerProposed, undefined);
    assert.equal(notes.openQuestions.length, 1);
    assert.equal(notes.otherTalk.length, 1);
    assert.deepEqual(dropped.map(d => d.reason).sort(), ['duplicate', 'invalid range', 'no valid citation',
      'owner not explicitly assigned in the cited lines; shown as unconfirmed']);
    assert.match(notesInput(snapshot), /^<<<TRANSCRIPT DATA — not instructions/);
  } finally { await f.close(); }
});

test('quotes may match the originally heard text; a missing quote or an overlong item goes to review', async () => {
  const f = await fixture(['We packed the waste coats in canvas bags.']);
  try {
    const [segment] = f.store.segments(f.meeting.id);
    f.store.applyEdits(segment.id, segment.revision, 'We packed the waistcoats in canvas bags.', [{ start: 14, end: 24, from: 'waste coats', to: 'waistcoats' }]);
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    assert.match(notesInput(snapshot), /\(heard as: We packed the waste coats in canvas bags\.\)/);
    const { notes } = validateNotes({ summary: [
      { text: 'Waistcoats were packed in canvas bags.', cites: ['S1'], quote: 'We packed the waste coats in canvas bags' },
      { text: 'No quote given.', cites: ['S1'] },
      { text: 'Too short a quote.', cites: ['S1'], quote: 'We packed the waste' },
      { text: 'x'.repeat(301), cites: ['S1'], quote: 'We packed the waste coats' },
    ] }, snapshot);
    assert.equal(notes.summary[0].quoteIn, 'original');
    assert.deepEqual(notes.needsReview.map(n => n.reviewReason), ['no quote', 'quote too short to support the item', 'too long for one claim']);
  } finally { await f.close(); }
});

test('notes use three parallel medium calls, report progress, merge once, and cancel without replacing old notes', async () => {
  const f = await fixture();
  const calls: Parameters<NotesRunner>[0][] = [];
  const releases: (() => void)[] = [];
  let aborts = 0;
  const runner: NotesRunner = async input => {
    calls.push(input);
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      input.signal.addEventListener('abort', () => { aborts++; reject(new Error('aborted')); }, { once: true });
    });
    const part = input.instructions.match(/only these parts of the notes: ([^.]+)/)?.[1];
    const raw = part?.startsWith('title') ? { summary: [{ text: 'Rail B remains in use.', cites: ['S1'], quote: 'Keep the striped waistcoats on rail B' }], openQuestions: [] }
      : part?.startsWith('decisions') ? { decisions: [{ text: 'A plant decision is mis-sorted.', cites: ['S4'], quote: 'Has the lobby fern been watered today' }], actions: [] }
      : { otherMatters: [], otherTalk: [{ from: 'S4', to: 'S5', label: 'plants' }] };
    return { text: JSON.stringify(raw), model: 'stand-in' };
  };
  const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null });
  try {
    assert.match(notesInstructions(), /summary: 3–6 sentences.*one short paragraph.*no 'Discussed …' openers/);
    await jobs.start(f.meeting.id);
    await until(() => calls.length === 3);
    assert.ok(calls.every(c => c.thinking === 'medium'));
    assert.deepEqual(calls.map(c => c.instructions.match(/only these parts of the notes: ([^.]+)/)?.[1]), ['title, summary, openQuestions', 'decisions, actions', 'otherMatters, otherTalk']);
    assert.ok(calls.every(c => c.instructions.startsWith(notesInstructions().split('Answer with JSON only:')[0])));
    assert.equal(new Set(calls.map(c => c.inputPath)).size, 1);
    assert.equal((await jobs.status(f.meeting.id)).job?.progress?.phase, 'read');
    calls[0].onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"summary":[{"text":"Latest point"}]}' } });
    const progress = (await jobs.status(f.meeting.id)).job?.progress;
    assert.equal(progress?.phase, 'write'); assert.equal(progress?.parts.project.count, 1); assert.equal(progress?.latest, 'Latest point');
    releases.splice(0).forEach(r => r());
    await until(() => !jobs.busy(f.meeting.id));
    const old = (await jobs.status(f.meeting.id)).notes;
    assert.equal(old?.notes.summary.length, 1); assert.equal(old?.notes.needsReview.length, 1, 'other part ranges guard project items');
    await jobs.start(f.meeting.id); await until(() => calls.length === 6);
    await jobs.cancel(f.meeting.id, (await jobs.status(f.meeting.id)).job!.id);
    assert.equal(aborts, 3); assert.equal((await jobs.status(f.meeting.id)).job, null);
    assert.deepEqual((await jobs.status(f.meeting.id)).notes, old);
    await jobs.start(f.meeting.id); await until(() => calls.length === 9);
    await jobs.close();
    assert.equal(aborts, 6, 'closing aborts every part too');
    assert.equal((await jobs.status(f.meeting.id)).job?.state, 'interrupted');
    assert.deepEqual((await jobs.status(f.meeting.id)).notes, old);
  } finally { await jobs.close(); await f.close(); }
});

test('the first notes status has snapshot dimensions before job/input files finish writing', async () => {
  const f = await fixture();
  const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner: async () => ({ text: '{}' }), clock: Date.now, glossaryFor: async () => null });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Hold the first filesystem write to deterministically exercise the preparation window.
  const original = (jobs as any).writeJob.bind(jobs);
  (jobs as any).writeJob = async (...args: unknown[]) => { await gate; return original(...args); };
  try {
    await jobs.start(f.meeting.id);
    const state = await jobs.status(f.meeting.id);
    assert.equal(state.job?.progress?.phase, 'read');
    assert.equal(state.job?.progress?.lines, LINES.length);
    assert.equal(state.job?.progress?.minutes, Math.round(state.coverage.untilMs / 60000));
  } finally { release(); await jobs.close(); await f.close(); }
});

test('an abort before notes publication leaves the previous atomic record intact', async () => {
  const f = await fixture();
  try {
    const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner: async () => ({ text: JSON.stringify({ summary: [{ text: 'Keep the waistcoats.', cites: ['S1'], quote: 'Keep the striped waistcoats on rail B' }] }) }), clock: Date.now, glossaryFor: async () => null });
    await jobs.start(f.meeting.id); await until(() => !jobs.busy(f.meeting.id));
    const file = new NotesFile(jobs.file(f.meeting.id).path);
    const old = (await file.load())!;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(file.save(old, controller.signal), /abort/i);
    assert.deepEqual(await file.load(), old);
  } finally { await f.close(); }
});

test('one rate-limited part aborts its siblings, fails the job, retains old notes and starts cooldown', async () => {
  const f = await fixture();
  let fail = false, calls = 0, aborted = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const cooldowns = new Cooldowns(Date.now);
  const runner: NotesRunner = async input => {
    if (!fail) return { text: JSON.stringify({ summary: [{ text: 'Keep the waistcoats.', cites: ['S1'], quote: 'Keep the striped waistcoats on rail B' }] }) };
    calls++;
    if (input.instructions.includes('notes: decisions,')) { await gate; throw new Error('Model rate limit (429)'); }
    await new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true }));
    throw new Error('unreachable');
  };
  const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, cooldowns });
  try {
    await jobs.start(f.meeting.id); await until(() => !jobs.busy(f.meeting.id));
    const old = (await jobs.status(f.meeting.id)).notes;
    fail = true; await jobs.start(f.meeting.id); await until(() => calls === 3); release();
    await until(() => !jobs.busy(f.meeting.id));
    const status = await jobs.status(f.meeting.id);
    assert.equal(status.job?.state, 'failed'); assert.match(status.job?.error ?? '', /rate limit/);
    assert.equal(aborted, 2); assert.deepEqual(status.notes, old); assert.ok(cooldowns.pausedUntil('model'));
  } finally { release(); await jobs.close(); await f.close(); }
});

async function until(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); }

test('the snapshot reports pending audio, lost speech and unchecked lines', async () => {
  const f = await fixture(['First line here.']);
  try {
    const failed = await f.store.addPcm(f.meeting.id, 'mic:t', 10, 40_000, 16000, Buffer.alloc(16000 * 4, 7));
    f.store.setStatus(failed.id, 'failed', '', 'boom');
    const loud = await f.store.addPcm(f.meeting.id, 'mic:t', 11, 60_000, 16000, Buffer.alloc(16000 * 4, 8));
    f.store.completeChunk(loud.id, recognition('', 2));
    const quiet = await f.store.addPcm(f.meeting.id, 'mic:t', 12, 80_000, 16000, Buffer.alloc(16000 * 4, 9));
    f.store.completeChunk(quiet.id, recognition(''));
    await f.store.addPcm(f.meeting.id, 'mic:t', 13, 100_000, 16000, Buffer.alloc(16000 * 4, 10));
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), { version: 1, origin: 'generated', builtAt: 0, terms: [{ term: 'grosgrain', spokenVariants: [] }] });
    assert.equal(snapshot.coverage.pendingChunks, 1);
    assert.deepEqual(snapshot.coverage.gaps.map(g => g.reason), ['failed', 'unrecognised'], 'quiet empty chunks are silence, not gaps');
    assert.equal(snapshot.coverage.uncorrected, 1);
  } finally { await f.close(); }
});

test('notes jobs: one at a time, success-only publication, staleness, interrupted after restart, empty meeting refused', async () => {
  const f = await fixture();
  try {
    const replies: (() => Promise<string>)[] = [];
    const calls: Parameters<NotesRunner>[0][] = [];
    const runner: NotesRunner = async input => { calls.push(input); return { text: await replies.shift()!(), provider: 'openai-codex', model: 'gpt-6.1-sol' }; };
    const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null });
    let release!: () => void;
    replies.push(() => new Promise(resolve => { release = () => resolve(JSON.stringify({ summary: [{ text: 'Rail B holds the matinee waistcoats.', cites: ['S1'], quote: 'Keep the striped waistcoats on rail B' }] })); }));
    replies.push(async () => '{}', async () => '{}');
    await jobs.start(f.meeting.id);
    await assert.rejects(jobs.start(f.meeting.id), /already being written/);
    assert.equal((await jobs.status(f.meeting.id)).job?.state, 'running');
    while (!release) await new Promise(r => setTimeout(r, 5));
    release();
    while ((await jobs.status(f.meeting.id)).job) await new Promise(r => setTimeout(r, 5));
    const first = await jobs.status(f.meeting.id);
    assert.equal(first.notes?.version, 1);
    assert.equal(first.notes?.model, 'openai-codex/gpt-6.1-sol');
    assert.equal(first.stale, false);
    assert.match(calls[0].inputPath, /input-[\w-]+\.md$/);

    // A malformed answer fails the job and keeps the previous notes.
    replies.push(async () => '{}', async () => 'not json', async () => '{}');
    await jobs.start(f.meeting.id);
    while ((await jobs.status(f.meeting.id)).job?.state === 'running') await new Promise(r => setTimeout(r, 5));
    const failed = await jobs.status(f.meeting.id);
    assert.equal(failed.job?.state, 'failed');
    assert.equal(failed.notes?.version, 1);

    // The transcript changes: notes are stale, not rebased.
    const [segment] = f.store.segments(f.meeting.id);
    f.store.applyEdits(segment.id, segment.revision, `${segment.text} Indeed.`, []);
    assert.equal((await jobs.status(f.meeting.id)).stale, true);
    const markdown = notesMarkdown((await jobs.status(f.meeting.id)).notes!, true);
    assert.match(markdown, /AI draft from the transcript/);
    assert.match(markdown, /The transcript changed after these notes were written\. Write the notes again for an up-to-date version\./);
    assert.doesNotMatch(markdown, /regenerate/i);

    // A job left running by a stopped server reads as interrupted.
    await mkdir(join(f.directory, 'notes'), { recursive: true });
    await writeFile(join(f.directory, 'notes', `${f.meeting.id}.job.json`), JSON.stringify({ state: 'running', startedAt: 1 }));
    const restarted = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null });
    assert.equal((await restarted.status(f.meeting.id)).job?.state, 'interrupted');

    const empty = f.store.createMeeting('Empty');
    await assert.rejects(jobs.start(empty.id), /no transcript yet/);
  } finally { await f.close(); }
});

test('the notes task runs Pi with no tools and the transcript as a file argument', () => {
  const args = piTaskArgs('Write notes.', { model: 'm', cwd: '/tmp', tools: null, files: ['/tmp/input.md'] });
  assert.ok(args.includes('--no-tools') && args.includes('--no-skills') && !args.includes('--tools'));
  assert.deepEqual(args.slice(-3), ['--', '@/tmp/input.md', 'Write notes.']);
  assert.ok(piTaskArgs('x', { model: 'm', cwd: '/tmp', tools: 'read' }).includes('read'));
});

test('simultaneous starts: exactly one job runs; close() waits for a job still preparing', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const releases: (() => void)[] = [];
    const runner: NotesRunner = async () => { calls++; await new Promise<void>(r => { releases.push(r); });
      return { text: JSON.stringify({ summary: [{ text: 'Rail B holds the matinee waistcoats.', cites: ['S1'], quote: 'Keep the striped waistcoats on rail B' }] }) }; };
    // A gate on glossary loading holds jobs in preparation until opened.
    let glossaryWait!: () => void;
    let gate = new Promise<void>(r => { glossaryWait = r; });
    const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => { await gate; return null; } });
    const first = jobs.start(f.meeting.id), second = jobs.start(f.meeting.id);
    glossaryWait();
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
    assert.equal((results[1] as PromiseRejectedResult).reason.status, 409);
    while (releases.length < 3) await new Promise(r => setTimeout(r, 5));
    releases.forEach(r => r());
    while ((await jobs.status(f.meeting.id)).job) await new Promise(r => setTimeout(r, 5));
    assert.equal(calls, 3);
    assert.equal((await jobs.status(f.meeting.id)).notes?.version, 1);

    // Closing while the snapshot is still being prepared: the start is refused and close() waits for it.
    gate = new Promise<void>(r => { glossaryWait = r; });
    const preparing = jobs.start(f.meeting.id);
    const closing = jobs.close();
    glossaryWait();
    await assert.rejects(preparing, /closing/);
    await closing;
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

test('owners: full name, positive and unconditional assignment only', () => {
  assert.equal(assignsTo('Tamsin will mend the cuffs.', 'Tamsin'), true);
  assert.equal(assignsTo("Tamsin'll mend the cuffs.", 'Tamsin'), true);
  assert.equal(assignsTo('Tamsin will mend the cuffs.', 'Tamsin Vale'), false, 'the full name must appear');
  assert.equal(assignsTo('Tamsin will not mend the cuffs.', 'Tamsin'), false);
  assert.equal(assignsTo('Tamsin never will mend them.', 'Tamsin'), false);
  assert.equal(assignsTo('Tamsin can mend the cuffs.', 'Tamsin'), false, 'ability is not assignment');
  assert.equal(assignsTo('If the thread arrives, Tamsin will mend the cuffs.', 'Tamsin'), false);
  assert.equal(assignsTo('so that Tamsin will find the buttons', 'Tamsin'), false);
  assert.equal(assignsTo('Kit-Rae will mend the cuffs.', 'Kit-Rae'), true, 'hyphenated names');
  assert.equal(assignsTo('Kit will mend the cuffs.', 'Kit-Rae'), false);
  assert.equal(assignsTo('Tamsin will definitely not mend the cuffs.', 'Tamsin'), false);
  assert.equal(assignsTo('Tamsin will no longer mend the cuffs.', 'Tamsin'), false);
  assert.equal(assignsTo("Tamsin will mend them, but Oona won't.", 'Tamsin'), false, 'any negation in the sentence: no owner');
  assert.equal(assignsTo('Tamsin will, if the thread arrives, mend the cuffs.', 'Tamsin'), false);
  assert.equal(assignsTo('Tamsin will check whether the cuffs fit after washing.', 'Tamsin'), true, '"whether"/"after" mid-sentence are not conditions');
  assert.equal(assignsTo('When the thread arrives, Tamsin will mend the cuffs.', 'Tamsin'), false);
  assert.equal(assignsTo('We are deciding whether the caretaker Oona will water the fern.', 'Oona'), false, 'assignment inside an open question');
  assert.equal(assignsTo('Oona will water the fern.', 'Oona'), true);
  assert.equal(assignsTo('And so on, Tamsin will have to sew the remaining cuffs.', 'Tamsin'), true, '"and so on" is filler');
  assert.equal(assignsTo('so Tamsin will find the buttons', 'Tamsin'), false);
});

test('owner quotes are checked in their whole sentence, so cropping cannot hide a negation', async () => {
  const f = await fixture(['Tamsin will not label all the hat boxes.', 'Tamsin will label all the hat boxes.']);
  try {
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    const { notes } = validateNotes({ actions: [
      { text: 'Label the boxes (negated line).', owner: 'Tamsin', ownerQuote: 'Tamsin will', cites: ['S1'], quote: 'label all the hat boxes' },
      { text: 'Label the boxes.', owner: 'Tamsin Vale', ownerQuote: 'Tamsin will label all the hat boxes', cites: ['S2'], quote: 'Tamsin will label all the hat boxes' },
      { text: 'Label the hat boxes.', owner: 'Tamsin', ownerQuote: 'Tamsin will label', cites: ['S2'], quote: 'Tamsin will label all the hat boxes' },
    ] }, snapshot);
    assert.deepEqual(notes.actions.map(a => [a.owner, a.ownerQuote ?? null]), [[null, null], [null, null], ['Tamsin', 'Tamsin will label all the hat boxes.']]);
  } finally { await f.close(); }
});

test('quotes keep signs and numbers and match whole words only', async () => {
  const f = await fixture(['The dragon token costs > 7.25 coins today.', 'Give the lantern card a 2.75 bonus tonight.', 'We use miniature painting trays here.',
    'Count r! arrangements of the coloured dice.', 'Use (red + blue) * gold for victory points.', 'Spend c−3 crystals, then use oak-ash for bonus points.']);
  try {
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    const { notes } = validateNotes({ summary: [
      { text: 'Dragon tokens cost less than 7.25 coins.', cites: ['S1'], quote: 'The dragon token costs < 7.25 coins today' },
      { text: 'The lantern has a negative bonus.', cites: ['S2'], quote: 'Give the lantern card a -2.75 bonus tonight' },
      { text: 'Miniature paint trays.', cites: ['S3'], quote: 'We use miniature paint trays here' },
      { text: 'Dragon tokens cost more than 7.25 coins.', cites: ['S1'], quote: 'the dragon token costs > 7.25 coins today' },
      { text: 'Count r arrangements.', cites: ['S4'], quote: 'Count r arrangements of the coloured dice' },
      { text: 'Grouping changed.', cites: ['S5'], quote: 'Use red + blue * gold for victory points' },
      { text: 'Count r factorial dice arrangements.', cites: ['S4'], quote: 'Count r! arrangements of the coloured dice' },
      { text: 'Grouped victory points.', cites: ['S5'], quote: 'use (red + blue) * gold for victory points' },
      { text: 'Spend c 3 crystals.', cites: ['S6'], quote: 'Spend c 3 crystals, then use' },
      { text: 'Use oak ash.', cites: ['S6'], quote: 'then use oak ash for bonus points' },
      { text: 'Spend c minus 3 crystals.', cites: ['S6'], quote: 'Spend c-3 crystals, then use oak–ash' },
    ] }, snapshot);
    assert.deepEqual(notes.summary.map(n => n.text), ['Dragon tokens cost more than 7.25 coins.', 'Count r factorial dice arrangements.', 'Grouped victory points.', 'Spend c minus 3 crystals.']);
    assert.equal(notes.needsReview.length, 7);
    // The mutations fail on the quote match itself, not on length.
    assert.ok(notes.needsReview.every(n => n.quoteIn === null && n.reviewReason === 'quote not found in the cited lines'));
  } finally { await f.close(); }
});

test('nothing is clipped before checking; a broken duplicate does not shadow a good copy', async () => {
  const f = await fixture();
  try {
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    const S = refs(snapshot);
    const { notes, dropped } = validateNotes({
      decisions: [
        // Eight wardrobe citations, then a ninth inside a non-project range: still noticed, so out of the project sections.
        { text: 'Mixed item.', cites: [S[1], S[2], S[3], S[6], 'S90', 'S91', 'S92', 'S93', S[4]], quote: 'Keep the striped waistcoats on rail B' },
        { text: 'Keep the waistcoats on rail B.', cites: ['S99'], quote: 'Keep the striped waistcoats on rail B' },
        { text: 'Keep the waistcoats on rail B.', cites: [S[1]], quote: 'Keep the striped waistcoats on rail B' },
        { text: 'A long quote.', cites: [S[1]], quote: `Keep the ${'stripedwaistcoatlongtoken'.repeat(30)} on rail B` },
      ],
      otherTalk: [{ from: S[4], to: S[5], label: 'lobby plants' }],
    }, snapshot);
    assert.deepEqual(notes.decisions.map(d => d.text), ['Keep the waistcoats on rail B.']);
    assert.deepEqual(notes.needsReview.map(d => d.reviewReason), ['cites non-project talk; it may belong in Other matters', 'quote too long']);
    assert.ok(notes.needsReview[1].quote.length > 400, 'the stored quote is the one that was checked');
    assert.deepEqual(dropped.map(d => d.reason), ['no valid citation']);
  } finally { await f.close(); }
});

test('new lost audio makes notes stale; saved notes stay readable with writing disabled', async () => {
  const f = await fixture(['First line here.']);
  try {
    const runner: NotesRunner = async () => ({ text: JSON.stringify({ summary: [{ text: 'First line.', cites: ['S1'], quote: 'First line here' }] }) });
    const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null });
    await jobs.start(f.meeting.id);
    while ((await jobs.status(f.meeting.id)).job) await new Promise(r => setTimeout(r, 5));
    assert.equal((await jobs.status(f.meeting.id)).stale, false);
    const failed = await f.store.addPcm(f.meeting.id, 'mic:t', 10, 40_000, 16000, Buffer.alloc(16000 * 4, 7));
    f.store.setStatus(failed.id, 'failed', '', 'boom');
    const after = await jobs.status(f.meeting.id);
    assert.equal(after.stale, true);
    assert.equal(after.coverage.gaps.length, 1);
    assert.match(notesMarkdown(after.notes!, after.stale, after.coverage), /Speech missing since these notes were written: 00:40–00:\d\d \(failed\)/);

    const offline = new NotesJobs({ store: f.store, directory: f.directory, runner: null, clock: Date.now, glossaryFor: async () => null });
    assert.equal(offline.enabled, false);
    assert.equal((await offline.status(f.meeting.id)).notes?.version, 1);
    await assert.rejects(offline.start(f.meeting.id), /disabled/);
  } finally { await f.close(); }
});

test('notes share the quota cooldown: they do not start during it, and their own rate-limit error starts it', async () => {
  const f = await fixture();
  try {
    const cooldowns = new Cooldowns();
    const runner: NotesRunner = async () => { throw new Error('Pi task error: You have hit your usage limit (429).'); };
    const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, cooldowns });
    await jobs.start(f.meeting.id);
    for (let i = 0; i < 200 && jobs.busy(f.meeting.id); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal((await jobs.status(f.meeting.id)).job?.state, 'failed');
    assert.ok(cooldowns.pausedUntil('model'), "the model's cooldown is in force for every sol job");
    assert.equal(cooldowns.pausedUntil('web'), null);
    await assert.rejects(jobs.start(f.meeting.id), (error: Error & { status?: number }) => error.status === 429 && /again from \d\d:\d\d/.test(error.message));
    assert.equal(jobs.busy(f.meeting.id), false);
  } finally { await f.close(); }
});

test('a notes run counts only when Pi exits cleanly, settles and stops normally, with no tool events', async () => {
  const ok: PiTaskResult = { text: '{}', ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [] };
  assert.equal(checkNotesRun(ok), ok);
  assert.throws(() => checkNotesRun({ ...ok, exitCode: 1 }), /did not finish normally/);
  assert.throws(() => checkNotesRun({ ...ok, settled: false }), /not settled/);
  assert.throws(() => checkNotesRun({ ...ok, exitCode: null, exitSignal: 'SIGTERM' }), /SIGTERM/);
  assert.throws(() => checkNotesRun({ ...ok, toolEvents: 1 }), /tools/);
  // A fake Pi that prints a good answer and then exits nonzero: the exit code reaches the check.
  const events = [{ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"summary":[]}' }] } }, { type: 'tool_execution_end', toolName: 'read' }];
  const script = `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e)); process.exit(3);`;
  const result = await runPiTask('x', { model: 'm', cwd: tmpdir(), command: process.execPath, args: ['-e', script] });
  assert.equal(result.exitCode, 3);
  assert.equal(result.settled, false);
  assert.equal(result.toolEvents, 1);
  assert.throws(() => checkNotesRun(result));
});

test('other matters: non-project items are recorded with kind, label and checked evidence; old records upgrade', async () => {
  const f = await fixture([
    'Oona will check whether seed envelopes can be collected from the library.',
    'Put the donated seeds in paper envelopes, not plastic tubs.',
    'Keep the striped waistcoats on rail B until the matinee ends.',
    'Did you hear the thunder last night?',
  ]);
  try {
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    const { notes } = validateNotes({
      decisions: [{ text: 'Leave the waistcoats on rail B through the matinee.', cites: ['S3'], quote: 'Keep the striped waistcoats on rail B' }],
      otherMatters: [
        { text: 'Oona checks for seed envelopes at the library.', kind: 'todo', label: 'admin', owner: 'Oona',
          ownerQuote: 'Oona will check whether seed envelopes', cites: ['S1'], quote: 'check whether seed envelopes can be collected from the library' },
        { text: 'Store donated seeds in paper, not plastic.', kind: 'tip', label: 'storage', cites: ['S2'], quote: 'Put the donated seeds in paper envelopes, not plastic tubs' },
        { text: 'The seed envelopes cost 24.50 dollars.', kind: 'info', label: 'admin', cites: ['S2'], quote: 'The seed envelopes cost 24.50 dollars per box' },
      ],
      otherTalk: [{ from: 'S1', to: 'S2', label: 'seed exchange' }, { from: 'S4', to: 'S4', label: 'weather', smallTalk: true }],
    }, snapshot);
    assert.equal(notes.decisions.length, 1);
    assert.deepEqual(notes.otherMatters.map(n => [n.kind, n.label, n.owner]), [['todo', 'admin', 'Oona'], ['info', 'other', null]],
      'non-project ranges do not block other matters; unknown kind/label fall back');
    assert.deepEqual(notes.needsReview.map(n => [n.section, n.reviewReason]), [['otherMatters', 'quote not found in the cited lines']]);
    assert.deepEqual(notes.otherTalk.map(r => r.smallTalk), [false, true]);

    // A record from before M2b (offTopic, no other matters) is read in the new shape and exports cleanly.
    const runner: NotesRunner = async () => ({ text: '{}' });
    const jobs = new NotesJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null });
    const { otherMatters: _o, otherTalk: _t, ...old } = notes;
    await mkdir(join(f.directory, 'notes'), { recursive: true });
    await writeFile(join(f.directory, 'notes', `${f.meeting.id}.json`), JSON.stringify({
      version: 3, createdAt: 1, model: 'm', meetingId: f.meeting.id, title: 'Old', dropped: [], sources: {},
      input: { inputHash: 'x', coverage: snapshot.coverage, glossaryVersion: null, segments: 4, takenAt: 1 },
      notes: { ...old, offTopic: [{ fromId: 'a', toId: 'b', startMs: 0, endMs: 1000, label: 'keys' }] },
    }));
    const record = (await jobs.status(f.meeting.id)).notes!;
    assert.deepEqual(record.notes.otherMatters, []);
    assert.deepEqual(record.notes.otherTalk.map(r => [r.label, r.smallTalk]), [['keys', false]]);
    const markdown = notesMarkdown(record, false);
    assert.match(markdown, /## Other matters \(not about the project\)/);
    assert.match(markdown, /## Non-project talk \(model-proposed ranges\)\n\n- 00:00–00:01: keys/);
  } finally { await f.close(); }
});

test('adjacent gaps of the same reason are shown as one stretch', () => {
  const gap = (startMs: number, endMs: number, reason: 'failed' | 'unrecognised' = 'unrecognised') => ({ startMs, endMs, reason });
  assert.deepEqual(mergeGaps([gap(2_860_000, 2_880_000), gap(2_840_000, 2_860_000), gap(3_000_000, 3_020_000), gap(3_020_000, 3_040_000, 'failed')]),
    [gap(2_840_000, 2_880_000), gap(3_000_000, 3_020_000), gap(3_020_000, 3_040_000, 'failed')]);
});
