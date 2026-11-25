// Automatic meeting names: the Board's model names a meeting that still has the name HearAlong made up ("Meeting <stamp>",
// "Untitled meeting", "<file> (replay)") from the first words of its transcript, as soon as those are in: during the recording
// or replay once it has TITLE_WORDS words, else after it ends (from at least TITLE_MIN_WORDS). One call per meeting. A name the
// user gave is never replaced (the rename only applies while title = autoTitle), and later notes may still improve it.
// Only meetings recorded or replayed while this server runs are named: older meetings keep their names.
import { isAiDeferred } from './ai-deferral.ts';
import type { PiAnswer } from './pi-rpc.ts';
import { cleanSuggestedTitle, isAppMadeTitle, type Meeting, type MeetingStore } from './store.ts';

/** Fewer words than this give too little to name. */
export const TITLE_MIN_WORDS = 150;
/** The model reads the first this-many words, and a meeting is named once it has them (about 7–8 minutes of talk). */
export const TITLE_WORDS = 1000;
/** A title longer than this many words is cut. */
export const TITLE_MAX_WORDS = 8;

export type TitleAsk = (message: string) => Promise<PiAnswer>;

/** "Meeting " and a short stamp with a clock time ("10:17", "18.21", "08 h 41"), as the page makes up in any locale. A clock
 * time is in every page stamp and in hardly any title: "Meeting 2026 roadmap" is not one. */
export function looksLikeStamp(title: string): boolean {
  return title.length <= 48 && /^Meeting [^\n]{0,30}\p{Nd}{1,2}\s?(?:[:.]|h)\s?\p{Nd}{2}/u.test(title);
}

/** Still the name HearAlong made up, not one from notes, a title pass or the user. The page stamps "Meeting <date and time>" in
 * its own locale, which can differ from this server's: any "Meeting " name with a digit in a short stamp counts too (a model's
 * title is told not to start that way). */
export function hasDefaultName(meeting: Meeting): boolean {
  if (meeting.autoTitle === null || meeting.title !== meeting.autoTitle) return false;
  if (isAppMadeTitle(meeting.title, meeting.createdAt)) return true;
  if (looksLikeStamp(meeting.title)) return true;
  return Boolean(meeting.replay && meeting.title.endsWith(' (replay)'));
}

const wordsOf = (lines: readonly string[]) => lines.join(' ').split(/\s+/).filter(Boolean);

/** The first `limit` words of the transcript. */
export function titleSample(lines: readonly string[], limit = TITLE_WORDS): string {
  return wordsOf(lines).slice(0, limit).join(' ');
}

export function titlePrompt(sample: string): string {
  return [
    'Name this meeting. Below is the start of its transcript (all of it, if short). Speakers are not marked.',
    'Opening small talk is not the topic: name what the meeting is about.',
    `Reply with one short title of at most ${TITLE_MAX_WORDS} words, in the language of the transcript: the topic, not a sentence.`,
    'No quotation marks, no date, no words like "Meeting about" or "Discussion of". Reply with the title only.',
    '', 'Transcript:', '<<<', sample, '>>>',
  ].join('\n');
}

