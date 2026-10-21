// Shared by the app page, the mini view and the server (M7 native mini window, docs/design/M7-native-mini.md §3): how transcript
// lines group into paragraphs, and the problem notices' words, so both windows and the transcript say the same thing.

/** Lines into paragraphs: a change of speaker, a 2 s pause or 45 s of speech starts a new one. Keyed by its first line. */
export function paragraphsOf(segments) {
  const out = [];
  for (const segment of segments) {
    const current = out.at(-1);
    // Online meetings (segments carry a speaker): a change of speaker starts a new paragraph; lines of two sources overlap in time.
    const labelled = 'speaker' in segment;
    if (!current || (labelled && segment.speaker !== current.speaker) || segment.startMs - current.endMs >= 2000 || segment.startMs - current.startMs >= 45_000) {
      out.push({ key: segment.id, startMs: segment.startMs, endMs: segment.endMs, segments: [segment], speaker: labelled ? segment.speaker : undefined });
    } else { current.segments.push(segment); current.endMs = labelled ? Math.max(current.endMs, segment.endMs) : segment.endMs; }
  }
  for (const p of out) p.signature = `${p.speaker ?? ''}#` + p.segments.map(s => `${s.id}:${s.revision}`).join('|');
  return out;
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
