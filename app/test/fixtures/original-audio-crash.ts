// Disposable, synthetic store only. Exit without unwinding at each seal durability boundary.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { MeetingStore } from '../../src/store.ts';

const [directory, meetingId, stage] = process.argv.slice(2);
const store = new MeetingStore(directory);
const originalOpen = fs.open;
fs.open = (async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args), path = String(args[0]);
  if (args[1] === 'wx' && path.endsWith('.f32')) {
    const raw = path.endsWith('.raw.f32');
    if (stage === 'raw-open' && raw) process.exit(86);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      if (stage === (raw ? 'raw-sync' : 'primary-sync')) process.exit(86);
    };
  }
  return handle;
}) as typeof originalOpen;
if (stage === 'after-commit') fs.rm = (async () => { process.exit(86); }) as typeof fs.rm;
syncBuiltinESMExports();
if (stage === 'in-transaction') {
  store.db.function('fictional_crash', () => { process.exit(86); });
  store.db.exec('CREATE TEMP TRIGGER crash_seal AFTER INSERT ON chunk_originals BEGIN SELECT fictional_crash(); END');
}
await store.sealWindow(meetingId, store.heldFrames(meetingId), Buffer.from(new Float32Array(16000).fill(0.2).buffer));
throw new Error('The requested crash boundary was not reached.');
