/** Only protocol/state conflicts are permanent; I/O and SQLite failures must remain retryable. */
export class CaptureConflict extends Error { status = 409; }
