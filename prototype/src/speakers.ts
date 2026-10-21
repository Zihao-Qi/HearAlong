// Speaker labels for online meetings: capture channels, not identified people.
// "Them" is a meeting tab's audio (everyone on the call); "Me" is a microphone recorded while a tab was captured.
// Microphone audio from before the call (an in-person discussion) and imports have no label.

export type Role = 'me' | 'them';
export const ROLE_LABEL: Record<Role, string> = { me: 'Me', them: 'Them' };
export const isTab = (source: string) => source.startsWith('tab:');

export type Speakers = { labelled: boolean; roleOf: (source: string, startMs: number, endMs: number) => Role | undefined; tabs: { startMs: number; endMs: number }[] };
/**
 * Roles per line, from each source's saved time range. A meeting is labelled once any tab source exists. One microphone source is one
 * recording (Start to Stop); its lines are "Me" from the first meeting tab shared during that recording until Stop, pauses in sharing
 * included. Room speech before the first share (an in-person discussion, then a call joined later) stays unlabelled, as do imports.
 */
export function rolesFor(ranges: { source: string; startMs: number; endMs: number }[]): Speakers {
  const bySource = new Map<string, { startMs: number; endMs: number }>();
  for (const r of ranges) {
    const known = bySource.get(r.source);
    bySource.set(r.source, known ? { startMs: Math.min(known.startMs, r.startMs), endMs: Math.max(known.endMs, r.endMs) } : { startMs: r.startMs, endMs: r.endMs });
  }
  const tabs = [...bySource].filter(([source]) => isTab(source)).map(([, range]) => range);
  const roleOf = (source: string, startMs: number, endMs: number): Role | undefined => {
    if (isTab(source)) return 'them';
    const mic = source.startsWith('mic:') ? bySource.get(source) : undefined;
    if (!mic) return undefined;
    // The first share that started while this recording ran (a tab can begin a moment before the microphone is wired).
    const firstShare = Math.min(...tabs.filter(t => t.startMs < mic.endMs && t.endMs > mic.startMs).map(t => t.startMs));
    return (startMs + endMs) / 2 >= firstShare ? 'me' : undefined;
  };
  return { labelled: tabs.length > 0, roleOf, tabs };
}

/** One order for every view of a labelled meeting: time, then source, then position in its chunk. */
export function compareSegments(a: { startMs: number; source: string; ord?: number; id: string }, b: { startMs: number; source: string; ord?: number; id: string }) {
  return a.startMs - b.startMs || a.source.localeCompare(b.source) || (a.ord ?? 0) - (b.ord ?? 0) || a.id.localeCompare(b.id);
}

/** "Me: " / "Them: " for a prompt line in a labelled meeting; "" otherwise. */
export const speakerPrefix = (speaker: string | undefined) => (speaker ? `${speaker}: ` : '');
