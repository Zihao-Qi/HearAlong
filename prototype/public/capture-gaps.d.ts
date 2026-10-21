export type CaptureGap = { meetingId?: string; source?: string; atMs: number; fromWallMs: number; toWallMs: number; reason: 'sleep' | null };
export function mergeCaptureGaps(gaps: CaptureGap[]): CaptureGap[];
export function captureGapText(gap: CaptureGap, locale?: string): string;
