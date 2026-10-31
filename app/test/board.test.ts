import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { BOARD, Boards, investigation, sameItem, scanWindow, uncovered, validateItems, type Card, type Item } from '../src/board.ts';
import type { PiAnswer } from '../src/pi-rpc.ts';
import type { Recognition } from '../src/recognizer.ts';

const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
const LINES = [
  'Must the club keep unpainted miniatures away from the snack table during game night?',
  'Put the wooden tokens in the blue cabinet and leave the card sleeves on the trolley.',
  'Our club owns forty two wooden dragon tokens from the winter craft fair.',
  'Which bakery sells rosemary crackers for the neighbourhood picnic on Sunday?',
];
async function fixture(lines = LINES, spacingMs = 30_000) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-board-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Tabletop club cupboard sorting');
  for (const [i, line] of lines.entries()) {
    const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * spacingMs, 16000, Buffer.alloc(16000 * 4, i + 1));
    store.completeChunk(chunk.id, recognition(line));
  }
  return { directory, store, meeting, segments: () => store.visibleSegments(meeting.id, Date.now()), async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const answer = (items: unknown[], extra: Partial<PiAnswer> = {}): PiAnswer => ({ text: JSON.stringify({ items }), ms: 1, attempts: 1, stopReason: 'stop', aborted: false, usages: [{ input: 10 }], ...extra });
const ref = (window: NonNullable<ReturnType<typeof scanWindow>>, i: number) => window.lines.find(l => l.segment.text === LINES[i])!.ref;

test('items are checked strictly against the scanned lines', async () => {
  const f = await fixture();
  try {
    const window = scanWindow(f.segments(), {})!;
    const ok = { type: 'question', text: 'Must unpainted miniatures stay away from snacks?', cites: [ref(window, 0)], quote: 'Must the club keep unpainted miniatures away from the snack table', confidence: 'high', materials: true, nonProject: false };
    const { kept, dropped } = validateItems({ items: [
      ok,
      { ...ok, type: 'musing' },
      { ...ok, confidence: 'very' },
      { ...ok, materials: 'yes' },
      { ...ok, cites: ['S99'] },
      { ...ok, quote: 'unpainted miniatures' },
      { ...ok, quote: 'Must the club keep painted miniatures away from the snack table' },
      { ...ok, type: 'other', text: 'Rosemary crackers for the picnic.', cites: [ref(window, 3)], quote: 'Which bakery sells rosemary crackers for the neighbourhood picnic', nonProject: false },
    ] }, window);
    assert.equal(kept.length, 2);
    assert.equal(kept[1].nonProject, true, 'an "other" item is always non-project');
    assert.deepEqual(dropped.map(d => d.reason), ['unknown type', 'unknown confidence', 'materials/nonProject must be true or false', 'citation outside the scanned lines',
      'quote must be 3-25 words', 'quote not found in the cited lines']);
    assert.throws(() => validateItems({ notItems: [] }, window), /no items list/);
    // A quote may run across consecutive cited lines; a non-project question becomes an "other" card.
    const spanning = validateItems({ items: [{ ...ok, text: 'Two lines', cites: [ref(window, 0), ref(window, 1)], quote: 'during game night? Put the wooden tokens in the blue cabinet' },
      { ...ok, text: 'Where can we buy picnic crackers?', type: 'question', cites: [ref(window, 3)], quote: 'Which bakery sells rosemary crackers for the neighbourhood picnic', nonProject: true }] }, window);
    assert.equal(spanning.kept.length, 2);
    assert.deepEqual([spanning.kept[1].type, spanning.kept[1].materials], ['other', false]);
  } finally { await f.close(); }
});

test('merging is conservative: opposite meanings, different numbers and different items stay apart', () => {
  const line = (id: string) => ({ id, revision: 0, startMs: 0, endMs: 1, text: '', originalText: '' });
  const card = (text: string, type: Card['type'] = 'question', ids = ['a']): Card => ({ id: 'c', type, text, confidence: 'high', materials: true, nonProject: false, firstMs: 0, createdAt: 0,
    occurrences: [{ scanId: 's', lines: ids.map(line), quote: '', matched: 'corrected', publishedAt: 0, glossaryVersion: null }], dismissed: false, attempts: [] });
  const item = (text: string, type: Item['type'] = 'question', ids = ['a']): Item => ({ type, text, confidence: 'high', materials: true, nonProject: false, occurrence: { lines: ids.map(line), quote: '', matched: 'corrected' } });
  assert.equal(sameItem(card('Store unpainted miniatures separately?'), item('Store unpainted miniatures separately?', 'question', ['z'])), true, 'identical text');
  assert.equal(sameItem(card('Store unpainted miniatures separately?'), item('Store painted miniatures separately?')), false, 'opposite meaning from a negative prefix');
  assert.equal(sameItem(card('Pack 42 dice in each carry case.', 'decision'), item('Pack 63 dice in each carry case.', 'decision')), false, 'different numbers');
  assert.equal(sameItem(card('Put the wooden tokens in the blue cabinet.', 'decision'), item('Leave the card sleeves on the trolley.', 'decision')), false, 'two directions in one segment');
  assert.equal(sameItem(card('Put the wooden tokens in the blue cabinet.', 'decision'), item('Put the wooden tokens in the blue cabinet please.', 'decision')), true, 'a genuine repeat');
  assert.equal(sameItem(card('Put the wooden tokens in the blue cabinet.', 'decision'), item('Put the wooden tokens in the blue cabinet.', 'action')), false, 'different type');
});

test('coverage follows segment revisions: late and corrected speech is scanned again', async () => {
  const f = await fixture();
  try {
    const covered: Record<string, number> = {};
    for (const s of f.segments()) covered[s.id] = s.revision;
    assert.equal(uncovered(f.segments(), covered).length, 0);
    const [first] = f.segments();
    f.store.applyEdits(first.id, first.revision, `${first.text} Really.`, []);
    assert.deepEqual(uncovered(f.segments(), covered).map(s => s.id), [first.id], 'a corrected line is uncovered again');
    const late = await f.store.addPcm(f.meeting.id, 'mic:t', 9, 10_000, 16000, Buffer.alloc(16000 * 4, 9));
    f.store.completeChunk(late.id, recognition('A late line published after the scan.'));
    assert.equal(uncovered(f.segments(), covered).length, 2, 'late speech before the last scan is still picked up');
  } finally { await f.close(); }
});

/** A stub of the M3 action jobs: records submissions; `refuse` makes submit throw. */
function stubActions() {
  const submitted: any[] = [];
  const jobs = new Map<string, { id: string; state: string }>();
  let refuse = false;
  return {
    submitted, jobs, set refuse(v: boolean) { refuse = v; },
    api: {
      async submit(_meetingId: string, request: any) {
        if (refuse) throw new Error('Attach materials first.');
        const job = { id: `job-${submitted.length + 1}`, state: 'queued' };
        submitted.push(request); jobs.set(job.id, job);
        return { job, merged: false };
      },
      get: (id: string) => jobs.get(id),
    } as any,
  };
}

test('scans publish as patches; errors do not advance coverage; a failing window is skipped after 3 tries', async () => {
  const f = await fixture();
  try {
    const actions = stubActions();
    const replies: (PiAnswer | Error)[] = [];
    let release!: () => void;
    let gate = Promise.resolve();
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true,
      ask: async () => { await gate; const r = replies.shift()!; if (r instanceof Error) throw r; return r; } });
    const window = scanWindow(f.segments(), {})!;
    const q = { type: 'question', text: 'Must unpainted miniatures stay away from snacks?', cites: [ref(window, 0)], quote: 'Must the club keep unpainted miniatures away from the snack table', confidence: 'medium', materials: true, nonProject: false };
    // A dismissal made while a scan runs survives the scan's publication.
    replies.push(answer([q]));
    await boards.requestScan(f.meeting.id);
    const [card] = (await boards.status(f.meeting.id)).cards;
    gate = new Promise(r => { release = r; });
    const [late] = f.segments();
    f.store.applyEdits(late.id, late.revision, `${late.text} Again.`, []);
    replies.push(answer([{ ...q, quote: 'Must the club keep unpainted miniatures away from the snack table' }]));
    const scanning = boards.requestScan(f.meeting.id);
    await boards.setDismissed(f.meeting.id, card.id, true);
    release();
    await scanning;
    const after = await boards.status(f.meeting.id);
    assert.equal(after.cards.length, 1, 'the repeat merged into the dismissed card');
    assert.equal(after.cards[0].dismissed, true, 'dismissal is sticky');
    assert.equal(after.cards[0].occurrences.length, 2);

    // Errors: nothing covered; three failures on the same window skip it as a visible gap.
    f.store.applyEdits(late.id, late.revision + 1, `${late.text} Again and again.`, []);
    for (let i = 0; i < 3; i++) { replies.push(answer([], { stopReason: 'error', errorMessage: 'boom' })); await boards.requestScan(f.meeting.id); }
    const status = await boards.status(f.meeting.id);
    assert.equal(status.gaps.length, 1);
    assert.equal(await boards.hasBacklog(f.meeting.id), false);
    await boards.close();
  } finally { await f.close(); }
});

