// Speaker labels for online meetings: capture channels, not identified people.
// "Them" is a meeting tab or app's audio (everyone on the call); "Me" is the microphone recorded alongside it.
// Microphone audio from before the call (an in-person discussion) and imports have no label.

import { echoWords, commonWords, type EchoWord } from './echo-words.ts';

export type Role = 'me' | 'them';
export const ROLE_LABEL: Record<Role, string> = { me: 'Me', them: 'Them' };
export const isRemote = (source: string) => source.startsWith('tab:') || source.startsWith('app:');

export type Speakers = { labelled: boolean; cacheKey: string; roleOf: (source: string, startMs: number, endMs: number) => Role | undefined; tabs: { startMs: number; endMs: number }[] };
/**
 * Roles per line, from each source's saved time range. A meeting is labelled once any call source exists. One microphone source is one
 * recording (Start to Stop); its lines are "Me" from the first meeting tab or app during that recording until Stop, pauses in sharing
 * included. Room speech before the first share (an in-person discussion, then a call joined later) stays unlabelled, as do imports.
 */
export function rolesFor(ranges: { source: string; startMs: number; endMs: number }[]): Speakers {
  const bySource = new Map<string, { startMs: number; endMs: number }>();
  for (const r of ranges) {
    const known = bySource.get(r.source);
    bySource.set(r.source, known ? { startMs: Math.min(known.startMs, r.startMs), endMs: Math.max(known.endMs, r.endMs) } : { startMs: r.startMs, endMs: r.endMs });
  }
  const tabs = [...bySource].filter(([source]) => isRemote(source)).map(([, range]) => range);
  const firstShares = new Map<string, number>();
  for (const [source, mic] of bySource) if (source.startsWith('mic:')) {
    // The first share that started while this recording ran (a tab can begin a moment before the microphone is wired).
    firstShares.set(source, Math.min(...tabs.filter(t => t.startMs < mic.endMs && t.endMs > mic.startMs).map(t => t.startMs)));
  }
  const roleOf = (source: string, startMs: number, endMs: number): Role | undefined => {
    if (isRemote(source)) return 'them';
    const firstShare = firstShares.get(source);
    return firstShare !== undefined && (startMs + endMs) / 2 >= firstShare ? 'me' : undefined;
  };
  const labelled = tabs.length > 0;
  // New frames usually extend a source without changing any role; only the first-share boundaries matter.
  const cacheKey = JSON.stringify([labelled, [...firstShares].sort(([a], [b]) => a.localeCompare(b))]);
  return { labelled, roleOf, tabs, cacheKey };
}

export type EchoSegment = { id: string; source: string; startMs: number; endMs: number; text: string; words?: EchoWord[]; chunkId?: string; ord?: number };

/** Read-time acoustic-echo heuristic. Never changes stored text or hides the call channel.
 * Hyphens separate words; other punctuation is removed except numeric separators/signs. Numbers are not expanded.
 * All overlapping remote pieces are joined in meeting order, regardless of their chunk boundaries.
 * A Me line under three words is never an echo on its own: only as the tail of an echo, when a neighbouring line of its chunk
 * (adjacent `ord`) is hidden and all of its words appear, in order, in the overlapping remote text.
 */
