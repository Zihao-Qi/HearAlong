import { readFile } from 'node:fs/promises';
import { FRAME_RATE, type Frame, type MeetingStore } from './store.ts';
import type { LiveDrafts } from './drafts.ts';
import type { CaptureTiming } from './capture-gaps.ts';
import { CaptureConflict } from './capture-error.ts';

/** A window is sealed once this much is held, cut at the quietest frame boundary between MIN and MAX. */
export const WINDOW_MIN_SECONDS = 16;
export const WINDOW_MAX_SECONDS = 24;
/** A source with held frames and no new frame for this long is sealed (tab closed, network gone, server restarted). */
export const IDLE_SEAL_MS = 10_000;
/** After a restart only: allow an existing page to reconnect before declaring its recording abandoned. */
export const RECORDING_RECONNECT_MS = 60_000;

/** A source is quiet after this long without a frame above its level (M7 problem notices). */
export const QUIET_MS = 60_000;
/** A source sends a frame every second; none for this long means its audio is waiting in the page (or the page has stalled). */
export const LATE_MS = 5000;
/** The meeting tab carries digital silence when nothing plays; a working microphone is never this low, even in a quiet room. */
const SOUND_LEVEL = { tab: 0.001, mic: 0.000316 }; // −60 and −70 dBFS
const rms = (pcm: Float32Array) => Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / Math.max(1, pcm.length));
const asFloats = (buffer: Buffer) => new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

/**
 * Where to end the next window: the index of the first frame NOT in it. Boundaries between MIN and MAX seconds are scored by
 * the loudness of the 100 ms on each side; the quietest wins (the later one on ties). `loudness[i]` is the boundary before frame i.
 */
export function chooseCut(frames: Pick<Frame, 'samples'>[], loudness: (index: number) => number): number {
  let elapsed = 0, best = -1, bestLoudness = Infinity;
  for (let i = 1; i <= frames.length; i++) {
    elapsed += frames[i - 1].samples / FRAME_RATE;
    if (elapsed < WINDOW_MIN_SECONDS) continue;
    if (elapsed > WINDOW_MAX_SECONDS + 1e-9) break;
    if (i === frames.length) { if (best < 0) best = i; break; } // The last boundary has no audio after it yet; used only as a fallback.
    const value = loudness(i);
    if (value <= bestLoudness) { bestLoudness = value; best = i; }
  }
  return best < 0 ? frames.length : best;
}

type SourceState = { meetingId: string; chain: Promise<unknown>; busy: number; lastFrameAt: number; window: string | null; ended: boolean; firstFrameAt: number | null; lastSoundAt: number | null;
  /** Meeting time at the end of the newest frame saved (the recording's clock). */
  endMs: number };

/**
 * Owns live capture per source: admits frames in order, seals 16–24 s windows into chunks for the batch recognizer, and feeds
 * best-effort drafts. Every operation on a source runs on that source's chain, so admission, sealing, end and idle checks
 * never interleave.
 */