test('automatic investigation: only clear materials questions, at most five, never non-project, never rerun after a restart', async () => {
  const lines = Array.from({ length: 8 }, (_, i) => `For cupboard ${i}, where does the club keep the matching spare padlock key?`);
  const f = await fixture(lines, 10_000);
  try {
    const actions = stubActions();
    const replies: PiAnswer[] = [];
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true, ask: async () => replies.shift()! });
    const window = scanWindow(f.segments(), {})!;
    const item = (i: number, extra = {}) => ({ type: 'question', text: `Where is the spare key for cupboard ${i}?`, cites: [window.lines[i].ref], quote: lines[i].split(' ').slice(0, 8).join(' '), confidence: 'high', materials: true, nonProject: false, ...extra });
    replies.push(answer([item(0), item(1), item(2), item(5), item(6), item(7)]));
    await boards.requestScan(f.meeting.id);
    let status = await boards.status(f.meeting.id);
    assert.equal(actions.submitted.length, 5, 'capped at five');
    assert.ok(actions.submitted.every(r => r.origin === 'auto' && r.action === 'answer'));
    assert.equal(status.autoUsed, 5);
    assert.equal(status.cards.filter(c => !c.auto).length, 1, 'the sixth stays a suggestion');
    // New speech: a non-project question and a medium-confidence one never run automatically (the cap is spent anyway,
    // so check the eligibility rule directly on a fresh board below).
    const fresh = await fixture(lines.slice(0, 2), 10_000);
    try {
      const actions2 = stubActions();
      const w2 = scanWindow(fresh.segments(), {})!;
      const it = (i: number, extra = {}) => ({ ...item(i), cites: [w2.lines[i].ref], ...extra });
      const b2 = new Boards({ store: fresh.store, directory: fresh.directory, clock: Date.now, actions: actions2.api, glossaryFor: async () => null, hasMaterials: () => true,
        ask: async () => answer([it(0, { nonProject: true }), it(1, { confidence: 'medium' })]) });
      await b2.requestScan(fresh.meeting.id);
      assert.equal(actions2.submitted.length, 0, 'non-project and medium-confidence questions are suggestions only');
      await b2.close();
    } finally { await fresh.close(); }
    // Restart: a submitted job that was interrupted becomes uncertain; nothing is resubmitted.
    actions.jobs.get('job-1')!.state = 'interrupted';
    await boards.close();
    const restarted = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true, ask: async () => answer([]) });
    status = await restarted.status(f.meeting.id);
    assert.equal(status.cards.filter(c => c.auto?.state === 'uncertain').length, 1);
    assert.equal(actions.submitted.length, 5);
    await restarted.close();
  } finally { await f.close(); }
});

