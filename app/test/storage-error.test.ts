import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptionStorageMessage } from '../public/storage-error.js';

for (const error of ['ENOSPC: no space left on device', 'sqlite_full: database full', 'Database Or Disk Is Full']) {
  test(`disk-full storage error: ${error}`, () => {
    assert.equal(transcriptionStorageMessage(error), 'Transcription paused: the disk is full. ');
  });
}
for (const error of ['SQLITE_IOERR_WRITE: disk I/O error', 'EACCES: permission denied', '<img src=x onerror=alert(1)>']) {
  test(`other storage error: ${error}`, () => {
    assert.equal(transcriptionStorageMessage(error), 'Transcription paused: couldn’t save. ');
  });
}
