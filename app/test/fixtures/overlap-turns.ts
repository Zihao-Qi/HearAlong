import type { DisplaySegment } from '../../public/transcript-view.js';

/** Fictional words with the shape of two overlapping, block-split sentences. */
export const overlapLines: DisplaySegment[] = [
  { id: 'mic-first:0', source: 'mic:fictional', startMs: 0, endMs: 4000, revision: 0, speaker: 'Me', text: 'a basket of yellow' },
  { id: 'call-first:0', source: 'tab:fictional', startMs: 1000, endMs: 4500, revision: 0, speaker: 'Them', text: "So what the gardeners noticed" },
  { id: 'mic-end:0', source: 'mic:fictional', startMs: 5500, endMs: 6500, revision: 0, speaker: 'Me', text: 'lemons.' },
  { id: 'call-end:0', source: 'tab:fictional', startMs: 6000, endMs: 10000, revision: 0, speaker: 'Them', text: 'is that paper kites can be used for the display.' },
  { id: 'mic-next:0', source: 'mic:fictional', startMs: 7000, endMs: 10000, revision: 0, speaker: 'Me', text: 'By noon, it is not usually ready in the shed.' },
];
export const overlapText = [
  'a basket of yellow lemons. By noon, it is not usually ready in the shed.',
  'So what the gardeners noticed is that paper kites can be used for the display.',
];
