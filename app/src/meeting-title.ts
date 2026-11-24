// Automatic meeting names: after a recording (or replay) ends and its transcript is final, the board's quick model names a
// meeting that still has the name HearAlong made up ("Meeting <stamp>", "Untitled meeting", "<file> (replay)"). A name the
// user gave is never replaced (the rename only applies while title = autoTitle), and later notes may still improve it.
// Only recordings that end while this server runs are named: older meetings keep their names.
import type { PiAnswer } from './pi-rpc.ts';
import { cleanSuggestedTitle, isAppMadeTitle, type Meeting, type MeetingStore } from './store.ts';

/** Fewer words than this give too little to name. */
export const TITLE_MIN_WORDS = 150;
/** The transcript part the model reads: the beginning, middle and end, in at most this many words. */
export const TITLE_SAMPLE_WORDS = 1500;
/** A title longer than this many words is cut. */
export const TITLE_MAX_WORDS = 8;

export type TitleAsk = (message: string) => Promise<PiAnswer>;

/** Still the name HearAlong made up, not one from notes, a title pass or the user. */
export function hasDefaultName(meeting: Meeting): boolean {
  if (meeting.autoTitle === null || meeting.title !== meeting.autoTitle) return false;
  return isAppMadeTitle(meeting.title, meeting.createdAt) || Boolean(meeting.replay && meeting.title.endsWith(' (replay)'));
}

/** The whole transcript when short; otherwise its beginning (40%), middle (30%) and end (30%), marked where words are left out. */
export function titleSample(lines: readonly string[], limit = TITLE_SAMPLE_WORDS): string {
  const words = lines.join(' ').split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  const head = Math.floor(limit * 0.4), middle = Math.floor(limit * 0.3), tail = limit - head - middle;
  const from = Math.floor((words.length - middle) / 2);
  return [words.slice(0, head), words.slice(from, from + middle), words.slice(words.length - tail)].map(part => part.join(' ')).join(' … ');
}

export function titlePrompt(sample: string): string {
  return [
    'Name this meeting. Below is its transcript (or its beginning, middle and end, joined by "…"). Speakers are not marked.',
    `Reply with one short title of at most ${TITLE_MAX_WORDS} words, in the language of the transcript: what the meeting was about, as a topic, not a sentence.`,
    'No quotation marks, no date, no words like "Meeting about" or "Discussion of". Reply with the title only.',
    '', 'Transcript:', '<<<', sample, '>>>',
  ].join('\n');
}

/** The model's reply as a meeting name, or '' when it is not usable. */
export function cleanTitleReply(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const title = cleanSuggestedTitle(line.replace(/^title\s*:\s*/i, ''));
  const words = title.split(' ');
  return words.length > TITLE_MAX_WORDS ? cleanSuggestedTitle(words.slice(0, TITLE_MAX_WORDS).join(' ')) : title;
}

type Options = {
  store: MeetingStore;
  /** The model call, or null while AI is off (checked on every tick). */
  ask: () => TitleAsk | null;
  /** Recording, replaying or still transcribing: wait. */
  stillComing: (meetingId: string) => boolean;
  /** Recordings that ended before this time are not named. */
  since: number;
  log?: (message: string) => void;
};

export class MeetingTitles {
  /** meeting id + recordingEndedAt: each ended recording gets one attempt, whatever its outcome. */
  private readonly tried = new Set<string>();
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
    this.tried.add(next.key);
    this.running = this.name(next.meeting, ask).finally(() => { this.running = null; });
    return this.running;
  }

  /** Waits for a call in progress (shutdown). */
  async idle() { await this.running?.catch(() => {}); }

  private next(): { meeting: Meeting; key: string } | null {
    const { store, since, stillComing } = this.options;
    const ended = store.db.prepare('SELECT id, recordingEndedAt FROM meetings WHERE recordingEndedAt IS NOT NULL AND recordingEndedAt >= ?')
      .all(since) as { id: string; recordingEndedAt: number }[];
    for (const row of ended) {
      const key = `${row.id}:${row.recordingEndedAt}`;
      if (this.tried.has(key) || stillComing(row.id)) continue;
      let meeting: Meeting;
      try { meeting = store.meeting(row.id); } catch { continue; } // deleted meanwhile
      if (!hasDefaultName(meeting)) { this.tried.add(key); continue; }
      const words = store.segments(row.id).reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
      if (words < TITLE_MIN_WORDS) { this.tried.add(key); continue; }
      return { meeting, key };
    }
    return null;
  }

  private async name(meeting: Meeting, ask: TitleAsk) {
    const { store, log = message => console.log(message) } = this.options;
    try {
      const answer = await ask(titlePrompt(titleSample(store.segments(meeting.id).map(s => s.text))));
      if (answer.aborted || (answer.stopReason !== undefined && answer.stopReason !== 'stop')) throw new Error(`the model stopped early (${answer.stopReason ?? 'aborted'})`);
      const title = cleanTitleReply(answer.text);
      if (!title) { log(`Meeting title ${meeting.id.slice(0, 8)}: no usable title in the reply`); return; }
      // Only while the name is still the made-up one read above: notes or the user renaming it meanwhile win.
      if (store.titleFromTranscript(meeting.id, meeting.title, title)) log(`Meeting title ${meeting.id.slice(0, 8)}: named from its transcript`);
    } catch (error) {
      log(`Meeting title ${meeting.id.slice(0, 8)}: ${(error as Error).message}`);
    }
  }
}