test('automatic answers setting stops admission mid-scan without spending slots; manual Answer stays available', async () => {
  const lines = Array.from({ length: 3 }, (_, i) => `For cupboard ${i}, where does the club keep the matching spare padlock key?`);
  const f = await fixture(lines, 10_000);
  let boards: Boards | undefined;
  try {
    let enabled = false, stopOnSubmit = false;
    const actions = stubActions();
    const submit = actions.api.submit;
    actions.api.submit = async (...args: any[]) => {
      const result = await submit(...args);
      if (stopOnSubmit) enabled = false;
      return result;
    };
    const w = scanWindow(f.segments(), {})!;
    const items = lines.map((line, i) => ({ type: 'question', text: `Where is the spare key for cupboard ${i}?`, cites: [w.lines[i].ref],
      quote: line.split(' ').slice(0, 8).join(' '), confidence: 'high', materials: true, nonProject: false }));
    let next = items.slice(0, 1);
    boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null,
      hasMaterials: () => true, autoAnswers: () => enabled, ask: async () => answer(next) });
    await boards.requestScan(f.meeting.id);
    assert.equal(actions.submitted.length, 0, 'off: no automatic job');
    assert.equal((await boards.status(f.meeting.id)).autoUsed, 0, 'off consumes no cap slots');
    const [card] = (await boards.status(f.meeting.id)).cards;
    await boards.investigate(f.meeting.id, card.id);
    assert.equal(actions.submitted.length, 1, 'manual Answer still works');
    for (const line of f.segments()) f.store.applyEdits(line.id, line.revision, `${line.text} Please check.`, []);
    enabled = true; stopOnSubmit = true; next = items.slice(1);
    await boards.requestScan(f.meeting.id);
    assert.equal(actions.submitted.length, 2, 'the first automatic job can finish, but the next cannot start');
    assert.equal((await boards.status(f.meeting.id)).autoUsed, 1, 'unchanged ledger counts only the admitted answer');
  } finally { await boards?.close(); await f.close(); }
});

