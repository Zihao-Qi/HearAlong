import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { captureGapText } from '../public/capture-gaps.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'transcript-download-'));
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, notes: null, actions: null, board: null });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const meeting = app.store.createMeeting('Forest recall');
  const request = (path: string, options: RequestInit = {}) => fetch(`${app.url}/api/meetings/${meeting.id}${path}`, {
    ...options, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' },
  });
  await mkdir(join(directory, 'notes'), { recursive: true });
  await writeFile(join(directory, 'notes', `${meeting.id}.json`), JSON.stringify({
    version: 1, createdAt: 1, model: 'scripted', meetingId: meeting.id, title: meeting.title, dropped: [], sources: {},
    input: { inputHash: 'fixture', coverage: { untilMs: 0, pendingChunks: 0, gaps: [], uncorrected: 0 }, glossaryVersion: null, segments: 0, takenAt: 1 },
    notes: { summary: [], decisions: [], actions: [], openQuestions: [], otherMatters: [], needsReview: [], otherTalk: [] },
  }));
  return { app, meeting, request, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('plain transcript shares Markdown paragraphs, corrections, speaker changes, gaps and failed chunks', async () => {
  const f = await fixture();
  try {
    const { store } = f.app;
    for (const [source, sequence, startMs, text] of [
      ['tab:fixture', 0, 0, 'Forest north.'], ['mic:fixture', 0, 1000, 'Use the per site table.'],
      ['mic:fixture', 1, 2000, 'Keep precision.'], ['mic:fixture', 2, 6000, 'Rerun it.'], ['tab:fixture', 1, 10000, ''],
    ] as const) {
      const chunk = await store.addPcm(f.meeting.id, source, sequence, startMs, 16000, Buffer.alloc(64000, sequence + 1));
      store.completeChunk(chunk.id, { text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    }
    const segment = store.segments(f.meeting.id).find(s => s.text.startsWith('Use'))!;
    store.applyEdits(segment.id, 0, 'Use the per-site table.', []);
    const gaps = [
      { atMs: 4000, fromWallMs: 1000000, toWallMs: 1120000, reason: 'sleep' as const },
      { atMs: 5000, fromWallMs: 2000000, toWallMs: 2045000, reason: null },
    ];
    for (const g of gaps) store.db.prepare('INSERT INTO capture_gaps (meetingId,source,atMs,fromWallMs,toWallMs,reason) VALUES (?,?,?,?,?,?)')
      .run(f.meeting.id, 'mic:fixture', g.atMs, g.fromWallMs, g.toWallMs, g.reason);
    const failed = await store.addPcm(f.meeting.id, 'mic:fixture', 3, 8000, 16000, Buffer.alloc(64000, 4));
    store.db.prepare("UPDATE chunks SET status='failed',error='fixture error' WHERE id=?").run(failed.id);
    const md = store.markdown(f.meeting.id, 'corrected', 'en-US');
    const expected = ['Them: Forest north.', 'Me: Use the per-site table. Keep precision.',
      ...gaps.map(g => `*${captureGapText(g, 'en-US')}*`), 'Me: Rerun it.', '[failed: fixture error]'];
    const stamps = ['00:00:00', '00:00:01', '00:00:04', '00:00:05', '00:00:06', '00:00:08'];
    assert.equal(md, '# Forest recall\n\nTranscript — Glossary-corrected where marked in the app; raw export is available. Speaker labels are capture channels: "Them" is the meeting tab (everyone on the call), "Me" is this microphone during the call. Not verified meeting decisions.\n\n'
      + expected.map((p, i) => `[${stamps[i]}] ${p}`).join('\n\n') + '\n');
    const response = await f.request('/transcript.txt');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    const txt = await response.text();
    const plain = [...expected];
    plain[2] = '[Not recorded for 2 minutes: the Mac was asleep.]';
    plain[3] = '[Not recorded for 45 seconds.]';
    assert.equal(txt, 'Forest recall\n\n' + plain.join('\n\n') + '\n');
    const mdParagraphs = md.trimEnd().split('\n\n').slice(2);
    const txtParagraphs = txt.trimEnd().split('\n\n').slice(1);
    for (const i of [0, 1, 4, 5]) assert.equal(txtParagraphs[i], mdParagraphs[i].replace(/^\[\d\d:\d\d:\d\d\] /, ''));
    assert.doesNotMatch(txt, /\[\d\d:\d\d:\d\d\]|Transcript —|\*Not recorded/);
    const raw = await (await f.request('/transcript.md?mode=raw')).text();
    assert.match(raw, /Raw speech recognition, before glossary corrections\./);
    assert.match(raw, /Use the per site table/);
    assert.doesNotMatch(raw, /Use the per-site table/);
  } finally { await f.close(); }
});

test('empty transcript is only the title line; missing meeting is 404', async () => {
  const f = await fixture();
  try {
    assert.equal(await (await f.request('/transcript.txt')).text(), 'Forest recall\n');
    const cookie = (await fetch(f.app.url)).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${f.app.url}/api/meetings/missing/transcript.txt`, { headers: { Cookie: cookie } })).status, 404);
  } finally { await f.close(); }
});

test('all four attachment names sanitize the current title and provide UTF-8 plus ASCII fallback', async () => {
  const f = await fixture();
  try {
    const cases: [string, string][] = [
      ['Forest recall: Q3/Q4 café', 'Forest recall- Q3-Q4 café'],
      ['Café – Q3 😀 / \\ : * ? " < > |\u0001\u007f', 'Café – Q3 😀 - - - - - - - - ---'],
      ['...   ', 'Meeting'], ['   ', 'Meeting'], ['...  A\t B\n C  ', 'A- B- C'], ['A  B   C', 'A B C'],
      ['é'.repeat(300), 'é'.repeat(100)], ['a'.repeat(99) + '😀' + 'z'.repeat(200), 'a'.repeat(99) + '😀'],
    ];
    for (const [title, safe] of cases) {
      f.app.store.rename(f.meeting.id, title);
      for (const [route, suffix] of [['transcript.md', ' transcript.md'], ['transcript.md?mode=raw', ' transcript (raw).md'], ['transcript.txt', ' transcript.txt'], ['notes.md', ' notes.md']]) {
        const response = await f.request('/' + route);
        assert.equal(response.status, 200, route);
        const name = safe + suffix;
        const ascii = Array.from(name, c => c.codePointAt(0)! > 127 ? '_' : c).join('');
        const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        assert.equal(response.headers.get('content-disposition'), `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`, title + ' / ' + route);
      }
    }
    assert.equal((await f.request('', { method: 'PATCH', body: JSON.stringify({ title: 'Renamed café' }) })).status, 200);
    for (const route of ['transcript.md', 'transcript.md?mode=raw', 'transcript.txt', 'notes.md']) {
      assert.match((await f.request('/' + route)).headers.get('content-disposition')!, /filename="Renamed caf_/);
    }
  } finally { await f.close(); }
});
