import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paragraphsOf, paragraphCachePrefix } from '../public/live-shared.js';
import { transcriptRows } from '../public/transcript-view.js';
import { miniLog, type Preview, type PendingPreview } from '../public/preview-composition.js';
import { MeetingStore } from '../src/store.ts';

const line = (id: string, startMs: number, text: string, speaker: string) => ({ id, source: speaker === 'Me' ? 'mic:garden' : 'tab:garden',
  startMs, endMs: startMs + 500, text, revision: 0, speaker });
const lines = [line('a:0', 0, 'The purple lanterns', 'Me'), line('b:0', 1000, 'Our wooden turtles', 'Them'),
  line('c:0', 5000, 'glowed.', 'Me'), line('d:0', 7000, 'floated.', 'Them')];
const texts = (ps: { segments: { text?: string }[] }[]) => ps.map(p => p.segments.map(s => s.text).join(' '));

for (const kind of ['post', 'before'] as const) for (const speaker of ['Me', 'Them']) test(`${kind} preview closes only ${speaker}, not the other open speaker`, () => {
  const preview: Preview = { source: speaker === 'Me' ? 'mic:garden' : 'tab:garden', speaker, window: 'held', windowStartMs: 2000,
    committedUntilMs: 2000, coveredUntilMs: 3000, words: [{ text: 'violet', startMs: 2300, endMs: 2800 }], text: 'violet', behind: false };
  const drafts = kind === 'post' ? [preview] : [];
  const pending: PendingPreview[] = kind === 'before' ? [{ ...preview, chunkId: 'waiting', cutMs: 4000 }] : [];
  const expected = speaker === 'Them' ? ['The purple lanterns glowed.', 'Our wooden turtles', 'floated.']
    : ['The purple lanterns', 'Our wooden turtles floated.', 'glowed.'];
  assert.deepEqual(texts(transcriptRows({ labelled: true, segments: lines, drafts, pending }).filter(r => r.kind === 'final')), expected);
  assert.deepEqual(texts(miniLog(lines, drafts, pending).paragraphs), expected);
  const unlabelled = lines.map(({ speaker: _speaker, ...s }) => s);
  assert.equal(transcriptRows({ segments: unlabelled, drafts, pending }).filter(r => r.kind === 'final').length, 2, 'unlabelled preview still splits the one lane');
  assert.equal(miniLog(unlabelled, drafts, pending).paragraphs.length, 2);
});

test('shared barriers: capture gap closes all speakers, own-speaker barrier leaves the other open', () => {
  assert.deepEqual(texts(paragraphsOf(lines, [{ startMs: 2500, speaker: 'Them' }])), ['The purple lanterns glowed.', 'Our wooden turtles', 'floated.']);
  assert.deepEqual(texts(paragraphsOf(lines, [{ startMs: 2500, all: true }])), lines.map(s => s.text));
  const ps = paragraphsOf(lines);
  assert.equal(paragraphCachePrefix(ps, 8000), 0);
  const closedByPreview = paragraphsOf(lines, [{ startMs: 8000, speaker: 'Me' }]);
  assert.equal(paragraphCachePrefix(closedByPreview, 8000), 0, 'a temporary preview barrier does not make the preceding paragraph cacheable');
  assert.equal(paragraphCachePrefix(ps, 30000), ps.length, 'old speaker lanes do not stay mutable forever');
});

test('correction splits an earlier paragraph without moving a later paragraph key to another line of its chunk', () => {
  const segments = [line('first:0', 0, 'Silver boots', 'Me'), line('second:0', 4000, 'arrived.', 'Me'), line('second:1', 7000, 'Next parcel.', 'Me')];
  const before = transcriptRows({ segments });
  const after = transcriptRows({ segments: [{ ...segments[0], text: 'Silver boots.', revision: 1 }, ...segments.slice(1)] });
  assert.deepEqual(before.map(p => p.key), ['chunk:first', 'final:second:1']);
  assert.deepEqual(after.map(p => p.key), ['chunk:first', 'chunk:second', 'final:second:1']);
  assert.equal(before.at(-1)!.key, after.at(-1)!.key);
});

for (const status of ['failed', 'queued', 'running', 'cancelled'] as const) for (const labelled of [true, false]) test(`${status} chunk splits screen and exports identically (labelled=${labelled})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overlap-review-export-')), store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional lantern market'), seq = new Map<string, number>();
    if (labelled) {
      const c = await store.addPcm(meeting.id, 'tab:garden', 0, 0, 16000, Buffer.alloc(64000)); seq.set('tab:garden', 1);
      store.completeChunk(c.id, { text: '', words: [], backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    }
    const entries = [...lines, line('failed', 2500, '', 'Them')].sort((a, b) => a.startMs - b.startMs);
    for (const s of entries) {
      const source = labelled ? s.source : 'mic:garden', n = seq.get(source) ?? 0; seq.set(source, n + 1);
      const c = await store.addPcm(meeting.id, source, n, s.startMs, 16000, Buffer.alloc(32000));
      if (s.id === 'failed') store.setStatus(c.id, status, '', 'Fictional timeout');
      else store.completeChunk(c.id, { text: s.text, words: [], backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: 0.5, processRssBytes: 0, timestampKind: 'none' });
    }
    for (const mode of ['raw', 'corrected'] as const) {
      const exported = store.markdown(meeting.id, mode);
      assert.ok(exported.includes(`[${status}: Fictional timeout]`), 'keep the unavailable chunk notice in exports');
      const md = exported.replace(`[${status}: Fictional timeout]`, '[failed: Fictional timeout]');
      if (labelled) {
        assert.match(md, /Me: The purple lanterns glowed\./);
        assert.match(md, /Them: Our wooden turtles\n\n\[00:00:02\] \[failed: Fictional timeout\]\n\n\[00:00:07\] Them: floated\./);
      } else {
        assert.match(md, /The purple lanterns Our wooden turtles\n\n\[00:00:02\] \[failed: Fictional timeout\]\n\n\[00:00:05\] glowed\. floated\./);
      }
    }
    assert.equal(store.plainText(meeting.id).includes('Me: The purple lanterns glowed.'), labelled);
    const segments = store.segments(meeting.id).map(s => ({ ...s,
      ...(labelled ? { speaker: s.source.startsWith('tab:') ? 'Them' : 'Me' } : {}) }));
    const barriers = store.chunkParagraphBarriers(meeting.id);
    const main = texts(transcriptRows({ labelled, segments, paragraphBarriers: barriers }).filter(p => p.kind === 'final'));
    const mini = texts(miniLog(segments, [], [], [], barriers).paragraphs);
    const exported = store.plainText(meeting.id).trim().split('\n\n').slice(1).filter(p => !p.startsWith('[')).map(p => p.replace(/^(Me|Them): /, ''));
    assert.deepEqual(main, exported);
    assert.deepEqual(mini, exported);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
