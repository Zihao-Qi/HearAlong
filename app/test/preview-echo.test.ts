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

test('a call pending block from 119 seconds earlier cannot suppress current mic speech', () => {
  const mic = draft('mic:room', 'The paper lantern is ready', 119000);
  const old: PendingDraft = { ...draft('app:call', mic.text, 0), chunkId: 'old-call', cutMs: 1000 };
  assert.deepEqual(filterPreviewEchoes([mic], [old], ['app:call'], [], 122000), { drafts: [mic], pending: [old] });
});

test('reference word overlap includes exactly three seconds slack, not more', () => {
  const mic = draft('mic:room', 'paper lamps turn', 10000);
  const remote = draft('app:call', 'paper lamps turn', 6900);
  // Only two remote words overlap the padded span, so there is no three-word echo.
  assert.equal(filterPreviewEchoes([mic, remote], [], ['app:call'], [], 13000).drafts[0].text, mic.text);
  const point = { ...remote, words: remote.words.map(w => ({ ...w, startMs: 7000, endMs: 7000 })) };
  assert.equal(filterPreviewEchoes([mic, point], [], ['app:call'], [], 13000).drafts[0].text, '');
  const outside = { ...point, words: point.words.map(w => ({ ...w, startMs: 6999, endMs: 6999 })) };
  assert.equal(filterPreviewEchoes([mic, outside], [], ['app:call'], [], 13000).drafts[0].text, mic.text);
});

test('a recent final must also overlap the particular mic block, not just the last-ten-second clock window', () => {
  const oldMic = draft('mic:room', 'The paper lantern is ready', 1000);
  const finals = draft('app:call', oldMic.text, 10000).words;
  assert.deepEqual(filterPreviewEchoes([oldMic], [], ['app:call'], finals, 13000), { drafts: [oldMic], pending: [] });
});

test('failed or cancelled pending call text is neither reference evidence nor displayed pending text', () => {
  const mic = draft('mic:room', 'The paper lantern is ready');
  const bad: PendingDraft = { ...draft('app:call', mic.text), chunkId: 'failed-call', cutMs: 13000 };
  assert.deepEqual(filterPreviewEchoes([mic], [bad], ['app:call'], [], 13000, new Set([bad.chunkId])), { drafts: [mic], pending: [] });
});

for (const newerPending of [false, true]) test(`matching newer ${newerPending ? 'pending' : 'active'} mic block cannot hide an older genuine payroll block`, () => {
  const old: PendingDraft = { ...draft('mic:room', 'payroll must be delayed until Friday', 10000), window: 'old', chunkId: 'old-mic', cutMs: 11000 };
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
  const newer = { ...draft('mic:room', text, 12000), window: 'new' }, call = draft('app:call', text, 12000);
  const before = structuredClone([old, newer, call]);
  const result = newerPending
    ? filterPreviewEchoes([call], [old, { ...newer, chunkId: 'new-mic', cutMs: 15000 }], ['app:call'], [], 15000)
    : filterPreviewEchoes([newer, call], [old], ['app:call'], [], 15000);
  assert.deepEqual(result.pending, [old]);
  assert.deepEqual(result.drafts, newerPending ? [call] : [{ ...newer, text: '', words: [] }, call]);
  assert.deepEqual([old, newer, call], before);
});

test('each mic block uses its own local reference, even when only an older matching block is suppressed', () => {
  const old: PendingDraft = { ...draft('mic:room', 'paper lantern cedar frame', 10000), chunkId: 'old-mic', cutMs: 11000 };
  const mic = { ...draft('mic:room', 'payroll must be delayed until Friday', 12000), window: 'new' };
  const call = draft('app:call', old.text, 10000);
  assert.deepEqual(filterPreviewEchoes([mic, call], [old], ['app:call'], [], 15000), { drafts: [mic, call], pending: [] });
});

test('80% is inclusive; under 80% and numeric differences are kept', () => {
  assert.equal(run(draft('mic:room', 'one two three four extra'), draft('app:call', 'one two three four')).drafts[0].text, '');
  assert.equal(run(draft('mic:room', 'one two three extra'), draft('app:call', 'one two three')).drafts.length, 2);
  assert.equal(run(draft('mic:room', 'Set -3 units'), draft('app:call', 'Set 3 units')).drafts.length, 2);
});
