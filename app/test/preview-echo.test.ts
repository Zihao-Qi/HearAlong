import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPreviewEchoes } from '../src/preview-echo.ts';
import type { Draft, PendingDraft } from '../src/drafts.ts';

const draft = (source: string, text: string, startMs = 10000): Draft => ({ meetingId: 'fictional', source, window: source, windowStartMs: startMs,
  text, behind: false, committedUntilMs: startMs, coveredUntilMs: startMs + 500,
  words: text.split(' ').map((text, i) => ({ text, startMs: startMs + i * 100, endMs: startMs + i * 100 + 90 })) });
const run = (mic: Draft, call: Draft, sources = ['app:call']) => filterPreviewEchoes([mic, call], [], sources, [], 13000);

test('an echoed microphone grey preview is hidden and the call remains unchanged', () => {
  const mic = draft('mic:room', 'The paper lantern is ready'), call = draft('app:call', 'The paper lantern is ready');
  const before = structuredClone([mic, call]);
  assert.deepEqual(run(mic, call).drafts, [{ ...mic, text: '', words: [] }, call], 'keep the active source heartbeat but no grey words');
  assert.deepEqual([mic, call], before, 'no hypotheses are mutated/retired');
  assert.deepEqual(run(mic, call, []).drafts, [mic, call], 'ending the call restores the unchanged preview');
});

test('genuine mic speech, no live call, and short replies remain unchanged', () => {
  const mic = draft('mic:room', 'Cobalt ocean harbor reef shell'), call = draft('app:call', 'The paper lantern is ready');
  assert.deepEqual(run(mic, call).drafts, [mic, call]);
  assert.deepEqual(run(mic, call, []).drafts, [mic, call]);
  for (const text of ['yes', 'okay then']) {
    const short = draft('mic:room', text), remote = draft('app:call', text);
    assert.deepEqual(run(short, remote).drafts, [short, remote]);
  }
});

test('pending mic tails compare against recent call final words, but not finals older than ten seconds', () => {
  const mic = draft('mic:room', 'The paper lantern is ready');
  const pending: PendingDraft = { ...mic, chunkId: 'fictional', cutMs: 13000 };
  const recent = mic.words.map(w => ({ ...w }));
  assert.deepEqual(filterPreviewEchoes([], [pending], ['app:call'], recent, 13000).pending, []);
  assert.deepEqual(filterPreviewEchoes([], [pending], ['app:call'], recent, 25000).pending, [pending]);
  assert.deepEqual(filterPreviewEchoes([], [pending], [], recent, 13000).pending, [pending]);
});

test('call pending and active words form one meeting-ordered reference, microphone checks its last twenty normalized words', () => {
  const mic = draft('mic:room', 'old unique unmatched words one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty');
  const call = draft('app:call', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty');
  const pending: PendingDraft = { ...call, words: call.words.slice(0, 8), text: call.words.slice(0, 8).map(w => w.text).join(' '), chunkId: 'p', cutMs: 10900 };
  const active = { ...call, windowStartMs: 10800, words: call.words.slice(8), text: call.words.slice(8).map(w => w.text).join(' ') };
  assert.equal(filterPreviewEchoes([mic, active], [pending], ['app:call'], [], 15000).drafts.find(d => d.source === 'mic:room')?.text, '');
});

test('still-visible call preview words are usable even when older than ten seconds; only finals have that cutoff', () => {
  const mic = draft('mic:room', 'The paper lantern is ready', 0), call = draft('app:call', 'The paper lantern is ready', 0);
  assert.deepEqual(filterPreviewEchoes([mic, call], [], ['app:call'], [], 25000).drafts, [{ ...mic, text: '', words: [] }, call]);
});

test('80% is inclusive; under 80% and numeric differences are kept', () => {
  assert.equal(run(draft('mic:room', 'one two three four extra'), draft('app:call', 'one two three four')).drafts[0].text, '');
  assert.equal(run(draft('mic:room', 'one two three extra'), draft('app:call', 'one two three')).drafts.length, 2);
  assert.equal(run(draft('mic:room', 'Set -3 units'), draft('app:call', 'Set 3 units')).drafts.length, 2);
});
