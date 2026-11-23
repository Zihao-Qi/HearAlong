// Pure parts of the call benchmark (npm run bench:call): the pair plan, the talk-state layout, the simulated speaker echo
// with its fixed room tail, and the scoring split. No files, network, model or server here; the runner owns those.
import { backtrace, corpusWer, normalize, wer, type WerResult } from './wer.ts';
import { sumScores } from './breakdown.ts';
import type { ReferenceWord } from './ami.ts';

export const SAMPLE_RATE = 16000;
export type Source = { meeting: string; speaker: string };
export type CallPair = { near: Source; far: Source; delayMs: number; gainDb: number };
/** Near ("Me") and far ("Them") speakers come from different AMI meetings, so no headset bleed is shared. Also used by aec-run.ts. */
export const PAIRS: CallPair[] = [
  { near: { meeting: 'ES2004a', speaker: 'B' }, far: { meeting: 'IS1009a', speaker: 'A' }, delayMs: 30, gainDb: -6 },
  { near: { meeting: 'IS1009a', speaker: 'D' }, far: { meeting: 'TS3003a', speaker: 'A' }, delayMs: 50, gainDb: -8 },
  { near: { meeting: 'TS3003a', speaker: 'D' }, far: { meeting: 'EN2002a', speaker: 'C' }, delayMs: 70, gainDb: -9 },
  { near: { meeting: 'EN2002a', speaker: 'B' }, far: { meeting: 'ES2004b', speaker: 'D' }, delayMs: 100, gainDb: -10 },
  { near: { meeting: 'ES2004b', speaker: 'A' }, far: { meeting: 'IS1009b', speaker: 'C' }, delayMs: 120, gainDb: -12 },
];
export const pairName = (pair: CallPair) => `${pair.near.meeting}.${pair.near.speaker}+${pair.far.meeting}.${pair.far.speaker}`;

export type TalkState = 'echoOnly' | 'nearOnly' | 'doubleTalk';
export const TALK_STATES: TalkState[] = ['echoOnly', 'nearOnly', 'doubleTalk'];
/** Blocks repeat far only (echo only), near only, double talk, as in aec-run.ts: six blocks give far [0,2,3,5] and near [1,2,4,5]. */
export const stateOf = (block: number): TalkState => TALK_STATES[block % 3];

export type Layout = { blocks: number; blockSeconds: number; leadSeconds: number; tailSeconds: number };
/** Silence before the first block lets the call source start (the helper begins about 2 s after the microphone) before any speech. */
export function callLayout(blocks: number): Layout {
  if (!Number.isInteger(blocks) || blocks < 3 || blocks % 3) throw new Error('Blocks must be a positive multiple of three.');
  return { blocks, blockSeconds: 20, leadSeconds: 6, tailSeconds: 4 };
}
export const layoutSeconds = (layout: Layout) => layout.leadSeconds + layout.blocks * layout.blockSeconds + layout.tailSeconds;
export const layoutSamples = (layout: Layout) => Math.round(layoutSeconds(layout) * SAMPLE_RATE);
export const farBlocks = (layout: Layout) => Array.from({ length: layout.blocks }, (_, b) => b).filter(b => stateOf(b) !== 'nearOnly');
export const nearBlocks = (layout: Layout) => Array.from({ length: layout.blocks }, (_, b) => b).filter(b => stateOf(b) !== 'echoOnly');
/** Block index of a file position in seconds, or null in the lead or tail. */
export function blockAt(layout: Layout, fileSeconds: number): number | null {
  const block = Math.floor((fileSeconds - layout.leadSeconds) / layout.blockSeconds);
  return Number.isFinite(block) && block >= 0 && block < layout.blocks ? block : null;
}

/** An error when the call source started too late to carry the far speaker's first words (later than the lead minus 1 s), else null. */
export function lateCallStart(layout: Layout, callStartMs: number | null): string | null {
  const latestMs = (layout.leadSeconds - 1) * 1000;
  if (callStartMs === null || !Number.isFinite(callStartMs)) return 'The call start time is unknown.';
  return callStartMs > latestMs ? `The call source started ${(callStartMs / 1000).toFixed(2)} s after the microphone, later than ${latestMs / 1000} s (the lead minus 1 s): early far audio was not sent, so this pair is not scored.` : null;
}

