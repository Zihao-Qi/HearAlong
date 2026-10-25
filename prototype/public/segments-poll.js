/** The page owns one full transcript. Reset on meeting changes, stale replies and request errors. */
export function createSegmentsPoll() {
  let owner = null, tag = '', segments = [];
  const reset = () => { owner = null; tag = ''; segments = []; };
  return {
    reset,
    have: meetingId => owner === meetingId ? tag : '',
    merge(meetingId, snapshot) {
      if (snapshot.meetingId !== meetingId) { reset(); return null; }
      const from = snapshot.segmentsFrom;
      if (!Number.isSafeInteger(from) || from < 0 || !Array.isArray(snapshot.segments) || typeof snapshot.segmentsTag !== 'string'
        || (from > 0 && (owner !== meetingId || from > segments.length))) {
        reset();
        throw new Error('Invalid transcript delta; fetching the whole list next time.');
      }
      segments = from === 0 ? snapshot.segments : segments.slice(0, from).concat(snapshot.segments);
      owner = meetingId;
      tag = snapshot.segmentsTag;
      return { ...snapshot, segments };
    },
  };
}
