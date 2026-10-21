import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchRoots } from '../src/materials.ts';
import { MeetingStore } from '../src/store.ts';
import { Projects, meetingScope } from '../src/projects.ts';

async function fixture(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const store = new MeetingStore(directory);
  const projects = new Projects(store, directory);
  const meeting = store.createMeeting('M');
  return { directory, store, projects, meeting, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('only explicit roots are searched; secrets and escaping symlinks are excluded', async () => {
  const f = await fixture('meeting-materials-');
  try {
    const project = join(f.directory, 'project');
    await mkdir(project);
    await writeFile(join(project, 'results.csv'), 'experiment,accuracy\nfirst,0.92');
    await writeFile(join(project, '.env'), 'accuracy=PRIVATE');
    await writeFile(join(project, 'credentials.json'), '{"accuracy":"PRIVATE"}');
    await writeFile(join(f.directory, 'outside.txt'), 'accuracy OUTSIDE');
    await symlink(join(f.directory, 'outside.txt'), join(project, 'escape.txt'));
    assert.equal((await searchRoots(f.projects.rootsFor(f.meeting.id), 'accuracy')).scanned, 0);
    const root = await f.projects.addRoot(meetingScope(f.meeting.id), project);
    const result = await searchRoots(f.projects.rootsFor(f.meeting.id), 'accuracy');
    assert.deepEqual(result.hits.map(hit => hit.file), ['results.csv']);
    assert.equal(result.hits[0].line, 1);
    const other = f.store.createMeeting('Other');
    assert.equal((await searchRoots(f.projects.rootsFor(other.id), 'accuracy')).scanned, 0);
    assert.equal(new Projects(f.store, f.directory).rootsFor(f.meeting.id)[0].id, root.id, 'roots are saved');
    await assert.rejects(f.projects.addRoot(meetingScope(f.meeting.id), join(project, '.env')), /excluded/);
    assert.throws(() => f.projects.removeRoot(other.id, root.id), /No such material/, 'another meeting cannot remove it');
    f.projects.removeRoot(f.meeting.id, root.id);
    assert.equal((await searchRoots(f.projects.rootsFor(f.meeting.id), 'accuracy')).scanned, 0);
  } finally { await f.close(); }
});

test('without PDF text, a PDF filename match says it is not extracted content', async () => {
  const f = await fixture('meeting-pdf-');
  try {
    const pdf = join(f.directory, 'algorithm.pdf');
    await writeFile(pdf, 'Not parsed in this milestone');
    await f.projects.addRoot(meetingScope(f.meeting.id), pdf);
    const result = await searchRoots(f.projects.rootsFor(f.meeting.id), 'algorithm');
    assert.equal(result.skipped, 1);
    assert.match(result.hits[0].text, /^Filename match only/);
    assert.equal(result.hits[0].line, null);
  } finally { await f.close(); }
});

test('an unreadable file is reported without failing the whole search', async () => {
  const f = await fixture('meeting-unreadable-');
  const folder = join(f.directory, 'docs');
  const locked = join(folder, 'locked.md');
  try {
    await mkdir(folder);
    await writeFile(join(folder, 'results.csv'), 'accuracy,0.9');
    await writeFile(locked, 'accuracy hidden');
    await chmod(locked, 0o000);
    await f.projects.addRoot(meetingScope(f.meeting.id), folder);
    const result = await searchRoots(f.projects.rootsFor(f.meeting.id), 'accuracy');
    assert.deepEqual(result.hits.map(hit => hit.file), ['results.csv']);
    assert.deepEqual(result.errors, [{ file: 'locked.md', error: 'EACCES' }]);
  } finally { await chmod(locked, 0o600); await f.close(); }
});
