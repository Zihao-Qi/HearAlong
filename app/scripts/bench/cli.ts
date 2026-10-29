// Flag parsing for the benchmark runners. Planning only: nothing is downloaded or transcribed here.
import { isMeetingId, isMic, MICS, SC_MEETINGS, type MeetingId, type Mic } from './ami.ts';

export type WerArgs = { sessions: MeetingId[]; mics: Mic[]; label: string | null };
export type LiveArgs = { session: MeetingId; mic: Mic; from: string; fromSec: number; minutes: number; label: string | null };

const WER_USAGE = 'Usage: npm run bench:wer -- [--sessions ES2004a,ES2004b] [--mic Mix-Headset|Array1-01] [--run-label text]';
const LIVE_USAGE = 'Usage: npm run bench:live -- --session ES2004a [--mic Mix-Headset|Array1-01] [--from M:SS] [--minutes N] [--run-label text]';

function take(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
  return value;
}

/** `--from M:SS` on the AMI clock. Minutes may exceed 59 (`90:00`). */
export function clockToSeconds(value: string): number {
  if (!/^\d+:[0-5]\d$/.test(value)) throw new Error('--from must be M:SS.');
  const [minutes, seconds] = value.split(':').map(Number);
  const total = minutes * 60 + seconds;
  if (!Number.isSafeInteger(total)) throw new Error('--from is too large.');
  return total;
}

/** Omitted sessions mean the whole SC set. Omitted mics mean both conditions. Repeated flags accumulate. */
export function parseWerArgs(argv: string[]): WerArgs {
  const sessions: MeetingId[] = [];
  const mics: Mic[] = [];
  let label: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sessions') {
      for (const piece of take(argv, ++i, arg).split(',')) {
        const id = piece.trim();
        if (!id) continue;
        if (!isMeetingId(id)) throw new Error(`Unknown session ${id}.`);
        if (!sessions.includes(id)) sessions.push(id);
      }
    } else if (arg === '--mic') {
      const mic = take(argv, ++i, arg);
      if (!isMic(mic)) throw new Error('--mic must be Mix-Headset or Array1-01.');
      if (!mics.includes(mic)) mics.push(mic);
    } else if (arg === '--run-label') {
      label = take(argv, ++i, arg);
    } else throw new Error(`Unknown argument: ${arg}\n${WER_USAGE}`);
  }
  return { sessions: sessions.length ? sessions : [...SC_MEETINGS], mics: mics.length ? mics : [...MICS], label };
}

/** One meeting and one microphone. `--minutes` defaults to 10. `--from` defaults to `0:00`. `--mic` defaults to Mix-Headset. */
export function parseLiveArgs(argv: string[]): LiveArgs {
  let session: MeetingId | undefined;
  let mic: Mic = 'Mix-Headset';
  let from = '0:00';
  let minutes = 10;
  let label: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}\n${LIVE_USAGE}`);
    if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
    seen.add(arg);
    if (arg === '--session') {
      const id = take(argv, ++i, arg);
      if (!isMeetingId(id)) throw new Error(`Unknown session ${id}.`);
      session = id;
    } else if (arg === '--mic') {
      const value = take(argv, ++i, arg);
      if (!isMic(value)) throw new Error('--mic must be Mix-Headset or Array1-01.');
      mic = value;
    } else if (arg === '--from') from = take(argv, ++i, arg);
    else if (arg === '--minutes') {
      const value = take(argv, ++i, arg);
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error('--minutes must be a positive number.');
      minutes = Number(value);
    } else if (arg === '--run-label') label = take(argv, ++i, arg);
    else throw new Error(`Unknown argument: ${arg}\n${LIVE_USAGE}`);
  }
  if (!session) throw new Error(LIVE_USAGE);
  return { session, mic, from, fromSec: clockToSeconds(from), minutes, label };
}
