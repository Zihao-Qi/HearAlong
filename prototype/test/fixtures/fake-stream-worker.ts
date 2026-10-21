// Test-only stand-in for the streaming draft worker: echoes fed audio as words, never loads a model.
// A frame whose first sample is 9 hangs the worker (like a stuck native call, nothing after it is answered); 7 exits.
// FAKE_NEVER_READY=1: the model never finishes loading.
let window: string | undefined;
let words: string[] = [];
let receivedMs = 0;
let hung = false;
process.on('message', (message: any) => {
  if (message.kind === 'shutdown') { process.disconnect(); return; }
  if (hung) return;
  if (message.kind === 'begin') { window = message.window; words = []; receivedMs = 0; return; }
  if (message.kind !== 'feed') return;
  if (message.window !== window) { process.send?.({ kind: 'ack', window: message.window }); return; }
  const first = message.pcm[0];
  if (first === 9) { hung = true; return; }
  if (first === 7) process.exit(1);
  receivedMs += message.pcm.length / 16;
  words.push(`w${first}`);
  const tokens = words.map((text, i) => ({ text: ` ${text}`, t0Ms: i * 1000, t1Ms: (i + 1) * 1000 }));
  process.send?.({ kind: 'draft', window, text: words.join(' '), tokens, receivedMs, committedMs: receivedMs });
});
if (process.env.FAKE_NEVER_READY !== '1') process.send?.({ kind: 'ready', backend: 'fake' });
