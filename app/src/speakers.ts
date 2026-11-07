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

const SHORT_ECHO_GAP_MS = 1000;
// An echo reaches the microphone within a few hundred ms of the call audio; a reply "Okay." 600 ms after the call's "okay" is genuine.
const SHORT_ECHO_ALIGN_MS = 400;

/** Read-time acoustic-echo heuristic. Never changes stored text or hides the call channel.
 * Hyphens separate words; other punctuation is removed except numeric separators/signs. Numbers are not expanded.
 * All overlapping remote pieces are joined in meeting order, regardless of their chunk boundaries.
 * A Me line under three words is never an echo on its own: only as the tail or head of an echo, when all of these hold:
 * a neighbouring line of its chunk (adjacent `ord`) is hidden and at most 1 s away; each of its words matches a call word that
 * starts within 400 ms of it (both sides need word times); and joined to the neighbour it extends the neighbour's match in the call
 * text overlapping the two lines by all of its words.
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
  // Remote pieces starting at or before `latest` are remote[0, limit).
  const limitAt = (latest: number) => {
    let low = 0, high = remote.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (remote[mid].startMs <= latest) low = mid + 1; else high = mid;
    }
    return low;
  };
  const between = (earliest: number, latest: number) => {
    const indices: number[] = [];
    overlapping(1, 0, size, limitAt(latest), earliest, indices);
    return indices;
  };
  const short: { mic: EchoSegment; words: string[] }[] = [];
  for (const mic of segments) {
    if (role(mic) !== 'me') continue;
    const earliest = mic.startMs - 3000, latest = mic.endMs + 3000;
    const limit = limitAt(latest);
    if (!limit || ends[1] < earliest) continue;
    let words = echoWords(mic.text);
    if (words.length && words.length < 3 && mic.chunkId !== undefined && mic.ord !== undefined) short.push({ mic, words });
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
  const hidden = new Map(segments.filter(s => echoes.has(s.id) && s.chunkId !== undefined && s.ord !== undefined)
    .map(s => [`${s.chunkId}\n${s.ord}`, s]));
  // Word times whose text is exactly the line's (a corrected line may no longer align with its recognition tokens).
  const aligned = (segment: EchoSegment) => {
    const timed = wordsFor(segment);
    return timed?.length && echoWords(timed.map(w => w.text).join(' ')).join(' ') === echoWords(segment.text).join(' ') ? timed : undefined;
  };
  // The user mostly listens, so short replies are a large share of their lines: hiding one is worse than showing one doubled line.
  const shortEcho = (mic: EchoSegment, words: string[], neighbour: EchoSegment, tail: boolean): boolean => {
    if ((tail ? mic.startMs - neighbour.endMs : neighbour.startMs - mic.endMs) > SHORT_ECHO_GAP_MS) return false;
    const own = aligned(mic);
    if (!own) return false;
    const nearby: EchoWord[] = [];
    for (const i of between(mic.startMs - SHORT_ECHO_ALIGN_MS, mic.endMs + SHORT_ECHO_ALIGN_MS)) {
      const timed = aligned(remote[i]);
      if (!timed) return false;
      nearby.push(...timed);
    }
    // Each word was said by the call at the same moment, not just somewhere in the last few seconds.
    if (!own.every(w => echoWords(w.text).every(token => nearby.some(r => Math.abs(r.startMs - w.startMs) <= SHORT_ECHO_ALIGN_MS
      && echoWords(r.text).includes(token))))) return false;
    // ...and continues the neighbour's match instead of reusing call words the neighbour already matched.
    const reference = between(Math.min(mic.startMs, neighbour.startMs), Math.max(mic.endMs, neighbour.endMs))
      .flatMap(i => tokens[i] ??= echoWords(remote[i].text));
    const theirs = echoWords(neighbour.text);
    return commonWords(tail ? [...theirs, ...words] : [...words, ...theirs], reference) >= commonWords(theirs, reference) + words.length;
  };
  for (const { mic, words } of short) {
    const before = hidden.get(`${mic.chunkId}\n${mic.ord! - 1}`), after = hidden.get(`${mic.chunkId}\n${mic.ord! + 1}`);
    if ((before && shortEcho(mic, words, before, true)) || (after && shortEcho(mic, words, after, false))) echoes.add(mic.id);
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
