// Fictional model/decoder identities, real process lifecycle; no native model is loaded.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const path = process.argv[2], name = basename(path);
appendFileSync(`${path}.pids`, `${process.pid}\n`);
if (name.includes('broken')) throw new Error('Example invalid weights\nsecond line');
if (!name.includes('never')) setTimeout(() => {
  process.send?.({ kind: 'ready', backend: `fake:${name}` });
  if (name.includes('fragile')) setTimeout(() => process.exit(1), 100);
}, name.includes('slow') ? 1500 : 30);
process.on('message', (message: any) => {
  if (message.kind === 'shutdown') { process.disconnect(); return; }
  if (message.kind === 'transcribe') setTimeout(() => process.send?.({ kind: 'result', id: message.id, result: {
    text: `${name}:${process.env.MEETING_FFMPEG ?? 'ffmpeg'}`, backend: `fake:${name}`, computeMs: 1, decodeMs: 0,
    audioSeconds: message.seconds, processRssBytes: 0, timestampKind: 'none', words: [],
  } }), message.seconds * 1000);
});
process.on('disconnect', () => process.exit(0));
