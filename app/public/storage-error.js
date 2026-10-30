/** Plain-language classification only; the original error is kept in Activity. */
export function transcriptionStorageMessage(error) {
  return /ENOSPC|SQLITE_FULL|database or disk is full/i.test(error)
    ? 'Transcription paused: the disk is full. '
    : 'Transcription paused: couldn’t save. ';
}