export type Clip = { start: number; end: number };
export type PlannedClip = Clip & { at: number };
/**
 * Pack complete annotated utterances into the given blocks, in corpus order, as aec-run.ts does: each block starts 0.3 s in,
 * ends 0.6 s early, clips keep 0.1 s of their edges, and 0.35 s separates them. A clip that does not fit is kept for a later block.
 * `at` is the file position (lead included). Each block must hold at least 10 s of speech.
 */
export function planClips(clips: Clip[], blocks: number[], layout: Layout): PlannedClip[] {
  const left = [...clips], planned: PlannedClip[] = [];
  for (const block of blocks) {
    const first = layout.leadSeconds + block * layout.blockSeconds;
    let at = first + 0.3;
    const end = first + layout.blockSeconds - 0.6;
    while (at < end - 1) {
      const index = left.findIndex(clip => clip.end + 0.1 - Math.max(0, clip.start - 0.1) <= end - at);
      if (index < 0) break;
      const [clip] = left.splice(index, 1), start = Math.max(0, clip.start - 0.1), stop = clip.end + 0.1;
      planned.push({ start, end: stop, at });
      at += stop - start + 0.35;
    }
    if (at < first + 10) throw new Error(`Insufficient speech in block ${block}.`);
  }
  return planned;
}

/**
 * Copy planned clips from one decoded headset (`audio` starts at corpus time 0) with 10 ms edge fades, move their reference words,
 * and scale to 0.06 RMS over active 10 ms blocks (not the whole file, which holds silent talk states).
 */
export function placeClips(audio: Float32Array, planned: PlannedClip[], words: ReferenceWord[], samples: number) {
  const pcm = new Float32Array(samples), placed: ReferenceWord[] = [];
  for (const clip of planned) {
    const first = Math.round(clip.start * SAMPLE_RATE), last = Math.round(clip.end * SAMPLE_RATE), out = Math.round(clip.at * SAMPLE_RATE);
    for (let i = 0; i < last - first && out + i < samples; i++) pcm[out + i] = (audio[first + i] ?? 0) * Math.min(1, i / 160, (last - first - 1 - i) / 160);
    placed.push(...words.filter(word => word.start >= clip.start && word.end <= clip.end)
      .map(word => ({ ...word, start: clip.at + word.start - clip.start, end: clip.at + word.end - clip.start })));
  }
  let sum = 0, count = 0;
  for (let pos = 0; pos + 160 <= samples; pos += 160) {
    const p = power(pcm, pos, pos + 160);
    if (p > 1e-7) { sum += p; count++; }
  }
  if (!count) throw new Error('No speech was placed.');
  const scale = 0.06 / Math.sqrt(sum / count);
  for (let i = 0; i < samples; i++) pcm[i] *= scale;
  return { pcm, words: placed.sort((a, b) => a.start - b.start || a.end - b.end), scale };
}

export function power(pcm: Float32Array, start = 0, end = pcm.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += pcm[i] ** 2;
  return sum / Math.max(1, end - start);
}

/** Deterministic 32-bit LCG in [0, 1). */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

export type Tap = { samples: number; gain: number };
/**
 * The fixed synthetic room tail, the same for every pair and run: a direct path, three early reflections (4, 9 and 17 ms),
 * and a sparse diffuse tail with one tap per millisecond from 20 to 80 ms, decaying with a 20 ms time constant, signs from seed 7.
 * The speaker is a one-pole 3 kHz low-pass before it. `ROOM_VERSION` names this shape in the results.
 */
export const ROOM_VERSION = 'lp3k-direct-3refl-diffuse20to80ms-tau20-seed7';
export function roomTaps(): Tap[] {
  const taps: Tap[] = [{ samples: 0, gain: 1 }, { samples: 64, gain: 0.4 }, { samples: 144, gain: -0.25 }, { samples: 272, gain: 0.15 }];
  const random = lcg(7);
  for (let ms = 20; ms <= 80; ms++) taps.push({ samples: ms * 16, gain: (random() < 0.5 ? -1 : 1) * 0.06 * Math.exp(-(ms - 20) / 20) });
  return taps;
}

