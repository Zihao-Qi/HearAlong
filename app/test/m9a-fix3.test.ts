import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composePreview, miniLog, miniPreviewWords } from '../public/preview-composition.js';
import { transcriptRows } from '../public/transcript-view.js';
import { handoffCases, active, pending, final, words, source } from './fixtures/m9a-handoff.ts';

test('M9a fix 3 B: slow replay keeps one post-cut row and one key as ownership advances', () => {
  let key: string | undefined;
  for (const step of handoffCases()[1].steps.slice(1)) {
    const post = composePreview(step.drafts, step.pending, step.segments).filter(r => r.part !== 'before');
    assert.equal(post.length, 1, 'active replay and pending tail must not be separate display rows');
    assert.equal(post[0].text, 'four five six');
    key ??= post[0].key;
    assert.equal(post[0].key, key, 'row identity must not depend on which stream currently owns a word');
  }
});

test('M9a fix 3 B: only finals and before-cut text split the post-cut lane', () => {
  const d = { ...active(3, 4), committedUntilMs: 3400, coveredUntilMs: 8300,
    words: [3100, 4100, 6100, 8100].map((startMs, i) => ({ text: `post${i}`, startMs, endMs: startMs + 200 })) };
  const p = { ...pending('middle', 6, 8, [{ text: 'before', startMs: 7100, endMs: 7300 }]), committedUntilMs: 6000 };
  const f = { ...final('barrier', 5, 6), source: 'tab:barrier', startMs: 5000, endMs: 5500 };
  const rows = composePreview([d], [p], [f]);
  assert.deepEqual(rows.filter(r => r.part !== 'before').map(r => r.text), ['post0 post1', 'post2', 'post3']);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
});

test('M9a fix 3 C: before-cut rows use their first word time and share their final row key', () => {
  const delayed = { ...pending('delayed', 0, 5), words: words.slice(0, 3).map(w => ({ ...w, startMs: w.startMs + 2300, endMs: w.endMs + 2300 })) };
  const them = { ...final('them', 0, 1), source: 'tab:them', startMs: 1000, endMs: 1800 };
  const rows = transcriptRows({ segments: [them], drafts: [], pending: [delayed] });
  assert.deepEqual(rows.map(r => r.startMs), [1000, 2400]);
  const completed = transcriptRows({ segments: [them, { ...final('delayed', 0, 3), startMs: 2400, endMs: 4700 }], drafts: [], pending: [] });
  assert.equal(rows[1].key, completed[1].key);
});

test('M9a fix 3 E: a later final never pulls a pending tail away from active replay', () => {
  const finals = [{ ...final('c1', 0, 3), speaker: 'Me' },
    { ...final('them', 4, 5), source: 'tab:them', speaker: 'Them', startMs: 4500, endMs: 4900, text: 'agreed' }];
  const drafts = [active(3, 4)], waiting = [pending('c1', 0, 3, words.slice(3))];
  const log = miniLog(finals, drafts, waiting);
  assert.deepEqual(log.placements, [], 'only before-cut text may be promoted, never a tail');
  assert.equal(miniPreviewWords(source, finals, drafts, waiting, 20, log.placements), 'four five six');
});

test('M9a fix 3 E: finalized and placed words do not consume the newest-20 preview budget', () => {
  const finals = [final('c1', 0, 3), { ...final('c2', 5, 9), text: Array.from({ length: 20 }, (_, i) => `final${i}`).join(' ') }];
  assert.equal(miniPreviewWords(source, finals, [active(3, 5)], []), 'four five');
  const d = { ...active(10, 10), words: Array.from({ length: 25 }, (_, i) => ({ text: `live${i}`, startMs: 10000 + i * 100, endMs: 10050 + i * 100 })) };
  const waiting = [pending('earlier', 0, 3, words.slice(0, 3))];
  const log = miniLog(finals, [d], waiting);
  assert.equal(miniPreviewWords(source, finals, [d], waiting, 20, log.placements), d.words.slice(-20).map(w => w.text).join(' '));
});