export class LiveCapture {
  private sources = new Map<string, SourceState>();
  private closed = false;
  private closing = false; // no new frames once a close has begun; the final seals still run
  private sweeping: Promise<void> | null = null;
  private store: MeetingStore;
  private reconnectUntil: number;
  private options: { drafts?: LiveDrafts | null; clock?: () => number; onChunk?: (meetingId: string) => void; log?: (message: string) => void };
  constructor(store: MeetingStore, options: LiveCapture['options'] = {}) {
    this.store = store; this.options = options;
    this.store.recoverRecordings();
    this.reconnectUntil = this.clock() + RECORDING_RECONNECT_MS;
  }
  private clock() { return this.options.clock?.() ?? Date.now(); }
  private state(meetingId: string, source: string): SourceState {
    let state = this.sources.get(source);
    if (!state) { state = { meetingId, chain: Promise.resolve(), busy: 0, lastFrameAt: this.clock(), window: null, ended: false, firstFrameAt: null, lastSoundAt: null, endMs: 0 }; this.sources.set(source, state); }
    if (state.meetingId !== meetingId) throw new CaptureConflict('This audio source belongs to another meeting.');
    return state;
  }
  private run<T>(state: SourceState, work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Live capture has stopped.'));
    state.busy++;
    const next = state.chain.then(work, work).finally(() => { state.busy--; });
    state.chain = next.catch(() => {});
    return next;
  }
  /** Deleted meetings must not remain candidates for the global live/recording readers. Never detach queued work. */
  pruneMeetings(existing: ReadonlySet<string>) {
    for (const [source, state] of this.sources) if (!existing.has(state.meetingId) && !state.busy) this.sources.delete(source);
  }
  /**
   * True while any meeting has a source that is recording and not yet ended by its page. A frame within the last minute counts,
   * not only the last 15 s: uploads may be held up while the page still has audio queued, and a quit must wait for its end.
   */
  recording(): boolean {
    const now = this.clock();
    return [...this.sources.values()].some(s => !s.ended && s.firstFrameAt !== null && now - s.lastFrameAt <= 60_000);
  }
  /** Includes admission/sealing in progress, before a frame has reached disk. */
  active(meetingId: string): boolean {
    return this.store.recordingUnended(meetingId) || [...this.sources.values()].some(s => s.meetingId === meetingId && s.busy > 0);
  }
  /**
   * Stops admission, waits for every source's queued work, then seals what each source still holds (before the store is closed),
   * so a quit leaves saved audio in windows for the recognizer rather than for the next start's sweep.
   */
  async close() {
    this.closing = true;
    await this.sweeping;
    await Promise.allSettled([...this.sources.values()].map(s => s.chain));
    for (const { meetingId, source } of this.store.heldSources()) {
      let state: SourceState;
      try { state = this.state(meetingId, source); } catch { continue; }
      await this.run(state, () => this.sealIfDue(state, source, true)).catch(error => this.options.log?.(`Sealing held audio at close failed: ${(error as Error).message}`));
    }
    for (const s of this.sources.values()) s.ended = true;
    this.closed = true;
    await Promise.allSettled([...this.sources.values()].map(s => s.chain));
  }