/** Far audio as the microphone hears it from the speaker: low-pass, room taps, then `delayMs` later. Unscaled. */
export function speakerEcho(far: Float32Array, delayMs: number, taps: Tap[] = roomTaps()): Float32Array {
  const filtered = new Float32Array(far.length), echo = new Float32Array(far.length);
  const alpha = 1 - Math.exp(-2 * Math.PI * 3000 / SAMPLE_RATE);
  let low = 0;
  for (let i = 0; i < far.length; i++) { low += alpha * (far[i] - low); filtered[i] = low; }
  const delay = Math.round(delayMs / 1000 * SAMPLE_RATE);
  for (const tap of taps) {
    const shift = delay + tap.samples;
    for (let i = shift; i < far.length; i++) echo[i] += filtered[i - shift] * tap.gain;
  }
  return echo;
}

export type CallCondition = 'echo' | 'control';
/**
 * The microphone: near speech plus the speaker echo at `gainDb` below the near speech power (whole-file powers, as in aec-run.ts),
 * plus white noise at -65 dBFS from a fixed seed. Everything (including the far source sent as the call) is scaled together so the
 * loudest sample of the echo mix is at most 0.9: no clipping, and the echo, noise and speech ratios stay as set.
 * The `control` condition is the same microphone with the echo left out (echo gain zero): the same near speech, noise and common
 * scale, and the same call source, so the two conditions differ only by the echo.
 */
export function mixMicrophone(near: Float32Array, far: Float32Array, pair: Pick<CallPair, 'delayMs' | 'gainDb'>, seed: number, condition: CallCondition = 'echo') {
  if (near.length !== far.length) throw new Error('Near and far audio must have the same length.');
  const echo = speakerEcho(far, pair.delayMs);
  const echoPower = power(echo), nearPower = power(near);
  const echoScale = echoPower > 0 ? 10 ** (pair.gainDb / 20) * Math.sqrt(nearPower / echoPower) : 0;
  const random = lcg(seed), noise = Math.sqrt(3) * 10 ** (-65 / 20);
  const mic = new Float32Array(near.length);
  let peak = 0;
  for (let i = 0; i < mic.length; i++) {
    const dry = near[i] + (random() * 2 - 1) * noise, wet = dry + echo[i] * echoScale;
    mic[i] = condition === 'echo' ? wet : dry;
    peak = Math.max(peak, Math.abs(wet), Math.abs(dry), Math.abs(near[i]), Math.abs(far[i]));
  }
  const commonScale = peak > 0.9 ? 0.9 / peak : 1;
  const call = new Float32Array(far.length);
  for (let i = 0; i < mic.length; i++) { mic[i] *= commonScale; call[i] = far[i] * commonScale; }
  return { mic, call, room: { version: ROOM_VERSION, condition, delayMs: pair.delayMs, gainDb: pair.gainDb, echoScale: condition === 'echo' ? echoScale : 0, commonScale,
    noiseDbfs: -65 + 20 * Math.log10(commonScale) } };
}

/** Plain 16-bit PCM mono WAV, the format the rehearsal's fake microphone plays. */
export function pcm16Wav(pcm: Float32Array): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24); out.writeUInt32LE(SAMPLE_RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32768))), 44 + i * 2);
  return out;
}

/** One saved transcript line. `source` is `mic:…` (Me) or `app:…`/`tab:…` (Them). `words` are its recognizer word times, when they match its text. */
export type Line = { id: string; source: string; startMs: number; endMs: number; text: string; ord?: number; words?: { text: string; startMs: number; endMs: number }[] };
/** Meeting milliseconds of file position 0 for each side. The two are measured separately (mic frames; the call helper). */
export type Timebase = { micZeroMs: number; callZeroMs: number };
const isMe = (line: Line) => line.source.startsWith('mic:');
const isThem = (line: Line) => line.source.startsWith('app:') || line.source.startsWith('tab:');
const byTime = (a: Line, b: Line) => a.startMs - b.startMs || (a.ord ?? 0) - (b.ord ?? 0) || a.id.localeCompare(b.id);

