import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Stateless prefix checks: keep a second checkpoint before the recent correction window. */
export class SegmentsTag {
  private nonce = randomBytes(12).toString('base64url');
  private secret = randomBytes(32);
  delta<T>(meetingId: string, segments: T[], have: string | null) {
    const sign = (value: string) => createHmac('sha256', this.secret).update(`${meetingId}/${value}`).digest('base64url').slice(0, 16);
    const match = /^([\w-]{16})\.(0|[1-9]\d*)\.([\w-]{16})\.(0|[1-9]\d*)\.([\w-]{16})\.([\w-]{16})$/.exec(have ?? '');
    const held = match ? Number(match[2]) : -1;
    const checkpoint = match ? Number(match[4]) : -1;
    // A garbled full hash must not accidentally reuse an otherwise valid checkpoint.
    const valid = match?.[0] === have && match?.[1] === this.nonce && Number.isSafeInteger(held) && Number.isSafeInteger(checkpoint) && checkpoint <= held
      && match[6] === sign(have!.slice(0, have!.lastIndexOf('.')));
    const tail = Math.max(0, segments.length - 32);
    const wanted = new Set([tail, segments.length, ...(valid ? [held, checkpoint] : [])]);
    const hashes = new Map<number, string>();
    const hash = createHash('sha256').update(`${this.nonce}/${meetingId}/[`);
    const remember = (n: number) => { if (wanted.has(n)) hashes.set(n, hash.copy().update(']').digest('base64url').slice(0, 16)); };
    remember(0);
    segments.forEach((segment, i) => {
      hash.update((i ? ',' : '') + JSON.stringify(segment));
      remember(i + 1);
    });
    const from = valid && hashes.get(held) === match![3] ? held : valid && hashes.get(checkpoint) === match![5] ? checkpoint : 0;
    const tag = `${this.nonce}.${segments.length}.${hashes.get(segments.length)}.${tail}.${hashes.get(tail)}`;
    return {
      segments: segments.slice(from),
      segmentsFrom: from,
      segmentsTag: `${tag}.${sign(tag)}`,
    };
  }
}