test('the Investigate matrix and the user path keep every attempt', async () => {
  const card = (type: Card['type'], extra: Partial<Card> = {}): Card => ({ id: 'c', type, text: 't', confidence: 'high', materials: true, nonProject: false, firstMs: 0, createdAt: 0, occurrences: [], dismissed: false, attempts: [], ...extra });
  assert.deepEqual(investigation(card('question')), { action: 'answer', prompt: 't' });
  assert.deepEqual(investigation(card('question', { materials: false })), { action: 'explain', prompt: 't' });
  assert.equal(investigation(card('question', { nonProject: true }))!.action, 'lookUp');
  assert.match(investigation(card('claim'))!.prompt, /^Check this claim against the materials/);
  assert.equal(investigation(card('decision')), null);
  assert.equal(investigation(card('other', { nonProject: true })), null);
  const f = await fixture();
  try {
    const actions = stubActions();
    const window = scanWindow(f.segments(), {})!;
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => false,
      ask: async () => answer([{ type: 'claim', text: 'The club owns 42 wooden dragon tokens.', cites: [ref(window, 2)], quote: 'owns forty two wooden dragon tokens from the winter craft fair', confidence: 'high', materials: true, nonProject: false }]) });
    await boards.requestScan(f.meeting.id);
    const [c] = (await boards.status(f.meeting.id)).cards;
    await boards.investigate(f.meeting.id, c.id);
    await boards.investigate(f.meeting.id, c.id);
    const after = (await boards.status(f.meeting.id)).cards[0];
    assert.deepEqual(after.attempts, ['job-1', 'job-2']);
    assert.equal(actions.submitted[0].origin, 'card');
    assert.equal(BOARD.autoCap, 5);
    await boards.close();
  } finally { await f.close(); }
});

test('failed scans skip a window without covering it; a manual scan retries it', async () => {
  const f = await fixture();
  try {
    const actions = stubActions();
    const replies: PiAnswer[] = [];
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true, ask: async () => replies.shift()! });
    for (let i = 0; i < 3; i++) { replies.push(answer([], { stopReason: 'error', errorMessage: 'boom' })); await boards.requestScan(f.meeting.id); }
    assert.equal(await boards.hasBacklog(f.meeting.id), false, 'skipped stretches are not rescanned on their own');
    const window = scanWindow(f.segments(), {})!;
    replies.push(answer([{ type: 'question', text: 'Must unpainted miniatures stay away from snacks?', cites: [ref(window, 0)], quote: 'Must the club keep unpainted miniatures away from the snack table', confidence: 'medium', materials: true, nonProject: false }]));
    await boards.scanAll(f.meeting.id);
    await new Promise(r => setTimeout(r, 30));
    await boards.close();
    const after = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true, ask: async () => answer([]) });
    const status = await after.status(f.meeting.id);
    assert.equal(status.cards.length, 1, 'the manual scan retried the skipped stretch');
    assert.deepEqual(status.gaps, []);
    await after.close();
  } finally { await f.close(); }
});

