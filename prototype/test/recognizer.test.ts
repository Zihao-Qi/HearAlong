import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalRecognizer } from '../src/recognizer.ts';
import type { Chunk } from '../src/store.ts';

function job(seconds: number): Chunk {
  return { id: randomUUID(), meetingId: 'test', source: 'test', sequence: 0, path: '/unused', decodeStart: 0, startMs: 0,
    seconds, sampleRate: null, status: 'queued', text: '', error: null, metrics: null, hash: 'test' };
}

test('a crashed STT subprocess fails its job without killing the host; the next job can recover', async () => {
  const recognizer = new LocalRecognizer('/unused', new URL('./fixtures/stt-child.ts', import.meta.url));
  try {
    const pending = recognizer.transcribe(job(1));
    const failed = assert.rejects(pending, /STT process exited/);
    recognizer.worker!.kill('SIGKILL');
    await failed;
    const recovered = await recognizer.transcribe(job(2));
    assert.equal(recovered.text, 'Recovered worker');
    await recognizer.close();
    assert.equal(recognizer.lastExit?.code, 0);
    await assert.rejects(recognizer.transcribe(job(2)), /stopped/);
  } finally { await recognizer.close(); }
});