export function echoesFor(segments: EchoSegment[], speakers: Speakers,
  wordsFor: (segment: EchoSegment) => EchoWord[] | undefined = segment => segment.words): Set<string> {
  const echoes = new Set<string>();
  if (!speakers.labelled) return echoes;
  const role = (s: EchoSegment) => speakers.roleOf(s.source, s.startMs, s.endMs);
  const remote = segments.filter(s => role(s) === 'them').sort(compareSegments);
  if (!remote.length) return echoes;
  // Range maxima, not a binary search on end times: long/nested remote segments need not end in start order.
  let size = 1;
  while (size < remote.length) size *= 2;
  const ends = new Float64Array(size * 2).fill(-Infinity);
  for (let i = 0; i < remote.length; i++) ends[size + i] = remote[i].endMs;
  for (let i = size - 1; i > 0; i--) ends[i] = Math.max(ends[i * 2], ends[i * 2 + 1]);
  const tokens: (string[] | undefined)[] = new Array(remote.length);
  const overlapping = (node: number, from: number, to: number, limit: number, earliest: number, into: number[]) => {
    if (from >= limit || ends[node] < earliest) return;
    if (to - from === 1) { into.push(from); return; }
    const mid = (from + to) >>> 1;
    overlapping(node * 2, from, mid, limit, earliest, into);
    overlapping(node * 2 + 1, mid, to, limit, earliest, into);
  };
  const inCall = (word: EchoWord) => speakers.tabs.some(t => (word.startMs + word.endMs) / 2 >= t.startMs && (word.startMs + word.endMs) / 2 <= t.endMs);
  const short: { mic: EchoSegment; words: string[]; limit: number; earliest: number }[] = [];
  for (const mic of segments) {
    if (role(mic) !== 'me') continue;
    const earliest = mic.startMs - 3000, latest = mic.endMs + 3000;
    let low = 0, high = remote.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (remote[mid].startMs <= latest) low = mid + 1; else high = mid;
    }
    const limit = low;
    if (!limit || ends[1] < earliest) continue;
    let words = echoWords(mic.text);
    if (words.length && words.length < 3 && mic.chunkId !== undefined && mic.ord !== undefined) short.push({ mic, words, limit, earliest });
    // Only consult stored timings at capture edges; ordinary interior segments keep the cheap whole-text path.
    if (!speakers.tabs.some(t => mic.startMs >= t.startMs && mic.endMs <= t.endMs)) {
      const timed = wordsFor(mic);
      // Corrections may no longer align with original recognition tokens. Without exact alignment, keep whole-segment behavior.
      if (timed?.length && echoWords(timed.map(w => w.text).join(' ')).join(' ') === words.join(' ')) {
        const outside = timed.filter(w => !inCall(w)).flatMap(w => echoWords(w.text));
        const indices: number[] = [];
        overlapping(1, 0, size, limit, earliest, indices);
        const reference = indices.flatMap(i => tokens[i] ??= echoWords(remote[i].text));
        // Dropping a negation is worse than one doubled line. The outside clause must itself be an ordered echo.
        const matched = commonWords(outside, reference);
        if (outside.length < 3 ? matched !== outside.length : matched * 5 < outside.length * 4) continue;
        words = timed.filter(inCall).flatMap(w => echoWords(w.text));
      }
    }
    if (words.length < 3) continue;
    const vocabulary = new Set(words);
    // One LCS row consumes overlapping remote pieces left-to-right, exactly as their concatenated meeting-order text.
    const row = new Uint32Array(words.length + 1);
    const matches = (node: number, from: number, to: number): boolean => {
      if (from >= limit || ends[node] < earliest) return false;
      if (to - from > 1) {
        const mid = (from + to) >>> 1;
        return matches(node * 2, from, mid) || matches(node * 2 + 1, mid, to);
      }
      for (const word of tokens[from] ??= echoWords(remote[from].text)) {
        if (!vocabulary.has(word)) continue; // A word absent from the mic cannot change any LCS cell.
        let diagonal = 0;
        for (let j = 1; j <= words.length; j++) {
          const previous = row[j];
          row[j] = word === words[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
          diagonal = previous;
        }
        // Appending more remote words cannot reduce the LCS; no need to visit later intervals once it qualifies.
        if (row[words.length] * 5 >= words.length * 4) return true;
      }
      return false;
    };
    if (matches(1, 0, size)) echoes.add(mic.id);
  }
  if (!short.length || !echoes.size) return echoes;
  // Neighbours come from the lines hidden above, so short lines never hide each other.
  const hidden = new Set(segments.filter(s => echoes.has(s.id) && s.chunkId !== undefined && s.ord !== undefined).map(s => `${s.chunkId}\n${s.ord}`));
  for (const { mic, words, limit, earliest } of short) {
    if (!hidden.has(`${mic.chunkId}\n${mic.ord! - 1}`) && !hidden.has(`${mic.chunkId}\n${mic.ord! + 1}`)) continue;
    const indices: number[] = [];
    overlapping(1, 0, size, limit, earliest, indices);
    if (commonWords(words, indices.flatMap(i => tokens[i] ??= echoWords(remote[i].text))) === words.length) echoes.add(mic.id);
  }
  return echoes;
}

/** One order for every view of a labelled meeting: time, then source, then position in its chunk. */
export function compareSegments(a: { startMs: number; source: string; ord?: number; id: string }, b: { startMs: number; source: string; ord?: number; id: string }) {
  const order = (source: string) => source.startsWith('app:') ? `tab:${source.slice(4)}` : source;
  return a.startMs - b.startMs || order(a.source).localeCompare(order(b.source)) || (a.ord ?? 0) - (b.ord ?? 0) || a.id.localeCompare(b.id);
}

/** "Me: " / "Them: " for a prompt line in a labelled meeting; "" otherwise. */
export const speakerPrefix = (speaker: string | undefined) => (speaker ? `${speaker}: ` : '');
