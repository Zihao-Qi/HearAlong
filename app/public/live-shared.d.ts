// Types of live-shared.js for the server (the browser loads the .js directly).
export interface ParagraphLine { id: string; startMs: number; endMs: number; revision: number; text?: string; speaker?: string | null }
export interface Paragraph<T extends ParagraphLine> { key: string; startMs: number; endMs: number; segments: T[]; speaker: string | null | undefined; signature: string }
export interface ParagraphBarrier { startMs: number; speaker?: string | null; all?: boolean }
export function paragraphsOf<T extends ParagraphLine>(segments: T[], barriers?: ParagraphBarrier[]): Paragraph<T>[];
export function paragraphCachePrefix(paragraphs: { startMs: number; endMs: number }[], horizon: number): number;
export interface Notice { short: string; text: string }
export const NOTICES: { tabEnded: Notice; savingBehind: Notice; quietTab: Notice; quietMic: Notice };
export const SAVING_BEHIND_FRAMES: number;
export const TYPE_LABELS: Record<string, string>;
export function stamp(ms: number): string;
export function signatureLines(signature: string): string[];