/**
 * The parts of one line per block, on its own side's time base. With word times, each word goes to the block that holds its start;
 * without them, the whole line goes to the block of its start. Starts, not ends or midpoints: the recognizer can stretch a window's
 * last word to the window end, across the silence that follows.
 */
export function linePieces(layout: Layout, timebase: Timebase, line: Line): { block: number | null; text: string }[] {
  const zero = isMe(line) ? timebase.micZeroMs : timebase.callZeroMs;
  const at = (ms: number) => blockAt(layout, (ms - zero) / 1000);
  if (!line.words?.length) return [{ block: at(line.startMs), text: line.text }];
  const pieces: { block: number | null; text: string }[] = [];
  for (const word of line.words) {
    const block = at(word.startMs), last = pieces.at(-1);
    if (last && last.block === block) last.text += ` ${word.text}`;
    else pieces.push({ block, text: word.text });
  }
  return pieces;
}
/** A reference word belongs to the block that holds its start (the packing never lets a word cross a block). */
export const wordBlock = (layout: Layout, word: ReferenceWord) => blockAt(layout, word.start);

export type Leak = { farWords: number; matched: number; meWords: number; rate: number };
export type Hidden = { lines: number; words: number; genuine: number; recognizedGenuine: number };
export type StateScore = { me: WerResult; meRaw: WerResult; them: WerResult; leak: Leak; leakRaw: Leak; hidden: Hidden };
export type CallScore = Record<TalkState, StateScore> & { outside: { meWords: number; themWords: number; lines: number }; straddling: number };

const emptyHidden = (): Hidden => ({ lines: 0, words: 0, genuine: 0, recognizedGenuine: 0 });
const leakOf = (farWords: number, matched: number, meWords: number): Leak => ({ farWords, matched, meWords, rate: farWords ? matched / farWords : 0 });

/**
 * Near reference words that the recognizer got right in the raw Me lines, and how many of those sit in lines the read-time echo
 * rule hid. One alignment of the reference against the raw Me words in line order; a hit whose word belongs to a hidden line counts.
 */
export function hiddenGenuine(reference: string, rawLines: Line[], shown: ReadonlySet<string>): Hidden {
  const ref = normalize(reference), hyp: string[] = [], owner: string[] = [];
  const result = emptyHidden();
  for (const line of [...rawLines].sort(byTime)) {
    const tokens = normalize(line.text);
    for (const token of tokens) { hyp.push(token); owner.push(line.id); }
    if (!shown.has(line.id)) { result.lines++; result.words += tokens.length; }
  }
  for (const step of backtrace(ref, hyp)) {
    if (step.kind !== 'hits' || step.hypothesisIndex === null) continue;
    result.recognizedGenuine++;
    if (!shown.has(owner[step.hypothesisIndex])) result.genuine++;
  }
  return result;
}

/**
 * Per talk state: Me WER on the shown view (and raw), far words that reached Me (shown and raw), Them WER, and genuine Me words the
 * echo rule hid. Each block is aligned on its own; a state sums its blocks' counts. In echo-only blocks the near reference is empty,
 * so Me "WER" is all insertions; `leak.meWords` is the count to read there. `straddling` counts lines whose words fall in more than
 * one block (or in a block and the lead or tail); each part is scored with its own block.
 */
