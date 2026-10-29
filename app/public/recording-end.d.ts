export type RecordingEnd = { source: string; lastSequence: number | null; stopping: boolean };
export function createRecordingEnds<T>(send: (path: string, value: RecordingEnd) => Promise<T>, options?: {
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}): { end(path: string, value: RecordingEnd): Promise<T> };
