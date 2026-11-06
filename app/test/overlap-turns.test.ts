import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { paragraphsOf, signatureLines } from '../public/live-shared.js';
import { transcriptRows } from '../public/transcript-view.js';
import { miniLog } from '../public/preview-composition.js';
import { MeetingStore } from '../src/store.ts';
import { overlapLines, overlapText } from './fixtures/overlap-turns.ts';

const texts = (ps: { segments: { text?: string }[] }[]) => ps.map(p => p.segments.map(s => s.text).join(' '));
const line = (id: string, startMs: number, endMs: number, text: string, speaker?: string) => ({ id, startMs, endMs, text, revision: 0, ...(speaker ? { speaker } : {}) });

test('overlapping sentences join across sources and chunk boundaries in every display grouper; live keys stay put', () => {
  const before = transcriptRows({ segments: overlapLines.slice(0, 2), drafts: [], pending: [], labelled: true });
  const after = transcriptRows({ segments: overlapLines, drafts: [], pending: [], labelled: true });
  assert.deepEqual(texts(paragraphsOf(overlapLines)), overlapText);
  assert.deepEqual(texts(after), overlapText);
  assert.deepEqual(after.map(p => p.key), before.map(p => p.key));
  const miniBefore = miniLog(overlapLines.slice(0, 2), [], []).paragraphs;
  const miniAfter = miniLog(overlapLines, [], []).paragraphs;
  assert.deepEqual(texts(miniAfter), overlapText);
  assert.deepEqual(miniAfter.map(p => p.key), miniBefore.map(p => p.key));
  assert.deepEqual(signatureLines(miniAfter[0].signature), [overlapLines[0].id, overlapLines[2].id, overlapLines[4].id]);
});

for (const labelled of [true, false]) test(`sentence-aware pauses and length limits (labelled=${labelled})`, () => {
  const speaker = labelled ? 'Me' : undefined;
  for (const text of ['unfinished,', 'unfinished —', 'unfinished', '3.5 and e.g. inside a line']) {
    assert.equal(paragraphsOf([line('a', 0, 1000, text, speaker), line('b', 6000, 7000, 'continues.', speaker)]).length, 1, text);
    assert.equal(paragraphsOf([line('a', 0, 1000, text, speaker), line('b', 12000, 13000, 'later.', speaker)]).length, 2, text);
    assert.equal(paragraphsOf([line('a', 0, 1000, text, speaker), line('b', 11000, 12000, 'exactly ten.', speaker)]).length, 2);
  }
  for (const end of ['.', '?', '!', '…', '."', '?\')', '!]', '…”', '.’)]', '.»', '!）', '?】', '!」']) {
    const first = line('a', 0, 1000, `Finished${end}  `, speaker);
    assert.equal(paragraphsOf([first, line('b', 4000, 5000, 'New.', speaker)]).length, 2, end);
    assert.equal(paragraphsOf([first, line('b', 2999, 4000, 'Soon.', speaker)]).length, 1, end);
    assert.equal(paragraphsOf([first, line('b', 3000, 4000, 'Exactly two.', speaker)]).length, 2, end);
  }
  const base = [line('a', 0, 20000, 'Still going', speaker), line('b', 20000, 44000, 'on,', speaker)];
  assert.equal(paragraphsOf([...base, line('c', 45000, 49000, 'until the end.', speaker)]).length, 1, '45 s waits for sentence end');
  assert.equal(paragraphsOf([...base, line('c', 45000, 49000, 'until the end.', speaker), line('d', 49000, 50000, 'Next.', speaker)]).length, 2);
  const long = [...base, line('c', 44000, 59000, 'still unfinished', speaker)];
  assert.equal(paragraphsOf([...long, line('d', 59999, 61000, 'continuing', speaker)]).length, 1);
  assert.equal(paragraphsOf([...long, line('d', 60000, 61000, 'hard cap', speaker)]).length, 2);
  assert.equal(paragraphsOf([line('a', 0, 44000, 'Done.', speaker), line('b', 45000, 46000, 'Next.', speaker)]).length, 2, 'sentence end at the soft limit');
});

