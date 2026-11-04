// Speaker labels for online meetings: capture channels, not identified people.
// "Them" is a meeting tab or app's audio (everyone on the call); "Me" is the microphone recorded alongside it.
// Microphone audio from before the call (an in-person discussion) and imports have no label.

export type Role = 'me' | 'them';
export const ROLE_LABEL: Record<Role, string> = { me: 'Me', them: 'Them' };
export const isRemote = (source: string) => source.startsWith('tab:') || source.startsWith('app:');

export type Speakers = { labelled: boolean; roleOf: (source: string, startMs: number, endMs: number) => Role | undefined; tabs: { startMs: number; endMs: number }[] };
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
  const roleOf = (source: string, startMs: number, endMs: number): Role | undefined => {
    if (isRemote(source)) return 'them';
    const mic = source.startsWith('mic:') ? bySource.get(source) : undefined;
    if (!mic) return undefined;
    // The first share that started while this recording ran (a tab can begin a moment before the microphone is wired).
    const firstShare = Math.min(...tabs.filter(t => t.startMs < mic.endMs && t.endMs > mic.startMs).map(t => t.startMs));
    return (startMs + endMs) / 2 >= firstShare ? 'me' : undefined;
  };
  return { labelled: tabs.length > 0, roleOf, tabs };
}

type EchoSegment = { id: string; source: string; startMs: number; endMs: number; text: string };
const echoWords = (text: string) => text.toLowerCase().replace(/\p{Pd}/gu, ' ').replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);

/** Read-time acoustic-echo heuristic. Never changes stored text or hides the call channel.
 * Hyphens separate words; other punctuation is removed. Digits are not expanded to number names.
 * All overlapping remote pieces are joined in meeting order, regardless of their chunk boundaries.
 */
export function echoesFor(segments: EchoSegment[], speakers: Speakers): Set<string> {
  const echoes = new Set<string>();
  if (!speakers.labelled) return echoes;
  const role = (s: EchoSegment) => speakers.roleOf(s.source, s.startMs, s.endMs);
  const remote = segments.filter(s => role(s) === 'them').sort(compareSegments).map(s => ({ ...s, words: echoWords(s.text) }));
  for (const mic of segments) {
    if (role(mic) !== 'me') continue;
    const words = echoWords(mic.text);
    if (words.length < 3) continue;
    const reference = remote.filter(s => s.startMs <= mic.endMs + 3000 && s.endMs >= mic.startMs - 3000).flatMap(s => s.words);
    // Longest common word subsequence, using one row of memory (recognition may omit or insert words).
    const row = new Uint32Array(words.length + 1);
    for (const word of reference) {
      let diagonal = 0;
      for (let j = 1; j <= words.length; j++) {
        const previous = row[j];
        row[j] = word === words[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
        diagonal = previous;
      }
    }
    if (row[words.length] * 5 >= words.length * 3) echoes.add(mic.id);
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
