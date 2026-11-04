// Speaker labels for online meetings: capture channels, not identified people.
// "Them" is a meeting tab or app's audio (everyone on the call); "Me" is the microphone recorded alongside it.
// Microphone audio from before the call (an in-person discussion) and imports have no label.

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

type EchoSegment = { id: string; source: string; startMs: number; endMs: number; text: string };
const echoWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, (char, at: number, raw: string) => {
  const before = raw[at - 1] ?? '', after = raw[at + 1] ?? '';
  if ((char === '.' || char === ',') && /\d/.test(before) && /\d/.test(after)) return char;
  if ((char === '-' || char === '−') && /\d/.test(after) && !/[\p{L}\p{M}\p{N}]/u.test(before)) return '-';
  return /\p{Pd}/u.test(char) ? ' ' : '';
}).split(/\s+/).filter(Boolean);

/** Read-time acoustic-echo heuristic. Never changes stored text or hides the call channel.
 * Hyphens separate words; other punctuation is removed except numeric separators/signs. Numbers are not expanded.
 * All overlapping remote pieces are joined in meeting order, regardless of their chunk boundaries.
 */
export function echoesFor(segments: EchoSegment[], speakers: Speakers): Set<string> {
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
    const words = echoWords(mic.text);
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
  return echoes;
}

/** One order for every view of a labelled meeting: time, then source, then position in its chunk. */
export function compareSegments(a: { startMs: number; source: string; ord?: number; id: string }, b: { startMs: number; source: string; ord?: number; id: string }) {
  const order = (source: string) => source.startsWith('app:') ? `tab:${source.slice(4)}` : source;
  return a.startMs - b.startMs || order(a.source).localeCompare(order(b.source)) || (a.ord ?? 0) - (b.ord ?? 0) || a.id.localeCompare(b.id);
}

/** "Me: " / "Them: " for a prompt line in a labelled meeting; "" otherwise. */
export const speakerPrefix = (speaker: string | undefined) => (speaker ? `${speaker}: ` : '');
