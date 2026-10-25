export function createSegmentsPoll(): {
  reset(): void;
  have(meetingId: string): string;
  merge<T extends { meetingId: string; segmentsFrom: number; segmentsTag: string; segments: unknown[] }>(meetingId: string, snapshot: T): T | null;
};
