import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';

test('hidden citations choose the largest true overlap, then earliest, and never a nearby unrelated line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-cite-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional lantern call');
  try {
    const text = 'The paper lantern is ready';
    const add = (id: string, source: string, start: number, end: number) => {
      store.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,status,hash)
        VALUES (?,?,?,?,'fictional',0,0,30,'completed','fixture')`).run(id, meeting.id, source, start);
      store.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
        VALUES (?,?,?,?,0,?,?,?,?, 'word')`).run(id, meeting.id, id, source, start, end, text, text);
    };
    add('mic', 'mic:room', 10000, 15000);
    add('later', 'app:call', 11000, 14000);
    add('earlier', 'app:call', 9000, 13000);
    assert.equal(store.citationSegment(meeting.id, 'mic'), 'earlier');
    add('largest', 'app:call', 10000, 15000);
    assert.equal(store.citationSegment(meeting.id, 'mic'), 'largest');
    assert.equal(store.citationSegment(meeting.id, 'largest'), 'largest');
    assert.equal(store.citationSegment(store.createMeeting('Other room').id, 'mic'), undefined);
    store.db.exec("DELETE FROM segments WHERE source='app:call'");
    add('slack-only', 'tab:other', 16000, 17000);
    assert.equal(store.segments(meeting.id).some(s => s.id === 'mic'), false, 'slack-only text is still an echo');
    assert.equal(store.citationSegment(meeting.id, 'mic'), undefined, 'no true overlap: no unrelated span substitution');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
