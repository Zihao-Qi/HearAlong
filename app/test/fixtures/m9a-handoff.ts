// Fixed meeting-clock word timings, shared by the composition tests and the actual-page check.
export const words = ['one', 'two', 'three', 'four', 'five', 'six'].map((text, i) => ({ text, startMs: i * 1000 + 100, endMs: i * 1000 + 300 }));
export const source = 'mic:00000000-0000-0000-0000-000000000001';
export const active = (from: number, through: number) => ({ source, window: `w${from}`, windowStartMs: from * 1000,
  coveredUntilMs: through * 1000, words: words.slice(from, through), text: words.slice(from, through).map(w => w.text).join(' '), behind: false });
export const pending = (id: string, from: number, cut: number, list = words.slice(from)) => ({ source, chunkId: id, window: `w${from}`, behind: false,
  windowStartMs: from * 1000, cutMs: cut * 1000, coveredUntilMs: 6000, words: list, text: list.map(w => w.text).join(' ') });
export const final = (id: string, from: number, to: number) => ({ id: `${id}:0`, source, startMs: from * 1000 + 100, endMs: to * 1000 - 700,
  text: words.slice(from, to).map(w => w.text).join(' '), originalText: '', edits: [], revision: 0, timing: 'word' });
const snapshot = (segments: any[] = [], drafts: any[] = [], waiting: any[] = []) => ({ segments, drafts, pending: waiting });
const before = snapshot([], [active(0, 6)]);
const seal = snapshot([], [active(3, 3)], [pending('c1', 0, 3)]);
export function handoffCases() {
  return [
    { name: 'every word visible exactly once at every render across a seal', steps: [before, seal,
      snapshot([], [active(3, 6)], [pending('c1', 0, 3)]), snapshot([final('c1', 0, 3)], [active(3, 6)])] },
    { name: 'a slow replay of the new stream', steps: [before, seal,
      ...[4, 5, 6].map(n => snapshot([], [active(3, n)], [pending('c1', 0, 3)])),
      snapshot([final('c1', 0, 3)], [active(3, 6)])] },
    { name: 'the batch final arriving before the new stream catches up', steps: [before, seal,
      ...[3, 4, 5, 6].map(n => snapshot([final('c1', 0, 3)], [active(3, n)], [pending('c1', 0, 3, words.slice(3))]))] },
    { name: 'two seals in a row', steps: [before, seal,
      snapshot([], [active(3, 6)], [pending('c1', 0, 3, words.slice(0, 3))]),
      snapshot([], [active(5, 5)], [pending('c1', 0, 3, words.slice(0, 3)), pending('c2', 3, 5)]),
      snapshot([final('c2', 3, 5)], [active(5, 5)], [pending('c1', 0, 3, words.slice(0, 3)), pending('c2', 3, 5, words.slice(5))]),
      snapshot([final('c1', 0, 3), final('c2', 3, 5)], [active(5, 6)])] },
    { name: 'a seal followed by Stop', steps: [before, seal,
      snapshot([], [], [pending('c1', 0, 3, words.slice(0, 3)), pending('c2', 3, 6)]),
      snapshot([final('c1', 0, 3)], [], [pending('c2', 3, 6)]), snapshot([final('c1', 0, 3), final('c2', 3, 6)])] },
  ];
}