test('a scan that throws while preparing never rejects; a rate-limit pause holds the coalesced successor', async () => {
  const f = await fixture();
  try {
    const actions = stubActions();
    let calls = 0;
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, hasMaterials: () => true,
      glossaryFor: async () => { throw new Error('glossary unreadable'); }, ask: async () => { calls++; return answer([]); } });
    await boards.requestScan(f.meeting.id); // resolves, does not reject
    assert.match((await boards.status(f.meeting.id)).lastError!, /glossary unreadable/);
    await boards.close();

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const paused = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, hasMaterials: () => true, glossaryFor: async () => null,
      ask: async () => { calls++; await gate; return answer([], { stopReason: 'error', errorMessage: 'HTTP 429 rate limit' }); } });
    calls = 0;
    const first = paused.requestScan(f.meeting.id);
    const coalesced = paused.requestScan(f.meeting.id, 'end'); // coalesced behind it
    release();
    await Promise.all([first, coalesced]);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls, 1, 'no new request during the pause');
    assert.ok(paused.paused());
    await assert.rejects(paused.scanAll(f.meeting.id), /paused/);
    await paused.close();
  } finally { await f.close(); }
});

test('no automatic run on changed evidence or mixed scope; negations and symbols keep cards apart', async () => {
  const card = (text: string): Card => ({ id: 'c', type: 'question', text, confidence: 'high', materials: true, nonProject: false, firstMs: 0, createdAt: 0,
    occurrences: [{ scanId: 's', lines: [{ id: 'a', revision: 0, startMs: 0, endMs: 1, text: '', originalText: '' }], quote: '', matched: 'corrected', publishedAt: 0, glossaryVersion: null }], dismissed: false, attempts: [] });
  const item = (text: string, nonProject = false): Item => ({ type: 'question', text, confidence: 'high', materials: true, nonProject, occurrence: { lines: [{ id: 'a', revision: 0, startMs: 0, endMs: 1, text: '', originalText: '' }], quote: '', matched: 'corrected' } });
  assert.equal(sameItem(card('Does the club supply spare paintbrushes at the miniature table?'), item("Doesn't the club supply spare paintbrushes at the miniature table?")), false);
  assert.equal(sameItem(card('Award red + gold coins for a dragon tile'), item('Award red / gold coins for a dragon tile')), false);
  assert.equal(sameItem(card('Are the picnic crackers ordered?'), item('Are the picnic crackers ordered?', true)), false, 'never across scope');

  const f = await fixture();
  try {
    const actions = stubActions();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const window = scanWindow(f.segments(), {})!;
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true,
      ask: async () => {
        const [first] = f.segments();
        f.store.applyEdits(first.id, first.revision, `${first.text} Indeed.`, []); // corrected while the gate is thinking
        await gate;
        return answer([{ type: 'question', text: 'Must unpainted miniatures stay away from snacks?', cites: [ref(window, 0)], quote: 'Must the club keep unpainted miniatures away from the snack table', confidence: 'high', materials: true, nonProject: false }]);
      } });
    const scanning = boards.requestScan(f.meeting.id);
    release();
    await scanning;
    assert.equal(actions.submitted.length, 0, 'the line changed since detection: no automatic run');
    await boards.close();
  } finally { await f.close(); }
});

