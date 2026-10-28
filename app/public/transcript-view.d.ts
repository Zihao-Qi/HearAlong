import type { CaptureGap } from './capture-gaps.js';
import type { Preview, PendingPreview, ComposedPreview } from './preview-composition.js';
export type DisplaySegment = { id: string; startMs: number; endMs: number; text: string; revision: number; speaker?: string | null };
export type TranscriptSnapshot = { segments: DisplaySegment[]; drafts?: Preview[]; pending?: PendingPreview[]; labelled?: boolean; captureGaps?: CaptureGap[] };
export type TranscriptRow = { kind?: string; gap?: CaptureGap; gapText?: string; key: string; signature: string; startMs: number; endMs: number; segments: DisplaySegment[]; preview?: ComposedPreview; speaker?: string | null };
export function transcriptRows(snapshot: TranscriptSnapshot): TranscriptRow[];
export function createTranscriptView(box: HTMLElement, options: { segmentNode: (segment: DisplaySegment) => HTMLElement; changed?: () => void; emptyText?: () => string }): {
  paragraphs: Map<string, HTMLElement>; following: boolean; readonly paused: boolean; render: (snapshot: TranscriptSnapshot, preserve?: boolean) => void; follow: () => void; reset: () => void;
};
