import type { Chunk, Segment } from './store.ts';
import type { Speakers } from './speakers.ts';
import { echoWords } from './echo-words.ts';

export const FINAL_HOLD_MS = 8000;
const EDGE_MS = 3000;

/** Display-only delay: settled readers never use this. Publication is the existing chunk completedAt timestamp. */
export function heldMicrophoneFinals(segments: Segment[], chunks: Chunk[],
  callSources: string[], speakers: Speakers, now: number): Set<string> {
  const held = new Set<string>();
  if (!callSources.length) return held;
  const completedAt = new Map(chunks.map(c => [c.id, c.completedAt]));
  const frontiers = callSources.map(source => {
    const own = chunks.filter(c => c.source === source).sort((a, b) => a.startMs - b.startMs);
    let end = own[0]?.startMs ?? -Infinity;
    for (const chunk of own) {
      // Never skip an unrecognized block or a gap just because a later block completed.
      if (chunk.status !== 'completed' || chunk.startMs > end + 1) break;
      end = Math.max(end, chunk.startMs + chunk.seconds * 1000);
    }
    return { start: own[0]?.startMs ?? -Infinity, end };
  });
  const short: Segment[] = [];
  for (const segment of segments) {
    if (speakers.roleOf(segment.source, segment.startMs, segment.endMs) !== 'me') continue;
    const published = completedAt.get(segment.chunkId);
    if (published == null || now - published >= FINAL_HOLD_MS) continue;
    if (frontiers.some(f => f.start <= segment.endMs + EDGE_MS && f.end < segment.endMs + EDGE_MS)) held.add(segment.id);
    else if ([1, 2].includes(echoWords(segment.text).length)) short.push(segment);
  }
  // A 1–2 word line can be hidden as the echo tail or head of its neighbour (speakers.ts), so it waits until that neighbour is decided.
  const heldOrds = new Set(segments.filter(s => held.has(s.id)).map(s => `${s.chunkId}\n${s.ord}`));
  for (const segment of short) {
    if (heldOrds.has(`${segment.chunkId}\n${segment.ord - 1}`) || heldOrds.has(`${segment.chunkId}\n${segment.ord + 1}`)) held.add(segment.id);
  }
  return held;
}
