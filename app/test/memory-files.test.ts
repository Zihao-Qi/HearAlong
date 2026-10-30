import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MeetingStore } from '../src/store.ts';
import { Memory } from '../src/memory.ts';
import { Proposals } from '../src/proposals.ts';
import { MemoryFiles, parseLines, recentCommits, render } from '../src/memory-files.ts';
import type { Project } from '../src/projects.ts';
import type { NotesRunner } from '../src/notes.ts';

const DAY = 24 * 3600 * 1000;

async function fixture(options: { repo?: boolean; answers?: unknown[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-files-'));
  const repo = join(directory, 'repo');
  if (options.repo) await mkdir(repo);
  const store = new MeetingStore(directory);
  let now = Date.UTC(2031, 4, 17, 8);
  const clock = () => now;
  const memory = new Memory(store, clock);
  const proposals = new Proposals(store, memory, { runner: null, directory, clock, notesFor: async () => null, projectOf: () => 'p' });
  const answers = options.answers ?? [];
  const calls: string[] = [];
  const runner: NotesRunner = async ({ inputPath }) => {
    calls.push(await readFile(inputPath, 'utf8'));
    const answer = answers.shift() ?? { results: [] };
    if (answer instanceof Error) throw answer;
    return { text: JSON.stringify(answer) } as any;
  };
  const project: Project = { id: 'p', name: 'Tidepool Care', repoPath: options.repo ? repo : null, createdAt: 0, planAfterNotes: false };
  const files = new MemoryFiles(store, memory, proposals, { directory, clock, project: () => project, projects: () => [project], meetingTitle: () => 'Evening tank inspection', interpreter: runner, guesser: runner });
  const add = (type: 'todo' | 'decision' | 'question', text: string, actor: 'ai' | 'user' = 'user') => memory.apply('p', { requestId: randomUUID(), actor, changes: [{ op: 'create', type, text, source: { kind: 'app' } }] });
  return { directory, repo, store, memory, proposals, files, project, calls, answers, add, tick: (ms: number) => { now += ms; },
    async close() { await files.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('last-sync skipped count includes refused links and oversized files, bounds names, and clears after repair', async () => {
  const f = await fixture({ repo: true });
  try {
    assert.equal(f.files.state('p').skipped, 0);
    assert.equal((await f.files.sync('p')).skipped, 0);
    const folder = join(f.repo, 'project-memory');
    const target = join(f.directory, 'fictional-note.md');
    await writeFile(target, 'Inventory the fictional aquarium supplies.');
    await symlink(target, join(folder, 'inbox', 'linked.md'));
    await link(target, join(folder, 'inbox', 'hardlinked.md'));
    await writeFile(join(folder, 'inbox', 'large.md'), 'x'.repeat(1024 * 1024 + 1));
    const status = await f.files.sync('p');
    assert.equal(status.skipped, 3);
    assert.deepEqual(status.skippedFiles?.sort(), ['inbox/hardlinked.md', 'inbox/large.md', 'inbox/linked.md']);
    for (let i = 0; i < 21; i++) await symlink(target, join(folder, 'inbox', `refused-${i}.md`));
    const many = await f.files.sync('p');
    assert.equal(many.skipped, 24);
    assert.equal(many.skippedFiles?.length, 20);
    for (const name of await readdir(join(folder, 'inbox'))) await rm(join(folder, 'inbox', name));
    assert.equal((await f.files.sync('p')).skipped, 0, 'not a cumulative count');
    await rm(f.repo, { recursive: true });
    assert.equal((await f.files.sync('p')).skipped, 0, 'missing repo still has a complete status');
  } finally { await f.close(); }
});

test('inbox notes longer than 2,000 characters are interpreted in full', async () => {
  const tail = 'Finally, inventory the spare aerator stones.';
  const text = `${'The quarantine tanks use labeled cleaning buckets. '.repeat(100)}\n${tail}`;
  const f = await fixture({ repo: true, answers: [{ results: [{ source: 'S1', changes: [{ kind: 'new', type: 'todo', text: tail }] }] }] });
  try {
    await f.files.sync('p');
    const inbox = join(f.repo, 'project-memory', 'inbox');
    await writeFile(join(inbox, 'long.md'), text);
    await f.files.sync('p');
    assert.ok(f.calls[0].includes(text), 'the interpreter receives the entire note, including its last change');
    assert.equal((f.memory.timeline('p', 'T-1')[0].source as any).note, text);
    assert.deepEqual(await readdir(inbox), []);
  } finally { await f.close(); }
});

test('a later file edit is compared against accepted changes while other proposals wait', async () => {
  const f = await fixture({ repo: true });
  try {
    f.add('todo', 'Scrub the intake screen');
    f.add('todo', 'Count spare hose clamps');
    await f.files.sync('p');
    const path = join(f.repo, 'project-memory', 'todos.md');
    const written = await readFile(path, 'utf8');
    const checked = written.replace('- [ ] T-1 ·', '- [x] T-1 ·').replace('- [ ] T-2 ·', '- [x] T-2 ·');
    await writeFile(path, checked);
    await f.files.sync('p');
    f.proposals.accept('p', f.proposals.list('p')[0].id, { requestId: randomUUID() });
    f.files.resolveCaptures('p');
    await writeFile(path, checked.replace('- [x] T-1', '- [ ] T-1'));
    await f.files.sync('p');
    const plans = f.proposals.list('p');
    assert.equal(plans.length, 2);
    const reopen = plans.find(p => p.targets['T-1'])!;
    assert.match(reopen.summary, /T-1 reopened/);
    f.proposals.accept('p', reopen.id, { requestId: randomUUID() });
    f.proposals.accept('p', plans.find(p => p.targets['T-2'])!.id, { requestId: randomUUID() });
    f.files.resolveCaptures('p');
    await f.files.sync('p');
    assert.equal(f.memory.item('p', 'T-1')!.status, 'open');
    assert.match(await readFile(path, 'utf8'), /- \[ \] T-1/);
  } finally { await f.close(); }
});

test('a rejected file edit repeated after regeneration makes a new capture', async () => {
  const f = await fixture({ repo: true });
  try {
    f.add('todo', 'Label the rinse bucket');
    await f.files.sync('p');
    const path = join(f.repo, 'project-memory', 'todos.md');
    const written = await readFile(path, 'utf8');
    const edited = written.replace('- [ ] T-1', '- [x] T-1');
    await writeFile(path, edited);
    await f.files.sync('p');
    const first = f.proposals.list('p')[0];
    f.proposals.reject('p', first.id);
    f.files.resolveCaptures('p');
    await f.files.sync('p');
    assert.equal(await readFile(path, 'utf8'), written, 'the rejected edit is regenerated once');
    await writeFile(path, edited);
    await f.files.sync('p');
    const [second] = f.proposals.list('p');
    assert.ok(second, 'the same outside edit is offered again');
    assert.notEqual(second.capture, first.capture);
    await f.files.sync('p');
    assert.equal(f.proposals.list('p').length, 1, 'the outstanding capture is not duplicated');
    assert.equal(await readFile(path, 'utf8'), edited);
    f.proposals.reject('p', second.id);
    f.files.resolveCaptures('p');
    await f.files.sync('p');
    await writeFile(path, `${written}\n`); // no change to any item
    await f.files.sync('p');
    await f.files.sync('p');
    assert.equal(await readFile(path, 'utf8'), written, 'an edit with no changes is regenerated too');
    const count = f.store.db.prepare('SELECT count(*) AS n FROM memory_captures').get();
    await f.files.sync('p');
    assert.deepEqual(f.store.db.prepare('SELECT count(*) AS n FROM memory_captures').get(), count);
  } finally { await f.close(); }
});

test('the files show current state; closed items leave after 30 days; output is deterministic', async () => {
  const f = await fixture();
  try {
    f.add('todo', 'Replace the cracked feeding scoop');
    f.add('todo', 'Remove the faded tank label');
    f.add('decision', 'Use amber lights during the evening feed', 'ai');
    f.memory.apply('p', { requestId: randomUUID(), actor: 'user', changes: [{ op: 'status', item: 'T-2', to: 'done', source: { kind: 'app' } }] });
    f.memory.apply('p', { requestId: randomUUID(), actor: 'ai', changes: [{ op: 'addSource', item: 'T-1', source: { kind: 'meeting', meetingId: 'm2' } }] });
    const now = Date.UTC(2031, 4, 17, 8);
    const files = render(f.memory, 'p', now, () => 'Evening tank inspection');
    assert.equal(JSON.stringify(render(f.memory, 'p', now, () => 'Evening tank inspection')), JSON.stringify(files), 'same state and date, same bytes');
    assert.match(files['todos.md'], /- \[ \] T-1 · Replace the cracked feeding scoop · owner: — · since May 17 · raised again May 17/);
    assert.match(files['todos.md'], /## Closed in the last 30 days\n\n- \[x\] T-2 · Remove the faded tank label/);
    assert.match(files['decisions.md'], /- D-1 · Use amber lights during the evening feed · since May 17 · unconfirmed/);
    assert.doesNotMatch(render(f.memory, 'p', now + 31 * DAY, () => '')['todos.md'], /T-2/, 'a month later only open items remain');
    assert.match(files['history/2031-05.md'], /T-1 raised again · meeting "Evening tank inspection" · AI-recorded/);
    assert.deepEqual(parseLines(files['todos.md']).lines.map(l => [l.id, l.checked]), [['T-1', false], ['T-2', true]]);
  } finally { await f.close(); }
});

test('an edit in a file is read back for the user\'s OK; the file is kept until resolved; a checked-out old version is not an edit', async () => {
  const f = await fixture({ repo: true });
  try {
    f.add('todo', 'Replace the worn siphon bulb');
    f.add('todo', 'Restock the quarantine cabinet');
    await f.files.sync('p');
    const path = join(f.repo, 'project-memory', 'todos.md');
    const written = await readFile(path, 'utf8');
    assert.equal((await readdir(join(f.repo, 'project-memory'))).sort().join(), 'README.md,brief.md,decisions.md,history,inbox,questions.md,todos.md');
    // The user ticks T-1 and deletes the T-2 line (a missing line is no change).
    const edited = written.replace('- [ ] T-1 ·', '- [x] T-1 ·').split('\n').filter(l => !l.includes('T-2')).join('\n');
    await writeFile(path, edited);
    await f.files.sync('p');
    const [proposal] = f.proposals.list('p');
    assert.equal(f.proposals.list('p').length, 1);
    assert.match(proposal.summary, /^T-1 ticked as done/);
    assert.deepEqual(proposal.flags, ['no source given']);
    assert.equal(await readFile(path, 'utf8'), edited, 'the edit stays in the file while it waits');
    f.add('todo', 'Hang the spare net');
    await f.files.sync('p');
    assert.equal(await readFile(path, 'utf8'), edited, 'memory changes do not overwrite a pending edit');
    f.proposals.accept('p', proposal.id, { requestId: randomUUID() });
    f.files.resolveCaptures('p');
    await f.files.sync('p');
    const regenerated = await readFile(path, 'utf8');
    assert.match(regenerated, /- \[x\] T-1 · Replace the worn siphon bulb/);
    assert.match(regenerated, /T-2 · Restock the quarantine cabinet/, 'the deleted line comes back: deleting is not dropping');
    assert.match(regenerated, /T-3 · Hang the spare net/);
    // An older version the app wrote (a branch checkout) is stale output: rewritten, never read as an edit.
    await writeFile(path, written);
    await f.files.sync('p');
    assert.equal(await readFile(path, 'utf8'), regenerated);
    assert.equal(f.proposals.list('p').length, 0);
  } finally { await f.close(); }
});

test('an outside edit is stored before it is read: one left unread when the app stopped is read at the next start', async () => {
  const f = await fixture({ repo: true });
  try {
    f.add('todo', 'Flush the nursery drain');
    await f.files.sync('p');
    const path = join(f.repo, 'project-memory', 'todos.md');
    const written = await readFile(path, 'utf8');
    const edited = written.replace('- [ ] T-1 ·', '- [x] T-1 ·');
    // As if the app stopped during the model call: the edit is stored ("processing"), nothing read yet.
    const base = f.store.db.prepare("SELECT hash FROM memory_files WHERE project='p' AND file='todos.md' AND current=1").get() as { hash: string };
    f.store.db.prepare("INSERT INTO memory_captures (id,project,file,content,hash,baseHash,status,at) VALUES (?,?,?,?,?,?,'processing',0)")
      .run(randomUUID(), 'p', 'todos.md', edited, 'h-edited', base.hash);
    await writeFile(path, '- [x] T-1 · Flush the nursery drain · a later edit overwrote the file\n');
    await f.files.sync('p');
    assert.ok(f.proposals.list('p').some(p => /^T-1 ticked as done/.test(p.summary)), 'the stored edit was read');
  } finally { await f.close(); }
});

test('an unreadable edit makes no changes; brief.md edits become the brief; a missing repo pauses the files', async () => {
  const f = await fixture({ repo: true });
  try {
    f.add('todo', 'Refill the handwash dispenser');
    await f.files.sync('p');
    const folder = join(f.repo, 'project-memory');
    const todos = await readFile(join(folder, 'todos.md'), 'utf8');
    await writeFile(join(folder, 'todos.md'), `${todos}\n- [x] T-1 · Duplicate line\n`);
    await f.files.sync('p');
    const [capture] = f.files.pendingCaptures('p');
    assert.match(capture.problems!, /T-1 appears twice/);
    assert.equal(f.proposals.list('p').length, 0);
    f.files.dismissCapture('p', capture.id);
    await f.files.sync('p');
    assert.equal(await readFile(join(folder, 'todos.md'), 'utf8'), todos, 'after "Done with this edit" the file is regenerated');
    await writeFile(join(folder, 'brief.md'), '# Brief\n\nThe touch pool is closed while its inlet grille is repaired.\n');
    await f.files.sync('p');
    assert.deepEqual([f.memory.brief('p')!.text, f.memory.brief('p')!.actor], ['The touch pool is closed while its inlet grille is repaired.', 'file']);
    await rm(f.repo, { recursive: true });
    assert.equal((await f.files.sync('p')).state, 'repo missing');
    await assert.rejects(readdir(f.repo), /ENOENT/, 'the repo folder is never recreated');
  } finally { await f.close(); }
});

test('agent notes in the inbox: unfinished .tmp ignored, each note read once, archived out of the repo', async () => {
  const f = await fixture({ repo: true, answers: [{ results: [{ source: 'S1', changes: [{ kind: 'update', target: 'T-1', sure: true, status: 'done' }, { kind: 'new', type: 'todo', text: 'Label the feeder breaker' }] }] }] });
  try {
    f.add('todo', 'Install the feeder cutoff');
    await f.files.sync('p');
    const inbox = join(f.repo, 'project-memory', 'inbox');
    await writeFile(join(inbox, '2031-05-19-t1.tmp'), 'T-1 done — the cutoff sw');
    await f.files.sync('p');
    assert.equal(f.calls.length, 0, 'a note still being written is not read');
    const note = 'T-1 done — commit cafeabc adds the safety relay (src/feeder.py). Next: label the feeder breaker.';
    await writeFile(join(inbox, '2031-05-19-t1.md'), note);
    await f.files.sync('p');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.memory.items('p').map(i => [i.id, i.status, i.confirmed]), [['T-1', 'open', true], ['T-2', 'open', false]], 'the addition is recorded; the status change waits');
    assert.equal(f.memory.timeline('p', 'T-2')[0].actor, 'agent:2031-05-19-t1');
    assert.match(f.proposals.list('p')[0].summary, /^T-1 done/);
    assert.deepEqual(await readdir(inbox), ['2031-05-19-t1.tmp'], 'the note left the repo');
    assert.equal((await readdir(join(f.directory, 'projects', 'p', 'inbox-read'))).length, 1);
    await writeFile(join(inbox, '2031-05-19-t1.md'), note); // restored by git
    await f.files.sync('p');
    assert.equal(f.calls.length, 1, 'a note already read is not read again');
    assert.equal(f.memory.items('p').length, 2);
  } finally { await f.close(); }
});

test('an inbox note that cannot be read stays and is retried later; one that leads to nothing is shown; neither vanishes unseen', async () => {
  const f = await fixture({ repo: true, answers: [new Error('rate limited'), { results: [{ source: 'S1', changes: [{ kind: 'skip', reason: 'nothing to record' }] }] }] });
  try {
    f.add('todo', 'Replace the air manifold gasket');
    await f.files.sync('p');
    const inbox = join(f.repo, 'project-memory', 'inbox');
    await writeFile(join(inbox, '2031-05-19-a.md'), 'The gasket shipment is still sealed on the loading shelf. No work completed.');
    await f.files.sync('p');
    assert.deepEqual(f.files.inboxNotices('p').map(n => [n.name, n.state, n.attempts]), [['2031-05-19-a.md', 'failed', 1]]);
    await f.files.sync('p');
    assert.equal(f.calls.length, 1, 'not retried before the wait is over');
    assert.deepEqual(await readdir(inbox), ['2031-05-19-a.md'], 'the note stays in the repo');
    f.tick(61_000);
    await f.files.sync('p');
    assert.equal(f.calls.length, 2);
    const [notice] = f.files.inboxNotices('p');
    assert.equal(notice.state, 'empty', 'read, nothing recorded: shown until dismissed');
    assert.deepEqual(await readdir(inbox), [], 'archived like any read note');
    f.files.dismissInbox('p', notice.hash);
    assert.equal(f.files.inboxNotices('p').length, 0);
  } finally { await f.close(); }
});

test('files change only when what they show changes; history and README edits are rewritten; a folder the app did not write is left alone', async () => {
  const f = await fixture({ repo: true });
  try {
    f.add('todo', 'Mount the hose reel');
    await f.files.sync('p');
    const folder = join(f.repo, 'project-memory');
    const todos = await readFile(join(folder, 'todos.md'), 'utf8');
    f.tick(3 * DAY);
    await f.files.sync('p');
    assert.equal(await readFile(join(folder, 'todos.md'), 'utf8'), todos, 'a new day alone rewrites nothing');
    f.memory.apply('p', { requestId: randomUUID(), actor: 'user', changes: [{ op: 'confirm', item: 'T-1' }] });
    f.add('todo', 'Wash the dip nets', 'ai');
    f.add('todo', 'Store the test strips', 'ai');
    f.memory.apply('p', { requestId: randomUUID(), actor: 'user', changes: [{ op: 'confirm', item: 'T-2' }, { op: 'confirm', item: 'T-3' }] });
    const history = render(f.memory, 'p', Date.UTC(2031, 4, 20, 8), () => '')['history/2031-05.md'];
    assert.match(history, /confirmed T-2, T-3 · by the user\n/, 'one line per Confirm all');
    assert.doesNotMatch(history, /by the user · by the user/);
    await f.files.sync('p');
    const month = join(folder, 'history', '2031-05.md');
    await writeFile(month, '<<<<<<< merge conflict\n');
    await f.files.sync('p');
    assert.match(await readFile(month, 'utf8'), /^# Changes in 2031-05/, 'history is the app\'s: rewritten, never frozen');
    // Another project pointed at a repo with someone else's project-memory/ folder.
    const other = join(f.directory, 'other');
    await mkdir(join(other, 'project-memory'), { recursive: true });
    await writeFile(join(other, 'project-memory', 'brief.md'), 'Not ours.');
    f.project.repoPath = other;
    assert.equal((await f.files.sync('p')).state, 'not ours');
    assert.equal(await readFile(join(other, 'project-memory', 'brief.md'), 'utf8'), 'Not ours.');
    assert.equal(f.memory.brief('p'), null, 'its brief.md is not read as an edit');
  } finally { await f.close(); }
});

test('repo history: commits that only touch project-memory are skipped; finished work is proposed with a guessed commit', async () => {
  const f = await fixture({ repo: true });
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', f.repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2031-05-19T09:00:00Z', GIT_COMMITTER_DATE: '2031-05-19T09:00:00Z' } }).toString();
    git('init', '-q');
    await writeFile(join(f.repo, 'feeder.py'), 'relay_enabled = False\n');
    git('add', '.'); git('commit', '-qm', 'Add a safety cutoff for the night feeder');
    f.add('todo', 'Install the feeder cutoff');
    await f.files.sync('p');
    git('add', '.'); git('commit', '-qm', 'Update project memory');
    const commits = await recentCommits(f.repo, 10);
    assert.deepEqual(commits.map(c => c.subject), ['Add a safety cutoff for the night feeder']);
    f.answers.push({ done: [{ todo: 'T-1', commit: commits[0].hash.slice(0, 10) }] });
    const result = await f.files.finishedWork('p');
    assert.deepEqual([result.proposed, result.commits], [1, 1]);
    const [proposal] = f.proposals.list('p');
    assert.match(proposal.summary, /^T-1 may be done/);
    assert.deepEqual([proposal.source.kind, (proposal.source as any).guessed], ['commit', true]);
    assert.deepEqual((await f.files.finishedWork('p')).commits, 0, 'the next check starts after the last one');
    await writeFile(join(f.repo, 'feeder.py'), 'relay_enabled = True\n');
    git('add', '.'); git('commit', '-qm', 'Wire the feeder cutoff switch');
    const calls = f.calls.length;
    assert.equal((await f.files.finishedWork('p')).proposed, 0);
    assert.equal(f.calls.length, calls, 'a to-do already waiting for an OK is not asked about again');
  } finally { await f.close(); }
});