  /** Saves a frame (before it is acknowledged), feeds its draft, and seals a window when enough is held. */
  accept(meetingId: string, source: string, sequence: number, startMs: number, pcm: Buffer, pageId?: string | null, timing?: CaptureTiming): Promise<Frame> {
    // Admission is decided when the frame arrives: a frame queued before a close began is saved and sealed by it, not refused.
    if (this.closing) return Promise.reject(new Error('Live capture has stopped.'));
    const state = this.state(meetingId, source);
    return this.run(state, async () => {
      if (state.ended) throw new CaptureConflict('This audio source has ended; start a new recording.');
      const { frame, added } = await this.store.addFrame(meetingId, source, sequence, startMs, pcm, timing);
      // Reclaim only accepted audio: a rejected sequence/body must not reopen a source or reset retention.
      if (pageId !== undefined) this.store.claimRecording(meetingId, source, pageId);
      state.lastFrameAt = this.clock();
      state.firstFrameAt ??= state.lastFrameAt;
      state.endMs = Math.max(state.endMs, frame.startMs + frame.samples * 1000 / FRAME_RATE);
      if (rms(asFloats(pcm)) >= (source.startsWith('tab:') ? SOUND_LEVEL.tab : SOUND_LEVEL.mic)) state.lastSoundAt = state.lastFrameAt;
      const drafts = this.options.drafts;
      // A repeated frame (lost reply, retry) was already fed: feeding it again would repeat its words in the draft.
      if (drafts && added) {
        if (!state.window) state.window = drafts.begin(meetingId, source, `${source}:${frame.sequence}`, frame.startMs) ? `${source}:${frame.sequence}` : null;
        if (state.window) drafts.feed(state.window, asFloats(pcm));
      }
      // Saving is the acknowledgement boundary. A failed seal leaves durable held frames for the next frame/sweep.
      await this.sealIfDue(state, source, false).catch(error => this.options.log?.(`Sealing saved audio failed: ${(error as Error).message}`));
      return frame;
    });
  }
  /** The browser stopped capture after `lastSequence`: everything held is sealed, and later frames are refused. Idempotent. */
  end(meetingId: string, source: string, lastSequence: number | null): Promise<{ sealed: number }> {
    const state = this.state(meetingId, source);
    return this.run(state, async () => {
      const saved = this.store.lastFrameSequence(meetingId, source);
      if (lastSequence !== null && (saved ?? -1) < lastSequence) throw new CaptureConflict(`Frames up to ${lastSequence} have not all arrived.`);
      state.ended = true;
      // Recognizers release at Stop; sealed display previews remain until their chunks complete.
      try {
        const sealed = await this.sealIfDue(state, source, true);
        this.store.finishRecordingSource(meetingId, source, 'ended', this.clock());
        return { sealed };
      }
      finally { this.options.drafts?.release(source); }
    });
  }
  /** Goodbye is explicit, not inferred from a missing heartbeat or a sleeping laptop. */
  async abandonPage(pageId: string) {
    for (const session of this.store.openRecordings().filter(s => s.pageId === pageId)) {
      await this.abandon(session.meetingId, session.source, false);
    }
  }
  private abandon(meetingId: string, source: string, recoveringOnly: boolean) {
    const state = this.state(meetingId, source);
    return this.run(state, async () => {
      const eligible = () => this.store.openRecordings().some(s => s.meetingId === meetingId && s.source === source && (!recoveringOnly || s.state === 'recovering'));
      if (!eligible()) return;
      await this.sealIfDue(state, source, true);
      // A reconnect can arrive during sealing. It wins over startup abandonment.
      if (!eligible()) return;
      // Unlike an explicit source end, abandonment can be resumed by a delayed frame/reconnect.
      this.options.drafts?.release(source);
      this.store.finishRecordingSource(meetingId, source, 'abandoned', this.clock());
    });
  }
  /** Seals sources that went quiet; also recovers frames left from before a restart. Call periodically; overlapping calls share one pass. */
  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.sweeping ??= this.sweepOnce().catch(error => this.options.log?.(`Sweep failed: ${(error as Error).message}`)).finally(() => { this.sweeping = null; });
    return this.sweeping;
  }
  private async sweepOnce() {
    for (const { meetingId, source } of this.store.heldSources()) {
      let state: SourceState;
      try { state = this.state(meetingId, source); } catch { continue; }
      await this.run(state, async () => {
        if (this.clock() - state.lastFrameAt < IDLE_SEAL_MS) return;
        await this.sealIfDue(state, source, true);
      }).catch(error => this.options.log?.(`Sealing held audio failed: ${(error as Error).message}`));
    }
    if (this.clock() >= this.reconnectUntil) {
      for (const session of this.store.openRecordings().filter(s => s.state === 'recovering')) {
        await this.abandon(session.meetingId, session.source, true);
      }
    }
    // Forget sources that are finished and fully sealed.
    for (const [source, state] of this.sources) {
      // Never while work is queued or running on it: a later request would get a second owner.
      if (!state.busy && this.clock() - state.lastFrameAt > 10 * 60_000 && !this.store.heldFrames(state.meetingId, source).length) this.sources.delete(source);
    }
  }
  /**
   * The meeting's sources that are recording now (a frame within 15 s, not ended), each with whether it has been quiet for
   * QUIET_MS: no frame above its sound level in that time. Computed from what was saved, so it holds while the browser draws nothing.
   */
  liveSources(meetingId: string): { source: string; quiet: boolean; late: boolean }[] {
    const now = this.clock();
    return [...this.sources].filter(([, s]) => s.meetingId === meetingId && !s.ended && s.firstFrameAt !== null && now - s.lastFrameAt <= 15_000)
      .map(([source, s]) => ({ source, quiet: now - (s.lastSoundAt ?? s.firstFrameAt!) >= QUIET_MS, late: now - s.lastFrameAt >= LATE_MS }));
  }
  /**
   * The meeting being recorded now (the newest, if two pages record): its sources not ended with a frame within the last minute
   * (a stalled upload keeps its recording, shown as late), and its clock, the newest frame's end plus the time since it arrived.
   * Null when nothing records.
   */
  recordingNow(eligible: (source: string) => boolean = () => true): { meetingId: string; sources: { source: string; quiet: boolean; late: boolean }[]; clockMs: number } | null {
    const now = this.clock();
    const recording = (s: SourceState) => !s.ended && s.firstFrameAt !== null && now - s.lastFrameAt <= 60_000;
    let newest: SourceState | undefined;
    for (const [source, s] of this.sources) if (eligible(source) && recording(s) && (!newest || s.lastFrameAt > newest.lastFrameAt)) newest = s;
    if (!newest) return null;
    const meetingId = newest.meetingId;
    const live = [...this.sources].filter(([source, s]) => s.meetingId === meetingId && eligible(source) && recording(s));
    return {
      meetingId,
      sources: live.map(([source, s]) => ({ source, quiet: now - (s.lastSoundAt ?? s.firstFrameAt!) >= QUIET_MS, late: now - s.lastFrameAt >= LATE_MS })),
      clockMs: Math.max(...live.map(([, s]) => s.endMs + now - s.lastFrameAt)),
    };
  }
  /** Seconds of audio saved but not yet in a window, per meeting (coverage and end detection). */
  heldSeconds(meetingId: string): number {
    return this.store.heldFrames(meetingId).reduce((sum, f) => sum + f.samples / FRAME_RATE, 0);
  }

  private async sealIfDue(state: SourceState, source: string, force: boolean): Promise<number> {
    let sealed = 0;
    for (;;) {
      const held = this.store.heldFrames(state.meetingId, source);
      if (!held.length) break;
      const seconds = held.reduce((sum, f) => sum + f.samples / FRAME_RATE, 0);
      if (!force && seconds < WINDOW_MAX_SECONDS) break;
      // A forced seal (end, idle) takes everything once it fits in one window; otherwise cut at a pause.
      const cut = force && seconds <= WINDOW_MAX_SECONDS ? held.length : chooseCut(held, await this.loudness(held));
      const chunk = await this.store.sealWindow(state.meetingId, held.slice(0, cut));
      if (state.window) this.options.drafts?.seal(state.window, chunk);
      sealed++;
      this.options.onChunk?.(state.meetingId);
      await this.restartDraft(state, source, held.slice(cut));
    }
    return sealed;
  }
  /** The preview was frozen against its chunk; a new recognizer replays the frames after the cut. */
  private async restartDraft(state: SourceState, source: string, rest: Frame[]) {
    const drafts = this.options.drafts;
    if (!drafts) return;
    state.window = null;
    if (!rest.length || state.ended) return;
    const window = `${source}:${rest[0].sequence}`;
    if (!drafts.begin(state.meetingId, source, window, rest[0].startMs)) return;
    state.window = window;
    // On the source's chain, so these are fed before any newer frame. A missing file only costs the draft.
    const parts = await Promise.all(rest.map(f => readFile(this.store.resolvePath(f.path)))).catch(() => null);
    if (!parts) { drafts.drop(window); state.window = null; return; }
    for (const part of parts) drafts.feed(window, asFloats(part));
  }
  private async loudness(frames: Frame[]): Promise<(index: number) => number> {
    if (frames.some(f => this.store.meeting(f.meetingId).audioRemovedAt !== null)) return () => 0;
    const pcm = await Promise.all(frames.map(f => readFile(this.store.resolvePath(f.path)).then(asFloats)));
    const edge = FRAME_RATE / 10;
    return index => rms(pcm[index - 1].subarray(Math.max(0, pcm[index - 1].length - edge))) + rms(pcm[index].subarray(0, edge));
  }
}
