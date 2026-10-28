import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentsTag } from '../src/segments-tag.ts';
import { createSegmentsPoll } from '../public/segments-poll.js';

test('tags accept every base64url nonce, bind meetings and runs, and name every serialized field', () => {
  const tags = new SegmentsTag();
  Object.assign(tags, { nonce: '-_______________' });
  const lines = Array.from({ length: 80 }, (_, id) => ({ id, text: 'Workshop.', speaker: 'Me', originalText: 'Workshop', edits: [], timing: 'word', revision: 0 }));
  const whole = tags.delta('workshop', lines, null);
  assert.equal(tags.delta('workshop', lines, whole.segmentsTag).segmentsFrom, 80);
  assert.equal(tags.delta('other', lines, whole.segmentsTag).segmentsFrom, 0);
  assert.equal(new SegmentsTag().delta('workshop', lines, whole.segmentsTag).segmentsFrom, 0);
  for (const [key, value] of Object.entries({ text: 'Changed.', speaker: 'Them', originalText: 'Original.', edits: [{ from: 'A', to: 'B' }], timing: 'estimated', revision: 1 })) {
    const changed = lines.map(line => ({ ...line }));
    Object.assign(changed[79], { [key]: value });
    assert.equal(tags.delta('workshop', changed, whole.segmentsTag).segmentsFrom, 48, key);
  }
  for (const have of ['', 'bad', whole.segmentsTag + '.bad', whole.segmentsTag + '\n', whole.segmentsTag.replace('.80.', '.080.'), whole.segmentsTag.replace('.80.', '.9007199254740992.')]) {
    assert.equal(tags.delta('workshop', lines, have).segmentsFrom, 0);
  }
  const client = createSegmentsPoll();
  client.merge('workshop', { meetingId: 'workshop', ...whole });
  const shrunk = tags.delta('workshop', lines.slice(0, 60), whole.segmentsTag);
  assert.equal(shrunk.segmentsFrom, 48);
  assert.deepEqual(client.merge('workshop', { meetingId: 'workshop', ...shrunk })?.segments, lines.slice(0, 60));
  const empty = tags.delta('workshop', [], shrunk.segmentsTag);
  assert.deepEqual(client.merge('workshop', { meetingId: 'workshop', ...empty })?.segments, []);
  assert.deepEqual(tags.delta('workshop', [], empty.segmentsTag).segments, []);
});

test('the merge rejects deltas without their prefix and resets after malformed replies', () => {
  const client = createSegmentsPoll();
  const reply = { meetingId: 'workshop', segmentsFrom: 1, segmentsTag: 'tag', segments: [] };
  assert.throws(() => client.merge('workshop', reply), /Invalid transcript delta/);
  assert.equal(client.have('workshop'), '');
  client.merge('workshop', { ...reply, segmentsFrom: 0, segments: [{ id: 'line' }] });
  assert.equal(client.have('workshop'), 'tag');
  assert.equal(client.have('other'), '');
  assert.throws(() => client.merge('workshop', { ...reply, segmentsFrom: -1 }), /Invalid transcript delta/);
  assert.equal(client.have('workshop'), '');
});
