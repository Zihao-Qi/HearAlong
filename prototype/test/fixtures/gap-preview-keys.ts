// Confirmation review: a pre-gap final splits composed mic runs whose word midpoints are both after the gap.
const mic = 'mic:test', tab = 'tab:other';
const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });
const preview = (source: string, words: ReturnType<typeof word>[]) => ({ source, window: source, windowStartMs: 0,
  coveredUntilMs: 2000, text: words.map(w => w.text).join(' '), words, behind: false });
const anchor = { id: 'anchor:0', source: 'tab:anchor', startMs: 950, endMs: 980, text: 'anchor', revision: 0, edits: [] };
export const keyGap = { atMs: 1000, fromWallMs: 100000, toWallMs: 231000, reason: 'sleep' as const };

export function gapPreviewKeyCases() {
  const micWords = [word('one', 900, 1100), word('two', 1100, 1300)];
  return [
    { name: 'reviewer: clamped mic word and unaffected later run both survive with distinct keys',
      snapshot: { segments: [anchor], drafts: [preview(mic, micWords)], pending: [], captureGaps: [keyGap] },
      // Only the first composed run is clamped. The second must keep its original M9a key/grouping.
      text: ['anchor', 'GAP', 'one', 'two'] },
    { name: 'two genuinely clamped same-slot runs coalesce',
      snapshot: { segments: [{ ...anchor, startMs: 850, endMs: 880 }],
        drafts: [preview(mic, [word('one', 800, 1200), word('two', 900, 1300)])], pending: [], captureGaps: [keyGap] },
      text: ['anchor', 'GAP', 'one two'] },
    { name: 'an intervening clamped source separates two genuinely clamped runs',
      snapshot: { segments: [{ ...anchor, startMs: 850, endMs: 880 }],
        drafts: [preview(mic, [word('one', 800, 1200), word('two', 900, 1300)]), preview(tab, [word('them', 850, 1250)])],
        pending: [], captureGaps: [keyGap] },
      text: ['anchor', 'GAP', 'one', 'them', 'two'] },
    { name: 'another source between same-slot runs prevents coalescing',
      snapshot: { segments: [anchor], drafts: [preview(mic, micWords), preview(tab, [word('them', 960, 1160)])], pending: [], captureGaps: [keyGap] },
      text: ['anchor', 'GAP', 'one', 'them', 'two'] },
    { name: 'unaffected multi-word M9a run keeps its grouping beside affected previews',
      snapshot: { segments: [anchor], drafts: [preview(mic, [...micWords, word('three', 1250, 1450)]),
        preview(tab, [word('them', 960, 1160), word('again', 1200, 1400)])], pending: [], captureGaps: [keyGap] },
      text: ['anchor', 'GAP', 'one', 'them', 'two three', 'again'] },
    { name: 'affected pending-before words cannot re-group an unaffected M9a run',
      snapshot: { segments: [anchor], drafts: [preview(mic, [...micWords, word('three', 1250, 1450)])],
        pending: [{ ...preview(tab, [word('them', 960, 1160), word('again', 1200, 1400)]), chunkId: 'waiting', cutMs: 2000 }], captureGaps: [keyGap] },
      text: ['anchor', 'GAP', 'one', 'them', 'two three', 'again'] },
    { name: 'equal-time and zero-duration words keep unique keys and every owned word',
      snapshot: { segments: [anchor], drafts: [preview(mic, [word('one', 1000, 1000), word('two', 1000, 1000)]),
        preview(tab, [word('them', 1000, 1000)])], pending: [], captureGaps: [keyGap] },
      text: ['anchor', 'GAP', 'one two', 'them'] },
  ];
}
