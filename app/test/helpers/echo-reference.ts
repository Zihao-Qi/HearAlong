// Deliberately simple oracle for the original read-time rule; no interval index, memoization or early exit.
import { compareSegments, type Speakers } from '../../src/speakers.ts';

type Line = { id: string; source: string; startMs: number; endMs: number; text: string; ord?: number;
  words?: { text: string; startMs: number; endMs: number }[] };
export function simpleEchoesFor(segments: Line[], speakers: Speakers): Set<string> {
  const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, (char, at: number, raw: string) => {
    if (['.', ','].includes(char) && /\d/.test(raw[at - 1] ?? '') && /\d/.test(raw[at + 1] ?? '')) return char;
    if (['-', '−'].includes(char) && /\d/.test(raw[at + 1] ?? '') && !/[\p{L}\p{M}\p{N}]/u.test(raw[at - 1] ?? '')) return '-';
    return /\p{Pd}/u.test(char) ? ' ' : '';
  }).split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (!speakers.labelled) return out;
  const role = (s: Line) => speakers.roleOf(s.source, s.startMs, s.endMs);
  const remote = segments.filter(s => role(s) === 'them').sort(compareSegments);
  for (const mic of segments) {
    if (role(mic) !== 'me') continue;
    let own = words(mic.text);
    const reference = remote.filter(s => s.startMs <= mic.endMs + 3000 && s.endMs >= mic.startMs - 3000).flatMap(s => words(s.text));
    if (!speakers.tabs.some(t => mic.startMs >= t.startMs && mic.endMs <= t.endMs)
      && mic.words?.length && words(mic.words.map(w => w.text).join(' ')).join(' ') === own.join(' ')) {
      const inside = (w: NonNullable<Line['words']>[number]) => speakers.tabs.some(t => w.startMs + w.endMs >= 2 * t.startMs && w.startMs + w.endMs <= 2 * t.endMs);
      const outside = mic.words.filter(w => !inside(w)).flatMap(w => words(w.text));
      const outsideTable = Array.from({ length: reference.length + 1 }, () => new Uint32Array(outside.length + 1));
      for (let i = 1; i <= reference.length; i++) for (let j = 1; j <= outside.length; j++) {
        outsideTable[i][j] = reference[i - 1] === outside[j - 1] ? outsideTable[i - 1][j - 1] + 1 : Math.max(outsideTable[i - 1][j], outsideTable[i][j - 1]);
      }
      const count = outsideTable[reference.length][outside.length];
      if (outside.length < 3 ? count !== outside.length : count * 5 < outside.length * 4) continue;
      own = mic.words.filter(inside).flatMap(w => words(w.text));
    }
    if (own.length < 3) continue;
    const table = Array.from({ length: reference.length + 1 }, () => new Uint32Array(own.length + 1));
    for (let i = 1; i <= reference.length; i++) for (let j = 1; j <= own.length; j++) {
      table[i][j] = reference[i - 1] === own[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
    if (table[reference.length][own.length] * 5 >= own.length * 4) out.add(mic.id);
  }
  return out;
}
