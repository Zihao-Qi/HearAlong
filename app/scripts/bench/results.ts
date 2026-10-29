// Shapes of the raw result files. The report reads these; the runners write them. Samples stay in the JSON and are not required here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type MachineInfo = {
  commit: string;
  macos: string;
  chip: string;
  ramBytes: number;
  // Optional only for legacy files. New runners always write these.
  logicalCores?: number;
  dirty?: boolean;
  nodeVersion?: string;
  modelIdentity?: ModelIdentity;
};

export type ModelIdentity = { basename: string; sha256: string; bytes: number };

export type CountSummary = {
  mean: number;
  p50: number;
  p95: number;
  max: number;
  n: number;
};

export type WerSession = {
  meetingId: string;
  mic: string;
  audioSeconds: number;
  wallSeconds: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  referenceWords: number;
  wer: number;
  failedChunks: number;
  unfinishedChunks?: number;
};

export type WerFile = MachineInfo & {
  kind: 'wer';
  createdAt: string;
  runLabel: string | null;
  model: string;
  error: string | null;
  /** Requested condition, not just the sessions reached before a failure. */
  condition?: { sessions: string[]; mics: string[] };
  sessions: WerSession[];
  totals: {
    substitutions: number;
    deletions: number;
    insertions: number;
    hits: number;
    referenceWords: number;
    wer: number;
    audioSeconds: number;
    wallSeconds: number;
  };
};

export type LiveFile = MachineInfo & {
  kind: 'live';
  createdAt: string;
  runLabel: string | null;
  model: string;
  error: string | null;
  /** Set when a headline median is more than 250 ms below its diagnostic. The run still finishes. Missing on older files means none. */
  warning: string | null;
  failedChunks?: number;
  unfinishedChunks?: number;
  meetingId: string;
  mic: string;
  fromSec: number;
  minutes: number;
  audioSeconds: number;
  /** Page `Date.now()` minus the Node clock, midpoint of one round trip. Recorded so the two clocks can be compared. Lag does not use it. */
  clockOffsetMs: number | null;
  /** Spoken to visible. */
  preview: CountSummary;
  final: CountSummary;
  /** Reached server (HTTP 201) to available on a segments snapshot. */
  diagnostic: { preview: CountSummary; final: CountSummary };
  wer: {
    substitutions: number;
    deletions: number;
    insertions: number;
    hits: number;
    referenceWords: number;
    wer: number;
  };
  resources: {
    server: { cpu: CountSummary; rssBytes: CountSummary };
    speechWorker: { cpu: CountSummary; rssBytes: CountSummary };
  };
};

export type BenchResult = WerFile | LiveFile;

export function fileStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** `wer-<stamp>.json`, with a numeric suffix if that name is already taken. */
export function resultPath(directory: string, prefix: 'wer' | 'live', date = new Date()): string {
  const base = `${prefix}-${fileStamp(date)}`;
  let path = join(directory, `${base}.json`);
  for (let n = 2; existsSync(path); n++) path = join(directory, `${base}-${n}.json`);
  return path;
}

export function parseResult(value: unknown): BenchResult {
  const row = record(value, 'result');
  if (row.kind === 'wer') return validateCompletion(parseWer(row));
  if (row.kind === 'live') return validateCompletion(parseLive(row));
  throw new Error('Invalid benchmark result: kind must be "wer" or "live".');
}

export function chunkCompletionError(failed: number, unfinished: number): string | null {
  return failed || unfinished ? `${failed} failed chunks; ${unfinished} unfinished chunks.` : null;
}

/** Also applied by the report to programmatically supplied runs, not only parsed JSON. */
export function validateCompletion<T extends BenchResult>(run: T): T {
  const failed = run.kind === 'wer' ? run.sessions.reduce((n, s) => n + s.failedChunks, 0) : run.failedChunks ?? 0;
  const unfinished = run.kind === 'wer' ? run.sessions.reduce((n, s) => n + (s.unfinishedChunks ?? 0), 0) : run.unfinishedChunks ?? 0;
  const error = run.error || chunkCompletionError(failed, unfinished) || (run.kind === 'live' && run.final.n === 0 ? 'No final samples were observed.' : null);
  return { ...run, error };
}

function parseWer(row: Record<string, unknown>): WerFile {
  const totals = record(row.totals, 'totals');
  const sessions = Array.isArray(row.sessions) ? row.sessions.map((item, index) => parseSession(item, index)) : bad('sessions must be an array');
  return { ...machine(row), kind: 'wer', createdAt: needString(row.createdAt, 'createdAt'), runLabel: label(row.runLabel), model: needString(row.model, 'model'), error: errorOf(row.error), condition: condition(row.condition), sessions, totals: {
    substitutions: needCount(totals.substitutions, 'totals.substitutions'),
    deletions: needCount(totals.deletions, 'totals.deletions'),
    insertions: needCount(totals.insertions, 'totals.insertions'),
    hits: needCount(totals.hits, 'totals.hits'),
    referenceWords: needCount(totals.referenceWords, 'totals.referenceWords'),
    wer: needRatio(totals.wer, 'totals.wer'),
    audioSeconds: needNumber(totals.audioSeconds, 'totals.audioSeconds'),
    wallSeconds: needNumber(totals.wallSeconds, 'totals.wallSeconds'),
  } };
}

