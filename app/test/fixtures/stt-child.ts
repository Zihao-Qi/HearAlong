// Test-only IPC double: never loads a model or captures audio.
process.on('message', (job: any) => {
  if (job.kind === 'shutdown') { if (process.connected) process.disconnect(); return; }
  if (job.seconds === 1) return; // Stay in-flight until the test kills this child.
  process.send?.({ kind: 'result', id: job.id, result: { text: 'Recovered worker', backend: 'test', computeMs: 1, decodeMs: 1,
    audioSeconds: 2, processRssBytes: 0, timestampKind: 'none', words: [] } });
});
process.send?.({ kind: 'ready', backend: 'test' });
