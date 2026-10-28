import { open, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHUNK_SECONDS, SAMPLE_RATE } from './audio.ts';
import { importedWindow } from './listen-imports.ts';
import type { MeetingStore } from './store.ts';

type Window = { id: string; source: string; path: string; startMs: number; seconds: number; sampleRate: number | null; decodeStart: number };
const RATE = SAMPLE_RATE, BLOCK = RATE, HEADER = 44;
function header(samples: number) {
  const b = Buffer.alloc(HEADER);
  b.write('RIFF'); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}
function rangeOf(value: string | undefined, length: number) {
  if (!value) return [0, length - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const from = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const to = match[1] && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1;
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from <= to && from < length ? [from, to] : null;
}
async function rawSamples(path: string, from: number, count: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const b = Buffer.alloc(count * 4);
    let read = 0;
    while (read < b.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(b, read, b.length - read, from * 4 + read);
      if (!bytesRead) throw new Error('Audio file is incomplete.');
      read += bytesRead;
    }
    return new Float32Array(b.buffer, b.byteOffset, count);
  } finally { await file.close(); }
}
/** Fixed timeline blocks make odd-byte ranges identical to slices of a full response, including imports. */
async function mix(windows: Window[], store: MeetingStore, first: number, count: number, signal: AbortSignal) {
  const sum = new Float64Array(count), claimed = new Uint8Array(count);
  const overlapping = windows.filter(w => w.startMs * RATE / 1000 < first + count && (w.startMs / 1000 + w.seconds) * RATE > first);
  let source: string | undefined;
  for (const w of overlapping) {
    signal.throwIfAborted();
    if (source !== w.source) { source = w.source; claimed.fill(0); }
    const start = w.startMs * RATE / 1000;
    const lo = Math.max(0, Math.ceil(start - first)), hi = Math.min(count, Math.ceil(start + w.seconds * RATE - first));
    if (lo >= hi || claimed.subarray(lo, hi).every(Boolean)) continue;
    const path = store.resolvePath(w.path);
    let samples: Float32Array, offset = 0;
    if (w.sampleRate) {
      const rate = w.sampleRate;
      offset = Math.max(0, Math.floor((first + lo - start) * rate / RATE));
      const last = Math.min(Math.round(w.seconds * rate), Math.ceil((first + hi - 1 - start) * rate / RATE) + 2);
      samples = await rawSamples(path, offset, last - offset, signal);
    } else {
      samples = await importedWindow(path, w.decodeStart, w.seconds, signal);
    }
    signal.throwIfAborted();
    for (let i = lo; i < hi; i++) {
      if (claimed[i]) continue;
      const at = w.sampleRate ? (first + i - start) * w.sampleRate / RATE - offset : first + i - start;
      const a = Math.floor(at), fraction = at - a;
      const value = (samples[a] ?? 0) * (1 - fraction) + (samples[Math.min(a + 1, samples.length - 1)] ?? 0) * fraction;
      sum[i] += Number.isFinite(value) ? value : 0; claimed[i] = 1;
    }
  }
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sum[i])) * 32767), i * 2);
  return out;
}

