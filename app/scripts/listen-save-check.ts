// V4-style save round trips in a separate server process, with a two-hour fictional mixed stream.
import './check-isolation.ts';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

if (process.argv[2] === '--server') {
  const directory = await mkdtemp(join(tmpdir(), 'listen-save-server-'));
  const app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory, true), recognizer: { async transcribe() { return { text: '', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 20, processRssBytes: 0, timestampKind: 'none' as const }; }, close() {} }, drafts: null, quick: null, heavy: null, board: null });
  const m = app.store.createMeeting('Two hours of fictional tones');
  const c = await app.store.addPcm(m.id, 'mic:fixture', 0, 0, 16000, Buffer.from(new Float32Array(20 * 16000).fill(.125).buffer));
  app.store.setStatus(c.id, 'completed');
  const insert = app.store.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
    SELECT ?,meetingId,?,?,path,0,?,seconds,sampleRate,'completed',hash FROM chunks WHERE id=?`);
  for (const source of ['mic:fixture', 'tab:fixture']) for (let i = source === 'mic:fixture' ? 1 : 0; i < 360; i++) insert.run(randomUUID(), source, i, i * 20000, c.id);
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const handleMessage = async (message: string) => {
    if (message === 'report') process.send?.({ type: 'report', frames: app.store.db.prepare('SELECT COUNT(*) AS n FROM frames').get(), eventLoopMs: { mean: loop.mean / 1e6, max: loop.max / 1e6, p99: loop.percentile(99) / 1e6 } });
    if (message === 'close') { loop.disable(); await app.close(); await rm(directory, { recursive: true, force: true }); process.disconnect?.(); }
  };
  process.on('message', (message: string) => {
    // IPC cannot wait for close; the child exits unsuccessfully if cleanup fails.
    handleMessage(message).catch(error => { console.error(error); process.exit(1); });
  });
  process.send?.({ type: 'ready', url: app.url, meetingId: m.id });
} else {
  const out = resolve(process.argv[2] ?? 'artifacts/listen-save'); await mkdir(out, { recursive: true });
  const trials: unknown[] = [];
  const stats = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return { n: v.length, min: v[0], median: v[Math.floor(v.length / 2)], p95: v[Math.floor(v.length * .95)], max: v.at(-1) }; };
  for (let repeat = 1; repeat <= 2; repeat++) for (const streaming of repeat === 1 ? [false, true] : [true, false]) {
    const child = fork(fileURLToPath(import.meta.url), ['--server'], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const message = (type: string) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`IPC timeout ${type}`)); }, 20000);
      const receive = (m: any) => { if (m.type === type) { clearTimeout(timer); child.off('message', receive); resolve(m); } }; child.on('message', receive);
    });
    const abort = new AbortController(); let stream: Promise<void> | undefined;
    try {
      const ready = await message('ready'); const root = await fetch(ready.url, { redirect: 'manual' });
      const headers = { Cookie: root.headers.get('set-cookie')!.split(';')[0], Origin: ready.url };
      const base = `${ready.url}/api/meetings/${ready.meetingId}`;
      await (await fetch(base + '/segments', { headers })).arrayBuffer();
      let streamBytes = 0, seekMs: number | null = null;
      if (streaming) {
        const at = 44 + 7190 * 32000, begun = performance.now();
        const seek = await fetch(base + '/audio', { headers: { ...headers, Range: `bytes=${at}-${at + 127}` } });
        assert.equal(seek.status, 206); assert.equal((await seek.arrayBuffer()).byteLength, 128); seekMs = performance.now() - begun;
        const response = await fetch(base + '/audio', { headers, signal: abort.signal }); assert.equal(response.status, 200);
        stream = (async () => { const reader = response.body!.getReader(); try { while (!abort.signal.aborted) { const part = await reader.read(); if (part.done) throw new Error('Stream unexpectedly ended'); streamBytes += part.value.byteLength; await delay(250, undefined, { signal: abort.signal }); } } catch (error) { if (!abort.signal.aborted) throw error; } finally { await reader.cancel().catch(() => {}); } })();
        void stream.catch(() => {});
      }
      const pcmMs: number[] = [], segmentMs: number[] = [], errors: unknown[] = [];
      const begin = performance.now();
      const tick = (i: number) => delay(Math.max(0, begin + i * 1000 - performance.now()));
      await Promise.all([
        ...['mic:', 'tab:'].map(prefix => (async () => {
          const source = prefix + randomUUID();
          for (let i = 0; i < 60; i++) {
            await tick(i); const started = performance.now();
            const r = await fetch(base + '/pcm', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source, 'X-Sequence': String(i), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(7200000 + i * 1000) }, body: Buffer.alloc(64000), signal: AbortSignal.timeout(10000) });
            const text = await r.text(); pcmMs.push(performance.now() - started); assert.equal(r.status, 201, text);
          }
          const r = await fetch(base + '/pcm/end', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ source, lastSequence: 59 }) }); await r.text(); assert.equal(r.status, 200);
        })()),
        (async () => { for (let i = 0; i < 60; i++) { await tick(i); const started = performance.now(); const r = await fetch(base + '/segments', { headers }); await r.arrayBuffer(); segmentMs.push(performance.now() - started); if (!r.ok) errors.push({ status: r.status }); } })(),
      ]);
      const pending = message('report'); child.send('report'); const report = await pending;
      assert.equal(report.frames.n, 120); assert.deepEqual(errors, []); if (streaming) assert.ok(streamBytes > 64000);
      const result = { repeat, streaming, pcmMs: stats(pcmMs), segmentsMs: stats(segmentMs), streamBytes, seekMs, ...report, errors, raw: { pcmMs, segmentMs } };
      trials.push(result); await writeFile(join(out, 'results.json'), JSON.stringify(trials, null, 2)); console.log(JSON.stringify({ ...result, raw: undefined }));
    } finally {
      abort.abort(); await stream;
      child.send('close'); await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 10000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }
}
