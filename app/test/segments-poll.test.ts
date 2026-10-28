import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { createSegmentsPoll } from '../public/segments-poll.js';
const meetingId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'segments-poll-'));
  let now = 100_000;
  const options = { directory, port: 0, clock: () => now, quick: null, heavy: null, recognizer: null, drafts: null, notes: null, actions: null, board: null, plans: null };
  let app = await startServer(options);
  let headers: Record<string, string>;
  const authenticate = async () => {
    const page = await fetch(app.url);
    headers = { Cookie: page.headers.get('set-cookie')!.split(';')[0], Origin: app.url };
  };
  await authenticate();
  for (const [id, title] of [[meetingId, 'Workshop'], [otherId, 'Second workshop']]) {
    const meeting = app.store.createMeeting(title);
    app.store.db.prepare('UPDATE meetings SET id=? WHERE id=?').run(id, meeting.id);
  }
  let chunks = 0;
  const add = (count: number, id = meetingId, source = 'mic:workshop', start = chunks * 10000) => {
    const chunkId = `fixture-chunk-${chunks++}`;
    app.store.db.prepare("INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,text,hash) VALUES (?,?,?,?,?,0,?,10,16000,'completed','Workshop','fixture')")
      .run(chunkId, id, source, chunks, '', start);
    const insert = app.store.db.prepare("INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing) VALUES (?,?,?,?,?,?,?,?,?,'word')");
    for (let i = 0; i < count; i++) {
      const text = `The fictional workshop will review experiment ${i} and preserve the measurements before the next trial.`;
      insert.run(`${chunkId}:${i}`, id, chunkId, source, i, start + i * 10, start + (i + 1) * 10, text, text);
    }
  };
  const poll = async (id = meetingId, have = '') => {
    const response = await fetch(`${app.url}/api/meetings/${id}/segments${have ? '?have=' + encodeURIComponent(have) : ''}`, { headers });
    assert.equal(response.status, 200);
    const text = await response.text();
    return { text, data: JSON.parse(text) };
  };
  return { get app() { return app; }, add, poll, advance(ms: number) { now += ms; },
    async restart() { await app.close(); app = await startServer(options); await authenticate(); },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('delta merge equals fresh whole replies through mutations, replay and meeting switches', async () => {
  const f = await fixture();
  const client = createSegmentsPoll();
  const step = async (id = meetingId) => {
    const { data } = await f.poll(id, client.have(id));
    assert.equal(typeof data.segmentsTag, 'string');
    const merged = client.merge(id, data);
    assert.ok(merged);
    const fresh = (await f.poll(id)).data;
    assert.deepEqual(merged.segments, fresh.segments);
    const { segments: _delta, segmentsFrom: _from, segmentsTag: _tag, ...metadata } = data;
    const { segments: _whole, segmentsFrom: _zero, segmentsTag: _freshTag, ...freshMetadata } = fresh;
    assert.deepEqual(metadata, freshMetadata, 'all other snapshot fields still travel on every poll');
    return data;
  };
  try {
    f.add(100);
    await step();
    assert.equal((await step()).segments.length, 0, 'unchanged list is omitted');
    f.add(4);
    assert.ok((await step()).segmentsFrom > 0, 'new chunk resends only the tail');
    const lines = f.app.store.segments(meetingId);
    f.app.store.applyEdits(lines.at(-1)!.id, 0, 'A recent correction.', []);
    assert.ok((await step()).segmentsFrom > 0, 'recent correction resends only the tail');
    f.app.store.applyEdits(lines[0].id, 0, 'An old correction.', []);
    assert.equal((await step()).segmentsFrom, 0, 'older correction invalidates checkpoint');
    f.app.store.db.prepare('DELETE FROM segments WHERE id=?').run(lines[1].id);
    await step(); // hidden/removed line
    f.add(1, meetingId, 'tab:workshop', 0);
    const labelled = await step();
    assert.equal(labelled.labelled, true);
    assert.equal(labelled.segmentsFrom, 0, 'speaker fields affect the tag');
    const tab = f.app.store.chunks(meetingId).find(c => c.source === 'tab:workshop')!;
    f.app.store.db.prepare('UPDATE chunks SET startMs=5000 WHERE id=?').run(tab.id);
    const moved = await step();
    assert.equal(moved.segmentsFrom, 0, 'a changed audio range relabels existing lines');
    f.app.store.db.prepare('INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash) VALUES (?,?,?,0,?,0,16000,?)')
      .run('label-frame', meetingId, 'tab:frame-only', '', 'fixture');
    assert.equal((await step()).segmentsFrom, 0, 'frame-only speaker changes also invalidate the tag');
    f.add(10, otherId, 'import:workshop', 0);
    client.reset();
    await step(otherId);
    f.app.store.startReplay(otherId, 'import:workshop', 1, 100_000);
    await step(otherId); // replay hides every line until its end is reached
    f.advance(50);
    await step(otherId);
    f.advance(5000);
    await step(otherId);
    client.reset();
    assert.equal(client.have(meetingId), '');
    await step();
    const wrong = (await f.poll(otherId)).data;
    assert.equal(client.merge(meetingId, wrong), null, 'stale reply cannot replace the held meeting');
    assert.equal(client.have(meetingId), '', 'stale reply resets the cursor');
    await step();
    client.reset(); // request error / server-session error follows this same path in app.js
    assert.equal(client.have(meetingId), '');
    assert.equal((await step()).segmentsFrom, 0);
  } finally { await f.close(); }
});

test('3000 unchanged segments are omitted in a reply smaller than 10 KB', async () => {
  const f = await fixture();
  try {
    f.add(3000);
    const whole = (await f.poll()).data;
    const next = await f.poll(meetingId, whole.segmentsTag);
    assert.equal(next.data.segmentsFrom, 3000);
    assert.deepEqual(next.data.segments, []);
    assert.ok(Buffer.byteLength(next.text) < 10000);
  } finally { await f.close(); }
});

test('new chunk lines resend only the end', async () => {
  const f = await fixture();
  try {
    f.add(100);
    const whole = (await f.poll()).data;
    f.add(4);
    const next = (await f.poll(meetingId, whole.segmentsTag)).data;
    assert.ok(next.segmentsFrom > 0);
    assert.ok(next.segments.length < whole.segments.length);
  } finally { await f.close(); }
});

test('another meeting, server restart, garbled and stale tags fall back to the whole list', async () => {
  const f = await fixture();
  try {
    f.add(100);
    f.add(1, otherId);
    const whole = (await f.poll()).data;
    assert.equal(typeof whole.segmentsTag, 'string');
    const parts = whole.segmentsTag.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    for (const tag of [(await f.poll(otherId)).data.segmentsTag, 'garbled', whole.segmentsTag + '.bad', parts.join('.')]) {
      const reply = (await f.poll(meetingId, tag)).data;
      assert.equal(reply.segmentsFrom, 0);
      assert.deepEqual(reply.segments, whole.segments);
    }
    f.app.store.applyEdits(f.app.store.segments(meetingId)[0].id, 0, 'Old line changed.', []);
    assert.equal((await f.poll(meetingId, whole.segmentsTag)).data.segmentsFrom, 0);
    const beforeRestart = (await f.poll()).data.segmentsTag;
    await f.restart();
    assert.equal((await f.poll(meetingId, beforeRestart)).data.segmentsFrom, 0);
  } finally { await f.close(); }
});

test('without have the reply is byte-for-byte the base response apart from new fields', async () => {
  const f = await fixture();
  try {
    f.add(3);
    const reply = (await f.poll()).data;
    // Captured with this exact fixture on the base server, before the delta protocol.
    assert.equal(typeof reply.segmentsTag, 'string');
    assert.equal(reply.segmentsFrom, 0);
    delete reply.segmentsTag;
    delete reply.segmentsFrom;
    const expected = await readFile(new URL('./fixtures/segments-base.json', import.meta.url), 'utf8');
    assert.equal(JSON.stringify(reply) + '\n', expected);
  } finally { await f.close(); }
});
