// Live draft transcription: one streaming session per spool window, in its own process (a stream holds the model's lease).
import { TranscribeModel, setLogHandler, type Session, type Stream } from 'transcribe-cpp';

setLogHandler(() => {});
type Message =
  | { kind: 'begin'; window: string }
  | { kind: 'feed'; window: string; pcm: Float32Array }
  | { kind: 'end'; window: string }
  | { kind: 'shutdown' };

let model: TranscribeModel | undefined;
let session: Session | undefined;
let stream: Stream | undefined;
let current: string | undefined;
// Messages are handled strictly one at a time: a stream must not be read or reset while a feed is in flight.
let queue: Promise<void> = Promise.resolve();

async function close() {
  if (stream) { try { stream.reset(); } catch { /* already failed */ } }
  stream = undefined;
  current = undefined;
}
/** True when a feed was answered with a draft; every other feed gets an ack, so the parent can count unanswered feeds. */
async function handle(message: Message): Promise<boolean> {
  if (message.kind === 'shutdown') {
    await close();
    session?.dispose(); model?.dispose();
    session = undefined; model = undefined;
    await new Promise<void>(resolve => setImmediate(resolve));
    if (process.connected) process.disconnect();
    return false;
  }
  if (!model || !session) return false;
  if (message.kind === 'begin') {
    await close();
    stream = await session.stream({ language: 'en', commitPolicy: 'stable_prefix' });
    current = message.window;
    return false;
  }
  if (message.window !== current || !stream) return false; // A message for a window that was already replaced.
  if (message.kind === 'feed') {
    const update = await stream.feed(message.pcm);
    // Sent after every feed: receivedMs lets the parent measure how far behind the worker is.
    // The snapshot has live token times on this stream's audio clock (words[] is empty for Parakeet).
    const tokens = stream.snapshot.tokens.map(({ text, t0Ms, t1Ms }) => ({ text, t0Ms, t1Ms }));
    process.send?.({ kind: 'draft', window: current, text: `${stream.text.committed} ${stream.text.tentative}`.trim(), tokens, receivedMs: update.inputReceivedMs, committedMs: update.audioCommittedMs });
    return true;
  } else {
    const update = await stream.finalize();
    const tokens = stream.snapshot.tokens.map(({ text, t0Ms, t1Ms }) => ({ text, t0Ms, t1Ms }));
    process.send?.({ kind: 'draft', window: current, text: stream.text.committed.trim(), tokens, receivedMs: update.inputReceivedMs, committedMs: update.audioCommittedMs, final: true });
    await close();
    return false;
  }
}
process.on('message', (message: Message) => {
  queue = queue.then(() => handle(message)).catch(async error => {
    const window = current;
    await close();
    process.send?.({ kind: 'error', window, error: error instanceof Error ? error.message : String(error) });
    return false;
  }).then(answered => { if (message.kind === 'feed' && !answered) process.send?.({ kind: 'ack', window: message.window }); });
});
process.on('disconnect', () => { void close().then(() => { session?.dispose(); model?.dispose(); process.exit(0); }); });
model = await TranscribeModel.load(process.argv[2]);
session = model.createSession();
process.send?.({ kind: 'ready', backend: model.backend });
