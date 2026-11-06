// Shared by the app page, the mini view and the server (M7 native mini window, docs/design/M7-native-mini.md §3): how transcript
// lines group into paragraphs, and the problem notices' words, so both windows and the transcript say the same thing.

/** A sentence ends only at the end of a line (possibly before closing quotes/brackets). */
const sentenceEnd = text => /[.?!…][\p{Pe}\p{Pf}"']*$/u.test((text ?? '').trim());

/** One open paragraph per speaker, keyed by its first line. Only gaps close all speakers;
 * previews/missing chunks close their own speaker (the single open lane in unlabelled meetings). */
export function paragraphsOf(segments, barriers = []) {
  const out = [], open = new Map();
  const entries = [...segments.map(segment => ({ segment, startMs: segment.startMs })),
    ...barriers.map(barrier => ({ barrier, startMs: barrier.startMs }))]
    .sort((a, b) => a.startMs - b.startMs || Number(Boolean(b.barrier?.all)) - Number(Boolean(a.barrier?.all))
      || Number(Boolean(a.barrier)) - Number(Boolean(b.barrier)));
  for (const entry of entries) {
    if (entry.barrier) {
      if (entry.barrier.all) open.clear(); else open.delete(entry.barrier.speaker ?? undefined);
      continue;
    }
    const segment = entry.segment, speaker = segment.speaker ?? undefined;
    const current = open.get(speaker);
    const ended = current && sentenceEnd(current.segments.at(-1).text);
    const length = current ? segment.startMs - current.startMs : 0;
    if (!current || segment.startMs - current.endMs >= (ended ? 2000 : 10_000)
      || length >= 60_000 || (length >= 45_000 && ended)) {
      const paragraph = { key: segment.id, startMs: segment.startMs, endMs: segment.endMs, segments: [segment], speaker };
      out.push(paragraph); open.set(speaker, paragraph);
    } else { current.segments.push(segment); current.endMs = Math.max(current.endMs, segment.endMs); }
  }
  for (const p of out) p.signature = `${p.speaker ?? ''}#` + p.segments.map(s => `${s.id}:${s.revision}`).join('|');
  return out;
}
/** Cache only before any paragraph that could still join not-yet-final speech. A preview
 * barrier is temporary, while an inactive speaker's last paragraph eventually becomes stable. */
export function paragraphCachePrefix(paragraphs, horizon) {
  const firstMutable = paragraphs.findIndex(p => p.endMs + 10_000 > horizon && p.startMs + 60_000 > horizon);
  return firstMutable < 0 ? paragraphs.length : firstMutable;
}
/** The ids of a paragraph's lines, from its signature. */
export function signatureLines(signature) {
  return signature.slice(signature.indexOf('#') + 1).split('|').map(line => line.slice(0, line.lastIndexOf(':')));
}

/** A transcript time: m:ss under an hour, h:mm:ss after. */
export function stamp(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = n => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Card types as the app and the mini view name them. */
export const TYPE_LABELS = { question: 'Question', claim: 'Claim to check', decision: 'Decision', action: 'Action', other: 'Other matter' };

/** Problems with the recording, in order of urgency, worded for a glance (`short` in the app's live chip). */
export const NOTICES = {
  tabEnded: { short: 'tab no longer shared', text: 'The meeting tab is no longer shared; the microphone keeps recording.' },
  savingBehind: { short: 'saving behind', text: 'Saving is falling behind; audio is waiting to be saved.' },
  quietTab: { short: 'no sound from the tab for 1 min', text: 'No sound from the meeting tab for 1 min. Is it still shared?' },
  quietMic: { short: 'no sound from the mic for 1 min', text: 'No sound from the microphone for 1 min. Is it muted?' },
};
/** Frames of one source waiting in the page before "saving behind" shows (the source stops at 30). */
export const SAVING_BEHIND_FRAMES = 5;