/** No playback lease: retention may remove audio while this response is in flight. */
export async function serveMeetingAudio(req: IncomingMessage, res: ServerResponse, store: MeetingStore, id: string, metadata: boolean, recording: boolean) {
  const abort = new AbortController();
  const close = () => abort.abort(); res.once('close', close); req.once('aborted', close);
  const check = () => { if (res.destroyed || res.closed || req.aborted) close(); abort.signal.throwIfAborted(); };
  const reply = (status: number, data: unknown) => { check(); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const gone = () => reply(410, { code: 'audio_gone', after: store.meeting(id).audioRemovedAfter ?? null });
  let relevant: Window[] = [];
  const preflight = async () => {
    for (const path of new Set(relevant.map(w => w.path))) { check(); await stat(store.resolvePath(path)); }
    check();
  };
  const write = async (bytes: Buffer) => {
    check();
    if (res.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { res.off('drain', drain); res.off('close', closed); res.off('error', failed); };
      const drain = () => { done(); resolve(); }, failed = (error: Error) => { done(); reject(error); };
      const closed = () => failed(new Error('Player closed.'));
      res.once('drain', drain); res.once('close', closed); res.once('error', failed);
      // close/drain may have happened inside write(), before these listeners were attached.
      if (res.destroyed || res.closed || abort.signal.aborted) closed();
      else if (!res.writableNeedDrain) drain();
    });
  };
  try {
    check();
    const meeting = store.meeting(id);
    if (recording) { reply(409, { code: 'audio_recording' }); return; }
    if (meeting.audioRemovedAt !== null) { gone(); return; }
    const windows: Window[] = [...store.chunks(id), ...store.heldFrames(id).map(f => ({ ...f, seconds: f.samples / RATE, sampleRate: RATE, decodeStart: 0 }))]
      .filter(w => Boolean(w.path)).flatMap(w => {
        // Imports are normally 20 s; split any longer legacy window to the same memory bound.
        if (w.sampleRate || w.seconds <= CHUNK_SECONDS) return [w];
        return Array.from({ length: Math.ceil(w.seconds / CHUNK_SECONDS) }, (_, i) => ({ ...w,
          startMs: w.startMs + i * CHUNK_SECONDS * 1000, decodeStart: w.decodeStart + i * CHUNK_SECONDS, seconds: Math.min(CHUNK_SECONDS, w.seconds - i * CHUNK_SECONDS) }));
      }).sort((a, b) => a.source.localeCompare(b.source) || a.startMs - b.startMs || a.id.localeCompare(b.id));
    if (meeting.audioEmpty || !windows.length) { reply(404, { code: 'audio_empty' }); return; }
    const samples = Math.ceil(store.audioEndMs(id) * RATE / 1000), length = HEADER + samples * 2;
    const range = rangeOf(req.headers.range, length);
    if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${length}`, 'Cache-Control': 'no-store' }); res.end(); return; }
    const [from, to] = range;
    // Only touch requested windows; metadata probes establish availability before assigning audio.src.
    relevant = metadata ? windows : windows.filter(w => HEADER + (w.startMs / 1000 + w.seconds) * RATE * 2 > from && HEADER + w.startMs * RATE / 1000 * 2 <= to);
    try { await preflight(); } catch { check(); gone(); return; }
    if (metadata) { reply(200, { seconds: samples / RATE }); return; }
    // Decode the first block before sending headers, so a deletion race can still return 410.
    check();
    const first = Math.floor(Math.max(0, from - HEADER) / 2 / BLOCK) * BLOCK;
    let block = to >= HEADER ? await mix(windows, store, first, Math.min(BLOCK, samples - first), abort.signal) : null;
    check();
    res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Content-Length': to - from + 1,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(req.headers.range ? { 'Content-Range': `bytes ${from}-${to}/${length}` } : {}) });
    if (from < HEADER) await write(header(samples).subarray(from, Math.min(HEADER, to + 1)));
    for (let at = first; block && HEADER + at * 2 <= to; at += BLOCK) {
      check();
      if (at !== first) block = await mix(windows, store, at, Math.min(BLOCK, samples - at), abort.signal);
      const offset = HEADER + at * 2;
      await write(block.subarray(Math.max(0, from - offset), Math.min(block.length, to + 1 - offset)));
    }
    check(); res.end();
  } catch {
    if (res.headersSent) res.destroy();
    else if (!abort.signal.aborted && !res.destroyed && !res.closed) {
      let removed = store.meeting(id).audioRemovedAt !== null;
      try { await preflight(); } catch { removed = true; }
      if (!abort.signal.aborted && !res.destroyed && !res.closed) {
        if (removed) gone(); else reply(422, { code: 'audio_unreadable' });
      }
    }
  } finally { res.off('close', close); req.off('aborted', close); }
}
