// AMI IHM planning only: channel identity comes from corpusResources, not speaker letter arithmetic.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attr, benchPaths, decodeXml, reference, referenceText } from './ami.ts';

export function speakerChannels(xml: string, meetingId: string): Map<string, number> {
  const meetings = [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)];
  const meeting = meetings.find(match => attr(match[1], 'observation') === meetingId);
  if (!meeting) throw new Error(`No channel mapping for ${meetingId}.`);
  const channels = new Map<string, number>();
  for (const match of meeting[2].matchAll(/<speaker\b([^>]*)\/?\s*>/g)) {
    const speaker = attr(match[1], 'nxt_agent'), raw = attr(match[1], 'channel');
    if (!speaker || !/^[A-D]$/.test(speaker) || !raw || !/^\d+$/.test(raw)) throw new Error(`Invalid speaker/channel in ${meetingId}.`);
    if (channels.has(speaker) || [...channels.values()].includes(Number(raw))) throw new Error(`Duplicate speaker/channel in ${meetingId}.`);
    channels.set(speaker, Number(raw));
  }
  if (!channels.size) throw new Error(`No speakers for ${meetingId}.`);
  return channels;
}

export type AmiSegment = { id: string; start: number; end: number };
export function readSegments(xml: string): AmiSegment[] {
  return [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<segment\b([^>]*)>/g)].map(match => {
    const id = attr(match[1], 'nite:id'), start = attr(match[1], 'transcriber_start'), end = attr(match[1], 'transcriber_end');
    if (!id || !start?.trim() || !end?.trim() || !Number.isFinite(Number(start)) || !Number.isFinite(Number(end)) || Number(start) < 0 || Number(end) <= Number(start)) throw new Error('Invalid AMI segment id/start/end.');
    return { id, start: Number(start), end: Number(end) };
  });
}

export type IhmClip = AmiSegment & { meetingId: string; speaker: string; mic: `Headset-${number}`; path: string; reference: string };
export function planIhm(meetings: readonly string[], root?: string): IhmClip[] {
  const paths = benchPaths(root), mapping = decodeXml(readFileSync(join(paths.annotations, 'corpusResources', 'meetings.xml')));
  return meetings.flatMap(meetingId => {
    const words = reference(meetingId, { root: paths.root });
    return [...speakerChannels(mapping, meetingId)].sort(([a], [b]) => a.localeCompare(b)).flatMap(([speaker, channel]) => {
      const segments = readSegments(decodeXml(readFileSync(join(paths.annotations, 'segments', `${meetingId}.${speaker}.segments.xml`))));
      if (!segments.length) throw new Error(`No segments for ${meetingId}.${speaker}.`);
      const mic = `Headset-${channel}` as const;
      return segments.map(segment => ({ ...segment, meetingId, speaker, mic, path: paths.wav(meetingId, mic),
        reference: referenceText(words.filter(word => word.speaker === speaker && word.start >= segment.start && word.start < segment.end)) }));
    });
  });
}