test('a quote may not join lines that skip speech, nor rest only on earlier lines', async () => {
  const lines = ['Please do', 'not', 'stack the painted miniatures beside the radiator', 'The spare dice are in the orange pouch'];
  const f = await fixture(lines, 5_000);
  try {
    const segs = f.segments();
    const window = scanWindow(segs, { [segs[3].id]: segs[3].revision })!; // the last line counts as earlier context... reorder below
    const r = (i: number) => window.lines.find(l => l.segment.text === lines[i])!.ref;
    const item = { type: 'decision', text: 'Stack the painted miniatures beside the radiator.', confidence: 'high', materials: true, nonProject: false };
    const { kept, dropped } = validateItems({ items: [
      { ...item, cites: [r(0), r(2)], quote: 'Please do stack the painted miniatures' },
      { ...item, cites: [r(0), r(1), r(2)], quote: 'Please do not stack the painted miniatures' },
    ] }, window, segs);
    assert.deepEqual(dropped.map(d => d.reason), ['quote spans lines that are not consecutive'], 'S1+S3 must not drop the "not" in S2');
    assert.equal(kept.length, 1);
  } finally { await f.close(); }
});

test('a real save failure publishes nothing; M3 refuses evidence that changed; merges keep every requesting card', async () => {
  const f = await fixture();
  try {
    const actions = stubActions();
    const window = scanWindow(f.segments(), {})!;
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: actions.api, glossaryFor: async () => null, hasMaterials: () => true,
      ask: async () => answer([{ type: 'question', text: 'Must unpainted miniatures stay away from snacks?', cites: [ref(window, 0)], quote: 'Must the club keep unpainted miniatures away from the snack table', confidence: 'medium', materials: true, nonProject: false }]) });
    await boards.status(f.meeting.id); // loaded (empty) first
    await mkdir(join(f.directory, 'board', `${f.meeting.id}.json`), { recursive: true }); // then the file path becomes a folder: every save fails
    await boards.requestScan(f.meeting.id);
    const status = await boards.status(f.meeting.id);
    assert.equal(status.cards.length, 0, 'nothing shown that was not saved');
    assert.equal(await boards.hasBacklog(f.meeting.id), true, 'coverage did not advance');
    assert.ok(status.lastError);
    await boards.close();
  } finally { await f.close(); }
  const { ActionJobs, captureContext } = await import('../src/actions.ts');
  const g = await fixture();
  try {
    const [s0] = g.segments();
    assert.throws(() => captureContext(g.store, g.meeting.id, { text: 'x', segmentIds: [s0.id], revisions: { [s0.id]: s0.revision + 1 } }, Date.now(), null, []), /changed since the card/);
    let release!: () => void;
    const runner = async () => { await new Promise<void>(r => { release = r; }); throw new Error('stop'); };
    const jobs = new ActionJobs({ store: g.store, directory: g.directory, runner: runner as any, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [] });
    const request = { action: 'explain', selection: { text: 'x', segmentIds: [s0.id] }, prompt: 'Why?' };
    const a = await jobs.submit(g.meeting.id, { ...request, origin: 'card', cardId: 'card-a' });
    const b = await jobs.submit(g.meeting.id, { ...request, origin: 'card', cardId: 'card-b' });
    assert.equal(b.merged, true);
    assert.deepEqual(jobs.get(a.job.id)!.cardIds, ['card-b'], 'the second card keeps its association');
    while (!release) await new Promise(r => setTimeout(r, 5));
    release();
    await jobs.close();
  } finally { await g.close(); }
});

test('a quote made only of earlier lines does not count, even with an unrelated new line cited', async () => {
  const lines = ['Please do', 'stack the painted miniatures beside the radiator', 'The spare dice are in the orange pouch'];
  const f = await fixture(lines, 5_000);
  try {
    const segs = f.segments();
    const covered = { [segs[0].id]: segs[0].revision, [segs[1].id]: segs[1].revision }; // S1, S2 already scanned
    const window = scanWindow(segs, covered)!;
    const r = (i: number) => window.lines.find(l => l.segment.text === lines[i])!.ref;
    const item = { type: 'decision', text: 'Stack the painted miniatures beside the radiator.', confidence: 'high', materials: true, nonProject: false };
    const { kept, dropped } = validateItems({ items: [{ ...item, cites: [r(0), r(1), r(2)], quote: 'Please do stack the painted miniatures' }] }, window, segs);
    assert.deepEqual([kept.length, dropped[0]?.reason], [0, 'quote is only in earlier lines']);
  } finally { await f.close(); }
});
