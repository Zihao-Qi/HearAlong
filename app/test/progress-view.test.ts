import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Element } from './helpers/ui-dom.ts';

const source = await readFile(new URL('../public/plans.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('// A progress card'), source.indexOf('// ---------- End job progress')).replace(/export /g, '');
function fixture() {
  const context = { document: { createElement: (tag: string) => new Element(tag) }, setInterval() {} };
  return runInNewContext(`(function(){${renderer};return progressCard;})()`, context) as (kind: string, progress: object, cancel: () => void, card?: Element) => Element;
}
const detail = (card: Element, phase: string) => card.querySelector(`[data-phase="${phase}"]`)!.querySelector('.progress-detail')?.textContent ?? '';

test('notes omit unknown and partially known transcript dimensions, then show the real counts', () => {
  const render = fixture(), base = { phase: 'read', startedAt: Date.now() };
  const card = render('notes', base, () => {});
  assert.equal(detail(card, 'read'), '', 'unknown does not mean zero');
  render('notes', { ...base, minutes: 1 }, () => {}, card);
  assert.equal(detail(card, 'read'), '', 'do not combine a known minute count with invented lines');
  render('notes', { ...base, lines: 2 }, () => {}, card);
  assert.equal(detail(card, 'read'), '', 'do not combine known lines with invented minutes');
  render('notes', { ...base, minutes: 1, lines: 2 }, () => {}, card);
  assert.equal(detail(card, 'read'), '1 min · 2 lines');
  render('notes', { ...base, minutes: 0, lines: 1 }, () => {}, card);
  assert.equal(detail(card, 'read'), '0 min · 1 lines', 'genuinely known zero minutes is not missing data');
});

for (const kind of ['plans', 'explore']) test(`${kind} omits unknown question and written counts but retains known zeros`, () => {
  const render = fixture(), base = { phase: 'write', startedAt: Date.now(), expected: 3 };
  const card = render(kind, base, () => {});
  assert.equal(detail(card, 'notes'), '');
  assert.equal(detail(card, 'write'), '');
  render(kind, { ...base, questions: 0, written: 0 }, () => {}, card);
  assert.equal(detail(card, 'notes'), '0\u00a0open\u00a0questions');
  assert.equal(detail(card, 'write'), '0 of about 3');
  render(kind, { ...base, questions: 2, written: 1 }, () => {}, card);
  assert.equal(detail(card, 'notes'), '2\u00a0open\u00a0questions');
  assert.equal(detail(card, 'write'), '1 of about 3');
});

test('outline counts are exact while fallback and Explore retain estimates', () => {
  const render = fixture();
  for (const written of [0, 3, 8]) {
    const card = render('plans', { phase: 'write', startedAt: Date.now(), expected: 8, exact: true, written, latest: 'Lantern shelf' }, () => {});
    assert.equal(detail(card, 'write'), `${written} of 8`);
    assert.match(card.querySelector('.progress-latest')!.textContent, /Lantern shelf/);
  }
});

test('notes parts with unavailable counts are blank, not invented zeros', () => {
  const render = fixture(), card = render('notes', { phase: 'write', startedAt: Date.now() }, () => {});
  assert.deepEqual(card.querySelectorAll('.progress-count').map(n => n.textContent), ['', '', '']);
  render('notes', { phase: 'write', startedAt: Date.now(), parts: { project: { count: 0 }, tasks: { count: 2 } } }, () => {}, card);
  assert.deepEqual(card.querySelectorAll('.progress-count').map(n => n.textContent), ['0', '2', '']);
});