export function scoreCall(input: { layout: Layout; timebase: Timebase; nearWords: ReferenceWord[]; farWords: ReferenceWord[]; lines: Line[]; shown: ReadonlySet<string> }): CallScore {
  const { layout, timebase, lines, shown } = input;
  const perBlock = Array.from({ length: layout.blocks }, () => ({ me: [] as Line[], them: [] as Line[] }));
  const outside = { meWords: 0, themWords: 0, lines: 0 };
  let straddling = 0;
  for (const line of [...lines].sort(byTime)) {
    if (!isMe(line) && !isThem(line)) continue;
    const pieces = linePieces(layout, timebase, line);
    if (new Set(pieces.map(piece => piece.block)).size > 1) straddling++;
    for (const piece of pieces) {
      if (piece.block === null) {
        outside.lines++;
        if (shown.has(line.id)) outside[isMe(line) ? 'meWords' : 'themWords'] += normalize(piece.text).length;
      } else perBlock[piece.block][isMe(line) ? 'me' : 'them'].push({ ...line, text: piece.text });
    }
  }
  const text = (items: Line[], visible = true) => items.filter(line => !visible || shown.has(line.id)).map(line => line.text).join(' ');
  const refText = (words: ReferenceWord[], block: number) => words.filter(word => wordBlock(layout, word) === block).map(word => word.text).join(' ');
  const result = { outside, straddling } as CallScore;
  const firstBlock = new Map<string, number>();
  perBlock.forEach((item, block) => { for (const line of item.me) if (!firstBlock.has(line.id)) firstBlock.set(line.id, block); });
  for (const state of TALK_STATES) {
    const blocks = perBlock.flatMap((lines, block) => stateOf(block) === state ? [{ block, ...lines }] : []);
    const me = corpusWer(blocks.map(item => ({ reference: refText(input.nearWords, item.block), hypothesis: text(item.me) })));
    const meRaw = corpusWer(blocks.map(item => ({ reference: refText(input.nearWords, item.block), hypothesis: text(item.me, false) })));
    const them = corpusWer(blocks.map(item => ({ reference: refText(input.farWords, item.block), hypothesis: text(item.them) })));
    const leak = (visible: boolean) => {
      let farWords = 0, matched = 0, meWords = 0;
      for (const item of blocks) {
        const scored = wer(refText(input.farWords, item.block), text(item.me, visible));
        farWords += scored.referenceWords; matched += scored.hits; meWords += normalize(text(item.me, visible)).length;
      }
      return leakOf(farWords, matched, meWords);
    };
    const hidden = blocks.map(item => hiddenGenuine(refText(input.nearWords, item.block), item.me, shown))
      .reduce((sum, item) => ({ lines: sum.lines, words: sum.words + item.words, genuine: sum.genuine + item.genuine,
        recognizedGenuine: sum.recognizedGenuine + item.recognizedGenuine }), emptyHidden());
    // A hidden line split across blocks counts once, in the first block (in time) that holds part of it.
    hidden.lines = [...firstBlock].filter(([id, block]) => !shown.has(id) && stateOf(block) === state).length;
    result[state] = { me, meRaw, them, leak: leak(true), leakRaw: leak(false), hidden };
  }
  return result;
}

/** Sum per-state scores across pairs (counts, then rates from the sums). */
export function sumCallScores(scores: CallScore[]): CallScore {
  const result = { outside: { meWords: 0, themWords: 0, lines: 0 }, straddling: 0 } as CallScore;
  for (const score of scores) {
    for (const key of ['meWords', 'themWords', 'lines'] as const) result.outside[key] += score.outside[key];
    result.straddling += score.straddling;
  }
  const leaks = (items: Leak[]) => leakOf(items.reduce((n, l) => n + l.farWords, 0), items.reduce((n, l) => n + l.matched, 0), items.reduce((n, l) => n + l.meWords, 0));
  for (const state of TALK_STATES) {
    const items = scores.map(score => score[state]);
    result[state] = { me: sumScores(items.map(i => i.me)), meRaw: sumScores(items.map(i => i.meRaw)), them: sumScores(items.map(i => i.them)),
      leak: leaks(items.map(i => i.leak)), leakRaw: leaks(items.map(i => i.leakRaw)),
      hidden: items.reduce((sum, i) => ({ lines: sum.lines + i.hidden.lines, words: sum.words + i.hidden.words, genuine: sum.genuine + i.hidden.genuine,
        recognizedGenuine: sum.recognizedGenuine + i.hidden.recognizedGenuine }), emptyHidden()) };
  }
  return result;
}

/** Median of `startMs - captureWallMs` over frames: meeting ms = wall ms + this, for one source. */
export function wallToMeetingMs(frames: { startMs: number; captureWallMs: number }[]): number | null {
  const values = frames.map(frame => frame.startMs - frame.captureWallMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
