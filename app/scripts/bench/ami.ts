// AMI Meeting Corpus layout for the Full-corpus-ASR SC (unseen evaluation) set. No network and no audio here.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Official SC meetings, in the order the corpus lists them. */
export const SC_MEETINGS = [
  'ES2004a', 'ES2004b', 'ES2004c', 'ES2004d',
  'IS1009a', 'IS1009b', 'IS1009c', 'IS1009d',
  'TS3003a', 'TS3003b', 'TS3003c', 'TS3003d',
  'EN2002a', 'EN2002b', 'EN2002c', 'EN2002d',
] as const;

export type MeetingId = (typeof SC_MEETINGS)[number];

/** Close-talk mix, then one far-field array channel (the condition closest to a person in the room). */
export const MICS = ['Mix-Headset', 'Array1-01'] as const;
export type Mic = (typeof MICS)[number];

/** Speaker channels in the manual annotation. A meeting file that is absent is skipped; none at all is an error. */
export const SPEAKERS = ['A', 'B', 'C', 'D'] as const;

export const ANNOTATIONS_URL = 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip';
export const ANNOTATIONS_ZIP = 'ami_public_manual_1.6.2.zip';

export function isMeetingId(value: string): value is MeetingId {
  return (SC_MEETINGS as readonly string[]).includes(value);
}

export function isMic(value: string): value is Mic {
  return (MICS as readonly string[]).includes(value);
}

export function audioUrl(meetingId: string, mic: Mic): string {
  return `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${meetingId}/audio/${meetingId}.${mic}.wav`;
}

export type BenchPaths = {
  /** Replaces `app/artifacts/bench` when `HEARALONG_BENCH_DIR` is set. */
  root: string;
  ami: string;
  download: string;
  annotations: string;
  words: string;
  manifest: string;
  results: string;
  work: string;
  zip: string;
  audioDir: (meetingId: string) => string;
  wav: (meetingId: string, mic: Mic) => string;
  wordsFile: (meetingId: string, speaker: string) => string;
};

/** `HEARALONG_BENCH_DIR` overrides the bench root. Otherwise `app/artifacts/bench` (git-ignored). */
export function benchPaths(root = process.env.HEARALONG_BENCH_DIR ? resolve(process.env.HEARALONG_BENCH_DIR) : join(appRoot, 'artifacts', 'bench')): BenchPaths {
  const ami = join(root, 'ami');
  const words = join(ami, 'annotations', 'words');
  return {
    root, ami,
    download: join(ami, 'download'),
    annotations: join(ami, 'annotations'),
    words,
    manifest: join(ami, 'manifest.json'),
    results: join(root, 'results'),
    work: join(root, 'work'),
    zip: join(ami, 'download', ANNOTATIONS_ZIP),
    audioDir: meetingId => join(ami, 'audio', meetingId),
    wav: (meetingId, mic) => join(ami, 'audio', meetingId, `${meetingId}.${mic}.wav`),
    wordsFile: (meetingId, speaker) => join(words, `${meetingId}.${speaker}.words.xml`),
  };
}

export type ReferenceWord = { text: string; start: number; end: number; speaker: string };

export type ReferenceOptions = {
  /** Include words with start time >= this, in seconds on the AMI clock. Omit for no lower bound. */
  fromSec?: number;
  /** Exclude words with start time >= this. Omit for no upper bound. The window is half-open. */
  toSec?: number;
  /** Bench root. Defaults to `benchPaths()`. */
  root?: string;
};

/**
 * Reference words for one meeting.
 * Every speaker file that exists (`<ID>.A` … `<ID>.D` under `annotations/words`) contributes its `<w>` elements.
 * Dropped: `punc="true"`, `trunc="true"`, and every element that is not `<w>` (`vocalsound`, `disfmarker`, `gap`, …).
 * Files are ISO-8859-1 unless the XML declaration says UTF-8. Character references are decoded.
 * Order is start time, then speaker letter, then end time. A word that starts exactly at `toSec` is outside the window.
 */
export function reference(meetingId: string, options: ReferenceOptions = {}): ReferenceWord[] {
  if (!/^[A-Za-z0-9]+$/.test(meetingId)) throw new Error(`Bad meeting id: ${meetingId}`);
  const paths = benchPaths(options.root);
  const files = SPEAKERS.map(speaker => ({ speaker, path: paths.wordsFile(meetingId, speaker) })).filter(file => existsSync(file.path));
  if (!files.length) throw new Error(`No word files for ${meetingId} in ${paths.words}.`);
  const words: ReferenceWord[] = [];
  for (const file of files) {
    const xml = decodeXml(readFileSync(file.path));
    for (const word of readWords(xml, file.path)) {
      if (word.punc || word.trunc) continue;
      if (options.fromSec !== undefined && word.start < options.fromSec) continue;
      if (options.toSec !== undefined && word.start >= options.toSec) continue;
      words.push({ text: word.text, start: word.start, end: word.end, speaker: file.speaker });
    }
  }
  words.sort((a, b) => a.start - b.start || a.speaker.localeCompare(b.speaker) || a.end - b.end || a.text.localeCompare(b.text));
  return words;
}

export function referenceText(words: ReferenceWord[]): string {
  return words.map(word => word.text).join(' ');
}

function decodeXml(bytes: Buffer): string {
  const head = bytes.subarray(0, 240).toString('ascii');
  const encoding = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1].toLowerCase();
  if (encoding === 'utf-8' || encoding === 'utf8') return bytes.toString('utf8');
  return bytes.toString('latin1');
}

type RawWord = { text: string; start: number; end: number; punc: boolean; trunc: boolean };

function readWords(xml: string, file: string): RawWord[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const words: RawWord[] = [];
  for (const match of body.matchAll(/<w\b([^>]*)>([\s\S]*?)<\/w>/gi)) {
    const attrs = match[1];
    const punc = attr(attrs, 'punc') === 'true';
    const trunc = attr(attrs, 'trunc') === 'true';
    const text = decodeEntities(match[2]).trim();
    if (punc || trunc) {
      words.push({ text, start: 0, end: 0, punc, trunc });
      continue;
    }
    if (!text) continue;
    const start = Number(attr(attrs, 'starttime'));
    const end = Number(attr(attrs, 'endtime'));
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Word in ${file} has no starttime/endtime.`);
    words.push({ text, start, end, punc, trunc });
  }
  return words;
}

function attr(source: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(source);
  return match?.[1] ?? match?.[2];
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_all, body: string) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _all;
  });
}
