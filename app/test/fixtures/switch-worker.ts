// Fictional model/decoder identities, real process lifecycle; no native model is loaded.
import { appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
const path = process.argv[2], name = basename(path);
appendFileSync(`${path}.pids`, `${process.pid}\n`);
if (name.includes('broken')) throw new Error('Example invalid weights\nsecond line');
if (!name.includes('never')) setTimeout(() => {
  process.send?.({ kind: 'ready', backend: `fake:${name}` });
  if (name.includes('fragile')) setInterval(() => { if (existsSync(`${path}.exit`)) process.exit(1); }, 10);
}, name.includes('slow') ? 1500 : 30);
process.on('message', (message: any) => {
  if (message.kind === 'shutdown') { process.disconnect(); return; }
  if (message.kind === 'transcribe') {
    const respond = () => process.send?.({ kind: 'result', id: message.id, result: {
      text: `${name}:${process.env.MEETING_FFMPEG ?? 'ffmpeg'}`, backend: `fake:${name}`, computeMs: 1, decodeMs: 0,
      audioSeconds: message.seconds, processRssBytes: 0, timestampKind: 'none', words: [],
    } });
    if (message.path.endsWith('.gate')) {
      const timer = setInterval(() => { if (existsSync(message.path)) { clearInterval(timer); respond(); } }, 10);
    } else setTimeout(respond, message.seconds * 1000);
  }
});
process.on('disconnect', () => process.exit(0));
