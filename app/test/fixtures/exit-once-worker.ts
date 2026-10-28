import { existsSync, writeFileSync } from 'node:fs';
const marker = process.argv[2];
process.send?.({ kind: 'ready', backend: 'fake' });
process.on('message', (message: any) => {
  if (message.kind === 'shutdown') process.exit(0);
  if (message.kind !== 'transcribe') return;
  if (!existsSync(marker)) { writeFileSync(marker, 'crashed'); process.exit(17); }
  process.send?.({ kind: 'result', id: message.id, result: { text: 'The worker recovered.', backend: 'fake', computeMs: 1,
    decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', words: [] } });
});