function parseSession(value: unknown, index: number): WerSession {
  const row = record(value, `sessions[${index}]`);
  return {
    meetingId: needString(row.meetingId, `sessions[${index}].meetingId`),
    mic: needString(row.mic, `sessions[${index}].mic`),
    audioSeconds: needNumber(row.audioSeconds, `sessions[${index}].audioSeconds`),
    wallSeconds: needNumber(row.wallSeconds, `sessions[${index}].wallSeconds`),
    substitutions: needCount(row.substitutions, `sessions[${index}].substitutions`),
    deletions: needCount(row.deletions, `sessions[${index}].deletions`),
    insertions: needCount(row.insertions, `sessions[${index}].insertions`),
    hits: needCount(row.hits, `sessions[${index}].hits`),
    referenceWords: needCount(row.referenceWords, `sessions[${index}].referenceWords`),
    wer: needRatio(row.wer, `sessions[${index}].wer`),
    failedChunks: needCount(row.failedChunks, `sessions[${index}].failedChunks`),
    unfinishedChunks: optionalCount(row.unfinishedChunks, `sessions[${index}].unfinishedChunks`),
  };
}

function parseLive(row: Record<string, unknown>): LiveFile {
  const scored = record(row.wer, 'wer');
  const resources = record(row.resources, 'resources');
  const server = record(resources.server, 'resources.server');
  const speechWorker = record(resources.speechWorker, 'resources.speechWorker');
  const diagnostic = record(row.diagnostic, 'diagnostic');
  return {
    ...machine(row), kind: 'live', createdAt: needString(row.createdAt, 'createdAt'), runLabel: label(row.runLabel), model: needString(row.model, 'model'), error: errorOf(row.error), warning: warningOf(row.warning),
    failedChunks: optionalCount(row.failedChunks, 'failedChunks'), unfinishedChunks: optionalCount(row.unfinishedChunks, 'unfinishedChunks'),
    meetingId: needString(row.meetingId, 'meetingId'), mic: needString(row.mic, 'mic'),
    fromSec: needNumber(row.fromSec, 'fromSec'), minutes: needNumber(row.minutes, 'minutes'), audioSeconds: needNumber(row.audioSeconds, 'audioSeconds'),
    clockOffsetMs: offset(row.clockOffsetMs),
    preview: summary(row.preview, 'preview'), final: summary(row.final, 'final'),
    diagnostic: { preview: summary(diagnostic.preview, 'diagnostic.preview'), final: summary(diagnostic.final, 'diagnostic.final') },
    wer: {
      substitutions: needCount(scored.substitutions, 'wer.substitutions'), deletions: needCount(scored.deletions, 'wer.deletions'),
      insertions: needCount(scored.insertions, 'wer.insertions'), hits: needCount(scored.hits, 'wer.hits'),
      referenceWords: needCount(scored.referenceWords, 'wer.referenceWords'), wer: needRatio(scored.wer, 'wer.wer'),
    },
    resources: {
      server: { cpu: summary(server.cpu, 'resources.server.cpu'), rssBytes: summary(server.rssBytes, 'resources.server.rssBytes') },
      speechWorker: { cpu: summary(speechWorker.cpu, 'resources.speechWorker.cpu'), rssBytes: summary(speechWorker.rssBytes, 'resources.speechWorker.rssBytes') },
    },
  };
}

function machine(row: Record<string, unknown>): MachineInfo {
  if (row.dirty !== undefined && typeof row.dirty !== 'boolean') bad('dirty must be a boolean');
  let modelIdentity: ModelIdentity | undefined;
  if (row.modelIdentity !== undefined) {
    const model = record(row.modelIdentity, 'modelIdentity');
    const sha256 = needString(model.sha256, 'modelIdentity.sha256');
    if (!/^[a-f0-9]{64}$/.test(sha256)) bad('modelIdentity.sha256 must be a SHA-256 hex digest');
    modelIdentity = { basename: needString(model.basename, 'modelIdentity.basename'), sha256, bytes: needCount(model.bytes, 'modelIdentity.bytes') };
  }
  return {
    commit: needString(row.commit, 'commit'), macos: needString(row.macos, 'macos'), chip: needString(row.chip, 'chip'), ramBytes: needNumber(row.ramBytes, 'ramBytes'),
    logicalCores: optionalCount(row.logicalCores, 'logicalCores'), dirty: row.dirty as boolean | undefined,
    nodeVersion: row.nodeVersion === undefined ? undefined : needString(row.nodeVersion, 'nodeVersion'), modelIdentity,
  };
}

function optionalCount(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : needCount(value, label);
}

function condition(value: unknown): WerFile['condition'] {
  if (value === undefined) return undefined;
  const row = record(value, 'condition');
  const strings = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || !value.length) bad(`${label} must be a nonempty array`);
    return value.map(item => needString(item, label));
  };
  return { sessions: strings(row.sessions, 'condition.sessions'), mics: strings(row.mics, 'condition.mics') };
}

function summary(value: unknown, label: string): CountSummary {
  const row = record(value, label);
  return { mean: needNumber(row.mean, `${label}.mean`), p50: needNumber(row.p50, `${label}.p50`), p95: needNumber(row.p95, `${label}.p95`), max: needNumber(row.max, `${label}.max`), n: needCount(row.n, `${label}.n`) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function needString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) bad(`${label} must be a string`);
  return value;
}

function needNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${label} must be a finite number`);
  return value;
}

function needCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) bad(`${label} must be a non-negative integer`);
  return value;
}

function needRatio(value: unknown, label: string): number {
  // JSON.stringify writes Infinity as null. An empty reference with a non-empty hypothesis is that case.
  if (value === null) return Infinity;
  if (typeof value !== 'number' || Number.isNaN(value)) bad(`${label} must be a number`);
  return value;
}

function offset(value: unknown): number | null {
  if (value === null) return null;
  return needNumber(value, 'clockOffsetMs');
}

function label(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') bad('runLabel must be a string or null');
  return value;
}

function errorOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') bad('error must be a string or null');
  return value;
}

function warningOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') bad('warning must be a string or null');
  return value;
}

function bad(message: string): never {
  throw new Error(`Invalid benchmark result: ${message}.`);
}
