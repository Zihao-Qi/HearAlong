import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timedWords, composePreview, coversTime, overlapsTime } from '../public/preview-composition.js';
import { active, pending } from './fixtures/m9a-handoff.ts';

test('M9a fix 4: zero-duration tentative words own their point and mask pending words reversibly', () => {
  const point = timedWords([{ text: ' instant', t0Ms: 2000, t1Ms: 2000 }])[0];
  assert.deepEqual(point, { text: 'instant', startMs: 2000, endMs: 2000 });
  const waiting = { ...pending('point', 0, 1, [point]), committedUntilMs: 3000 };
  const current = { ...active(0, 0), committedUntilMs: 0, coveredUntilMs: 2000, words: [{ ...point, text: 'current' }] };
  const shown = (drafts: typeof current[]) => composePreview(drafts, [waiting]).flatMap(r => r.words.map(w => w.text));
  assert.deepEqual(shown([current]), ['current'], 'a point claim must win just like a nonempty word interval');
  assert.deepEqual(shown([{ ...current, coveredUntilMs: 0, words: [] }]), ['instant'], 'retraction restores the pending point');
});

test('M9a fix 4: nonzero words keep half-open boundaries, and point claims do not cover nearby times', () => {
  const at = (ms: number) => ({ text: 'pending', startMs: ms, endMs: ms });
  const current = { ...active(0, 0), committedUntilMs: 0, coveredUntilMs: 2200, words: [{ text: 'current', startMs: 2000, endMs: 2200 }] };
  const shown = (time: number, draft = current) => composePreview([draft], [pending('edge', 0, 1, [at(time)])]).flatMap(r => r.words.map(w => w.text));
  assert.deepEqual(shown(2000), ['current']);
  assert.deepEqual(shown(2200), ['current', 'pending'], 'the right boundary of a nonempty interval stays exclusive');
  assert.deepEqual(shown(2001, { ...current, coveredUntilMs: 2000, words: [{ text: 'current', startMs: 2000, endMs: 2000 }] }), ['current', 'pending']);
  const point = at(2000), interval = { startMs: 2000, endMs: 2200 };
  assert.equal(coversTime(point, 2000), true);
  assert.equal(coversTime(point, 2001), false);
  assert.equal(overlapsTime(point, point), true, 'coincident point finals must defer beside a held point word');
  assert.equal(overlapsTime(point, interval), true);
  assert.equal(overlapsTime(interval, point), true);
  assert.equal(overlapsTime(at(2200), interval), false);
  assert.equal(overlapsTime(interval, at(2200)), false);
  assert.equal(overlapsTime(point, at(2001)), false);
});
