import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const path = process.argv[2], name = basename(path);
appendFileSync(`${path}.pids`, `${process.pid}\n`);
let current = '', words: string[] = [];
process.send?.({ kind: 'ready', backend: 'fake' });
process.on('message', (message: any) => {
  if (message.kind === 'shutdown') { process.disconnect(); return; }
  if (message.kind === 'begin') { current = message.window; words = []; }
  if (message.kind === 'feed' && message.window === current) {
    words.push(`w${message.pcm[0]}`);
    process.send?.({ kind: 'draft', window: current, text: `${name}:${words.join(' ')}`, tokens: [], committedMs: 0 });
  }
});
process.on('disconnect', () => process.exit(0));
