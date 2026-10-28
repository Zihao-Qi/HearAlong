// End-to-end M1 check through the real server: upload → replay → poll snapshots like the UI does.
// Usage: node --experimental-strip-types scripts/replay-check.ts <media> [speed] [glossary.json]
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';

const [media, speedArg = '16', glossaryPath] = process.argv.slice(2);
if (!media) throw new Error('Usage: replay-check.ts <media> [speed] [glossary.json]');
const directory = await mkdtemp(join(tmpdir(), 'meeting-replay-check-'));
const app = await startServer({ directory, port: 0 });
try {
  const page = await fetch(app.url);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const call = (path: string, init: RequestInit = {}) => fetch(`${app.url}${path}`, { ...init, headers: { Cookie: cookie, Origin: app.url, ...init.headers } })
    .then(async r => { const body = await r.json(); if (!r.ok) throw new Error(`${path}: ${body.error}`); return body; });
  const meeting = await call('/api/meetings', { method: 'POST', body: JSON.stringify({ title: 'Replay check' }), headers: { 'Content-Type': 'application/json' } });
  const base = `/api/meetings/${meeting.id}`;
  if (glossaryPath) await call(`${base}/glossary`, { method: 'PUT', body: await readFile(resolve(glossaryPath), 'utf8'), headers: { 'Content-Type': 'application/json' } });
  await call(`${base}/upload`, { method: 'POST', body: await readFile(resolve(media)) });
  await call(`${base}/replay`, { method: 'POST', body: JSON.stringify({ speed: Number(speedArg) }), headers: { 'Content-Type': 'application/json' } });

  const seen = new Map<string, { startMs: number; revision: number }>();
  let polls = 0, maxLagMs = 0, lastCount = 0, doneAt = 0;
  const started = Date.now();
  for (;;) {
    const snap = await call(`${base}/segments`);
    polls++;
    const ids = snap.segments.map((s: any) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate segment IDs in a snapshot');
    for (const id of seen.keys()) assert.ok(ids.includes(id), `segment ${id} never disappears once shown`);
    for (const s of snap.segments) {
      const prior = seen.get(s.id);
      if (prior) { assert.equal(prior.startMs, s.startMs, 'segment times are frozen'); assert.ok(s.revision >= prior.revision, 'revisions only move forward'); }
      seen.set(s.id, { startMs: s.startMs, revision: s.revision });
      maxLagMs = Math.max(maxLagMs, (snap.replay.positionMs + snap.replay.baseMs) - s.endMs < 0 ? 1 : 0);
    }
    const sorted = [...snap.segments].map((s: any) => s.startMs);
    assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b), 'snapshot is in time order');
    if (snap.segments.length !== lastCount) lastCount = snap.segments.length;
    const finished = snap.replay.positionMs >= snap.replay.durationMs && app.store.queuedCount() === 0;
    if (finished && !doneAt) doneAt = Date.now();
    if (doneAt && Date.now() - doneAt > Number(process.env.SETTLE_MS ?? 45_000)) {
      const final = snap;
      const report = {
        speed: Number(speedArg), wallSeconds: (Date.now() - started) / 1000, polls, segments: final.segments.length,
        futureTextShown: maxLagMs > 0, correction: final.correction,
        corrected: final.segments.filter((s: any) => s.edits.length).length,
        sampleEdits: final.segments.flatMap((s: any) => s.edits.map((e: any) => `${e.from} → ${e.to}`)).slice(0, 15),
      };
      assert.equal(report.futureTextShown, false, 'no text is shown before its replay time');
      await writeFile(resolve('artifacts/replay-check.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
} finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