/** More words than this in the chosen line is an explanation, not a title: rejected rather than cut. */
const TITLE_REPLY_MAX_WORDS = 12;
const REFUSAL = /^(?:i (?:cannot|can't|can not|couldn't|could not|am unable|am not able|am sorry|am afraid|don't|do not)\b|i'm (?:sorry|unable|not able|afraid)\b|sorry\b|unfortunately\b|as an ai\b|cannot\b|can't\b|unable\b|no title\b|(?:n\/a|none|unknown|untitled(?: meeting)?)\W*$)/i;

/** The model's reply as a meeting name, or '' when it is not usable: markdown and a "Title:" label are removed, a lead-in line
 * ("Here's a title:") is skipped, and a refusal or an explanation is rejected. */
export function cleanTitleReply(text: string): string {
  const lines = text.replace(/[\u2018\u2019]/g, "'").split('\n')
    .map(l => l.replace(/^\s*```+\s*(?=\S.*```)/, '').replace(/```+\s*$/, '')) // a one-line fence keeps its content
    .filter(l => !/^\s*```/.test(l)) // a fence line, with or without a language tag
    .map(l => l.trim().replace(/^(?:[-*•>]+|#+|\d+[.)])\s*/, '').replace(/[*_`]+/g, '').replace(/^title\s*:\s*/i, '').trim())
    .filter(l => l && !/:$/.test(l));
  const line = lines[0] ?? '';
  if (line.split(/\s+/).length > TITLE_REPLY_MAX_WORDS) return '';
  // Checked once quotes and a final full stop are gone: '"I cannot name this."' and 'N/A.' are refusals too.
  const title = cleanSuggestedTitle(line);
  if (REFUSAL.test(title)) return '';
  const words = title.split(' ').filter(Boolean);
  const name = words.length > TITLE_MAX_WORDS ? cleanSuggestedTitle(words.slice(0, TITLE_MAX_WORDS).join(' ')) : title;
  // A name HearAlong itself would make up is no name, checked on the name as it would be saved (after any cut).
  return looksLikeStamp(name) ? '' : name;
}

type Options = {
  store: MeetingStore;
  /** The model call, or null while AI is off (checked on every tick). */
  ask: () => TitleAsk | null;
  /** Recording, replaying or still transcribing: a meeting short of TITLE_WORDS waits. */
  stillComing: (meetingId: string) => boolean;
  /** Meetings being recorded now (replays are found by their end time and their visible words). */
  recording: () => Iterable<string>;
  /** Recordings that ended before this time are not named. */
  since: number;
  now?: () => number;
  log?: (message: string) => void;
};

export class MeetingTitles {
  /** Meeting ids: each meeting gets one model call, whatever its outcome (a postponed call is none). */
  private readonly tried = new Set<string>();
  /** Meetings found too short, by the version of their transcript (and whether more was coming) then. */
  private readonly short = new Map<string, string>();
  private running: Promise<void> | null = null;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  /** One meeting at a time; a tick during a call does nothing. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const ask = this.options.ask();
    if (!ask) return Promise.resolve();
    const next = this.next();
    if (!next) return Promise.resolve();
    this.tried.add(next.meeting.id);
    this.running = this.name(next.meeting, next.lines, ask).finally(() => { this.running = null; });
    return this.running;
  }

  /** Waits for a call in progress (shutdown). */
  async idle() { await this.running?.catch(() => {}); }

  private next(): { meeting: Meeting; lines: string[] } | null {
    const { store, since, stillComing, now = Date.now } = this.options;
    // Only meetings that still carry an app name: one the user, notes or a title pass named drops out here, in SQL.
    const candidates = new Set((store.db.prepare(`SELECT id FROM meetings WHERE recordingEndedAt IS NOT NULL AND recordingEndedAt >= ?
      AND autoTitle IS NOT NULL AND title = autoTitle`).all(since) as { id: string }[]).map(row => row.id));
    for (const id of this.options.recording()) candidates.add(id);
    // The transcript's version: new lines, corrected lines (each bumps its revision) and their text.
    const transcribed = store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(revision), 0) AS revisions, COALESCE(SUM(length(text)), 0) AS chars FROM segments WHERE meetingId=?');
    for (const id of candidates) {
      if (this.tried.has(id)) continue;
      let meeting: Meeting;
      try { meeting = store.meeting(id); } catch { continue; } // deleted meanwhile
      if (!hasDefaultName(meeting)) {
        // Named by notes, the user or an earlier pass: done. A "(replay)" name is checked again: the meeting is marked as a
        // replay just after its upload ends.
        if (!meeting.title.endsWith(' (replay)')) this.tried.add(id);
        continue;
      }
      const coming = stillComing(id);
      // A replay shows its words as it plays: those are counted, so the count grows with no new lines.
      const playing = coming && Boolean(store.replay(id));
      // Too short: counted again only once its transcript changes or stops coming in, so it costs one query a tick.
      const { n, revisions, chars } = transcribed.get(id) as { n: number; revisions: number; chars: number };
      const version = `${n}:${revisions}:${chars}:${coming}`;
      if (!playing && this.short.get(id) === version) continue;
      const lines = store.visibleSegments(id, now()).map(s => s.text);
      const words = wordsOf(lines).length;
      if (words >= TITLE_WORDS || (!coming && words >= TITLE_MIN_WORDS)) { this.short.delete(id); return { meeting, lines }; }
      this.short.set(id, version);
    }
    return null;
  }

  private async name(meeting: Meeting, lines: string[], ask: TitleAsk) {
    const { store, log = message => console.log(message) } = this.options;
    try {
      const answer = await ask(titlePrompt(titleSample(lines)));
      if (answer.aborted || (answer.stopReason !== undefined && answer.stopReason !== 'stop')) throw new Error(`the model stopped early (${answer.stopReason ?? 'aborted'})`);
      const title = cleanTitleReply(answer.text);
      if (!title) { log(`Meeting title ${meeting.id.slice(0, 8)}: no usable title in the reply`); return; }
      // Only while the name is still the made-up one read above: notes or the user renaming it meanwhile win.
      if (store.titleFromTranscript(meeting.id, meeting.title, title)) log(`Meeting title ${meeting.id.slice(0, 8)}: named from its transcript`);
    } catch (error) {
      // Postponed by the model lane (a recording started on a local model, a model switch): not an attempt, try again later.
      if (isAiDeferred(error)) { this.tried.delete(meeting.id); return; }
      log(`Meeting title ${meeting.id.slice(0, 8)}: ${(error as Error).message}`);
    }
  }
}