test('three open speakers keep their own latest end and start-time order', () => {
  const lines = [line('a', 0, 20000, 'Alpha', 'A'), line('b', 1000, 2000, 'Beta', 'B'), line('c', 2000, 3000, 'Gamma', 'C'),
    line('b2', 7000, 8000, 'continues.', 'B'), line('c2', 9000, 10000, 'continues.', 'C'), line('a2', 21000, 22000, 'continues.', 'A')];
  assert.deepEqual(texts(paragraphsOf(lines)), ['Alpha continues.', 'Beta continues.', 'Gamma continues.']);
});

test('plain text and both Markdown modes share the overlap grouping, including original-text punctuation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overlap-exports-')), store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional garden');
    const sequences = new Map<string, number>();
    for (const s of overlapLines) {
      const source = s.source!, n = sequences.get(source) ?? 0;
      sequences.set(source, n + 1);
      const chunk = await store.addPcm(meeting.id, source, n, s.startMs, 16000, Buffer.alloc((s.endMs - s.startMs) * 64));
      store.completeChunk(chunk.id, { text: s.text, words: [], backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: chunk.seconds, processRssBytes: 0, timestampKind: 'none', retries: 0 });
    }
    assert.equal(store.plainText(meeting.id), `Fictional garden\n\nMe: ${overlapText[0]}\n\nThem: ${overlapText[1]}\n`);
    for (const mode of ['raw', 'corrected'] as const) {
      assert.ok(store.markdown(meeting.id, mode).endsWith(`[00:00:00] Me: ${overlapText[0]}\n\n[00:00:01] Them: ${overlapText[1]}\n`));
    }
    // A correction can change the sentence boundary; raw export must check original text instead.
    store.db.prepare("UPDATE segments SET text=text || '.', endMs=3000 WHERE startMs=0").run();
    assert.equal(store.markdown(meeting.id, 'raw').split('\n\n').length, 4);
    assert.equal(store.markdown(meeting.id, 'corrected').split('\n\n').length, 5);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('server mini delta invalidates its cached prefix when an earlier speaker paragraph grows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overlap-mini-api-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, drafts: null, recognizer: {
    async transcribe() { return { text: '', words: [], backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' }; }, close() {},
  } });
  try {
    const meeting = app.store.createMeeting('Fictional garden'), sequence = new Map<string, number>();
    const add = async (s: typeof overlapLines[number]) => {
      const source = s.source!, n = sequence.get(source) ?? 0; sequence.set(source, n + 1);
      const chunk = await app.store.addPcm(meeting.id, source, n, s.startMs, 16000, Buffer.alloc((s.endMs - s.startMs) * 64));
      app.store.completeChunk(chunk.id, { text: s.text, words: [], backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: chunk.seconds, processRssBytes: 0, timestampKind: 'none', retries: 0 });
    };
    for (const line of overlapLines.slice(0, 2)) await add(line);
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie, Origin: app.url };
    const source = `mic:${randomUUID()}`;
    assert.equal((await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64000), headers: {
      ...headers, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '30000', 'X-Recording': randomUUID(),
    } })).status, 201);
    const before = (await (await fetch(`${app.url}/api/live`, { headers })).json()).recording;
    assert.equal(before.paragraphs.length, 2);
    for (const line of overlapLines.slice(2)) await add(line);
    const after = (await (await fetch(`${app.url}/api/live?have=${encodeURIComponent(before.paragraphsTag)}`, { headers })).json()).recording;
    assert.equal(after.paragraphsFrom, 0, 'the old first paragraph is no longer a reusable prefix');
    assert.deepEqual(after.paragraphs.map((p: { key: string }) => p.key), before.paragraphs.map((p: { key: string }) => p.key));
    assert.deepEqual(after.paragraphs.map((p: { text: string }) => p.text), overlapText);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
