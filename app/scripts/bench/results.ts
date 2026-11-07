// Shapes of the raw result files. The report reads these; the runners write them. Samples stay in the JSON and are not required here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Breakdown } from './breakdown.ts';
import type { WerResult } from './wer.ts';
import { TALK_STATES, type CallScore } from './call-mix.ts';

export type MachineInfo = {
  commit: string;
  normalizer?: string;
  scoringCommit?: string;
  scoringDirty?: boolean;
  rescoredFrom?: string;
  rescoredAt?: string;
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
  breakdown?: Breakdown;
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

export type IhmFile = Omit<WerFile, 'kind'> & { kind: 'ihm'; legacyTotals: WerResult; clips: number; transcriptsFile: string };

/** Spoken to visible (headline) or reached server to available (diagnostic), per source. */
export type CallLag = { me: { preview: CountSummary; final: CountSummary }; them: { preview: CountSummary; final: CountSummary } };
/** What the server exposes about AEC: its frame counter and wait totals (`capture.echoStats()`), and its once-per-recording raw notices. */
export type CallAec = { micFrames: number; aecFrames: number; failures: number; referenceCoverage: number | null; meanWaitMs: number | null; maxWaitMs: number | null; notices: string[] };
export type CallPairResult = {
  name: string; pair: string; delayMs: number; gainDb: number; audioSeconds: number; error: string | null;
  failedChunks: number; unfinishedChunks: number; score: CallScore; lag: CallLag; diagnostic: CallLag; aec: CallAec;
  timebase: { micZeroMs: number; callZeroMs: number; clockOffsetMs: number | null; callStartMs: number | null };
};
export type CallFile = MachineInfo & {
  kind: 'call';
  createdAt: string;
  runLabel: string | null;
  model: string;
  error: string | null;
  failedChunks: number;
  unfinishedChunks: number;
  condition: { pairs: string[]; blocks: number; smoke: boolean; room: string };
  pairs: CallPairResult[];
  /** Finished pairs only: summed counts, pooled lag samples. */
  totals: { pairs: number; score: CallScore; lag: CallLag; diagnostic: CallLag; aec: { micFrames: number; aecFrames: number; failures: number; notices: number } };
};
export type BenchResult = WerFile | LiveFile | IhmFile | CallFile;

export function fileStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** `wer-<stamp>.json`, with a numeric suffix if that name is already taken. */
export function resultPath(directory: string, prefix: 'wer' | 'live' | 'ihm' | 'call', date = new Date()): string {
  const base = `${prefix}-${fileStamp(date)}`;
  let path = join(directory, `${base}.json`);
  for (let n = 2; existsSync(path); n++) path = join(directory, `${base}-${n}.json`);
  return path;
}

export function parseResult(value: unknown): BenchResult {
  const row = record(value, 'result');
  if (row.kind === 'wer') return validateCompletion(parseWer(row));
  if (row.kind === 'live') return validateCompletion(parseLive(row));
  if (row.kind === 'ihm') return validateCompletion({ ...parseWer(row), kind: 'ihm', legacyTotals: parseScore(row.legacyTotals, 'legacyTotals'), clips: needCount(row.clips, 'clips'), transcriptsFile: needString(row.transcriptsFile, 'transcriptsFile') });
  if (row.kind === 'call') return validateCompletion(parseCall(row));
  throw new Error('Invalid benchmark result: kind must be "wer", "live", "ihm", or "call".');
}

export function chunkCompletionError(failed: number, unfinished: number): string | null {
  return failed || unfinished ? `${failed} failed chunks; ${unfinished} unfinished chunks.` : null;
}

/** Also applied by the report to programmatically supplied runs, not only parsed JSON. */
export function validateCompletion<T extends BenchResult>(run: T): T {
  if (run.kind === 'call') return { ...run, error: run.error || chunkCompletionError(run.failedChunks, run.unfinishedChunks) || (run.totals.pairs === 0 ? 'No pair finished.' : null) };
  const failed = run.kind !== 'live' ? run.sessions.reduce((n, s) => n + s.failedChunks, 0) : run.failedChunks ?? 0;
  const unfinished = run.kind !== 'live' ? run.sessions.reduce((n, s) => n + (s.unfinishedChunks ?? 0), 0) : run.unfinishedChunks ?? 0;
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
    breakdown: row.breakdown === undefined ? undefined : parseBreakdown(row.breakdown),
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

function parseCall(row: Record<string, unknown>): CallFile {
  const condition = record(row.condition, 'condition'), totals = record(row.totals, 'totals'), aec = record(totals.aec, 'totals.aec');
  if (!Array.isArray(condition.pairs) || !condition.pairs.length) bad('condition.pairs must be a nonempty array');
  if (!Array.isArray(row.pairs)) bad('pairs must be an array');
  return {
    ...machine(row), kind: 'call', createdAt: needString(row.createdAt, 'createdAt'), runLabel: label(row.runLabel), model: needString(row.model, 'model'), error: errorOf(row.error),
    failedChunks: needCount(row.failedChunks, 'failedChunks'), unfinishedChunks: needCount(row.unfinishedChunks, 'unfinishedChunks'),
    condition: { pairs: condition.pairs.map(item => needString(item, 'condition.pairs')), blocks: needCount(condition.blocks, 'condition.blocks'),
      smoke: needBoolean(condition.smoke, 'condition.smoke'), room: needString(condition.room, 'condition.room') },
    pairs: row.pairs.map((item, index) => parseCallPair(item, `pairs[${index}]`)),
    totals: { pairs: needCount(totals.pairs, 'totals.pairs'), score: parseCallScore(totals.score, 'totals.score'), lag: parseCallLag(totals.lag, 'totals.lag'), diagnostic: parseCallLag(totals.diagnostic, 'totals.diagnostic'),
      aec: { micFrames: needCount(aec.micFrames, 'totals.aec.micFrames'), aecFrames: needCount(aec.aecFrames, 'totals.aec.aecFrames'),
        failures: needCount(aec.failures, 'totals.aec.failures'), notices: needCount(aec.notices, 'totals.aec.notices') } },
  };
}

function parseCallPair(value: unknown, at: string): CallPairResult {
  const row = record(value, at), aec = record(row.aec, `${at}.aec`), timebase = record(row.timebase, `${at}.timebase`);
  const nullable = (item: unknown, name: string) => item === null ? null : needNumber(item, name);
  if (!Array.isArray(aec.notices)) bad(`${at}.aec.notices must be an array`);
  return {
    name: needString(row.name, `${at}.name`), pair: needString(row.pair, `${at}.pair`), delayMs: needNumber(row.delayMs, `${at}.delayMs`), gainDb: needNumber(row.gainDb, `${at}.gainDb`),
    audioSeconds: needNumber(row.audioSeconds, `${at}.audioSeconds`), error: errorOf(row.error),
    failedChunks: needCount(row.failedChunks, `${at}.failedChunks`), unfinishedChunks: needCount(row.unfinishedChunks, `${at}.unfinishedChunks`),
    score: parseCallScore(row.score, `${at}.score`), lag: parseCallLag(row.lag, `${at}.lag`), diagnostic: parseCallLag(row.diagnostic, `${at}.diagnostic`),
    aec: { micFrames: needCount(aec.micFrames, `${at}.aec.micFrames`), aecFrames: needCount(aec.aecFrames, `${at}.aec.aecFrames`), failures: needCount(aec.failures, `${at}.aec.failures`),
      referenceCoverage: nullable(aec.referenceCoverage, `${at}.aec.referenceCoverage`), meanWaitMs: nullable(aec.meanWaitMs, `${at}.aec.meanWaitMs`),
      maxWaitMs: nullable(aec.maxWaitMs, `${at}.aec.maxWaitMs`), notices: aec.notices.map(item => needString(item, `${at}.aec.notices`)) },
    timebase: { micZeroMs: needNumber(timebase.micZeroMs, `${at}.timebase.micZeroMs`), callZeroMs: needNumber(timebase.callZeroMs, `${at}.timebase.callZeroMs`),
      clockOffsetMs: nullable(timebase.clockOffsetMs, `${at}.timebase.clockOffsetMs`), callStartMs: nullable(timebase.callStartMs, `${at}.timebase.callStartMs`) },
  };
}

function parseCallLag(value: unknown, at: string): CallLag {
  const row = record(value, at), me = record(row.me, `${at}.me`), them = record(row.them, `${at}.them`);
  return { me: { preview: summary(me.preview, `${at}.me.preview`), final: summary(me.final, `${at}.me.final`) },
    them: { preview: summary(them.preview, `${at}.them.preview`), final: summary(them.final, `${at}.them.final`) } };
}

function parseCallScore(value: unknown, at: string): CallScore {
  const row = record(value, at), outside = record(row.outside, `${at}.outside`);
  const leak = (item: unknown, name: string) => {
    const l = record(item, name);
    return { farWords: needCount(l.farWords, `${name}.farWords`), matched: needCount(l.matched, `${name}.matched`), meWords: needCount(l.meWords, `${name}.meWords`), rate: needNumber(l.rate, `${name}.rate`) };
  };
  const result = { outside: { meWords: needCount(outside.meWords, `${at}.outside.meWords`), themWords: needCount(outside.themWords, `${at}.outside.themWords`), lines: needCount(outside.lines, `${at}.outside.lines`) },
    straddling: needCount(row.straddling, `${at}.straddling`) } as CallScore;
  for (const state of TALK_STATES) {
    const name = `${at}.${state}`, item = record(row[state], name), hidden = record(item.hidden, `${name}.hidden`);
    result[state] = { me: parseScore(item.me, `${name}.me`), meRaw: parseScore(item.meRaw, `${name}.meRaw`), them: parseScore(item.them, `${name}.them`),
      leak: leak(item.leak, `${name}.leak`), leakRaw: leak(item.leakRaw, `${name}.leakRaw`),
      hidden: { lines: needCount(hidden.lines, `${name}.hidden.lines`), words: needCount(hidden.words, `${name}.hidden.words`), genuine: needCount(hidden.genuine, `${name}.hidden.genuine`),
        recognizedGenuine: needCount(hidden.recognizedGenuine, `${name}.hidden.recognizedGenuine`) } };
  }
  return result;
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
    normalizer: row.normalizer === undefined ? 'hearalong-1' : needString(row.normalizer, 'normalizer'),
    scoringCommit: row.scoringCommit === undefined ? undefined : needString(row.scoringCommit, 'scoringCommit'),
    scoringDirty: row.scoringDirty === undefined ? undefined : needBoolean(row.scoringDirty, 'scoringDirty'),
    rescoredFrom: row.rescoredFrom === undefined ? undefined : needString(row.rescoredFrom, 'rescoredFrom'),
    rescoredAt: row.rescoredAt === undefined ? undefined : needString(row.rescoredAt, 'rescoredAt'),
    commit: needString(row.commit, 'commit'), macos: needString(row.macos, 'macos'), chip: needString(row.chip, 'chip'), ramBytes: needNumber(row.ramBytes, 'ramBytes'),
    logicalCores: optionalCount(row.logicalCores, 'logicalCores'), dirty: row.dirty as boolean | undefined,
    nodeVersion: row.nodeVersion === undefined ? undefined : needString(row.nodeVersion, 'nodeVersion'), modelIdentity,
  };
}

function needBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') bad(`${label} must be a boolean`);
  return value;
}

function parseScore(value: unknown, label: string): WerResult {
  const row = record(value, label);
  return { substitutions: needCount(row.substitutions, `${label}.substitutions`), deletions: needCount(row.deletions, `${label}.deletions`),
    insertions: needCount(row.insertions, `${label}.insertions`), hits: needCount(row.hits, `${label}.hits`),
    referenceWords: needCount(row.referenceWords, `${label}.referenceWords`), wer: needRatio(row.wer, `${label}.wer`) };
}

function parseBreakdown(value: unknown): Breakdown {
  const row = record(value, 'breakdown');
  return { singleSpeaker: parseScore(row.singleSpeaker, 'singleSpeaker'), overlap: parseScore(row.overlap, 'overlap'),
    shortTurn: parseScore(row.shortTurn, 'shortTurn'), chunkEdge: parseScore(row.chunkEdge, 'chunkEdge'),
    overlapDeletionShare: needNumber(row.overlapDeletionShare, 'overlapDeletionShare') };
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
