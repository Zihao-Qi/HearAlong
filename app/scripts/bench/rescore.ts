// Re-score saved final text only; never starts a recognizer or alters a source result/work folder.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { benchPaths, reference, type BenchPaths } from './ami.ts';
import { scoreBreakdown, sumScores } from './breakdown.ts';
import { sourceInfo } from './machine.ts';
import { fileStamp, parseResult, resultPath } from './results.ts';
import { NORMALIZER } from './wer.ts';

export function savedFinalText(directory: string): string {
  const file = join(directory, 'meetings.sqlite');
  if (!existsSync(file)) throw new Error(`Missing saved transcript: ${file}. Cannot re-score without the final segments.`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT text FROM segments ORDER BY startMs, ord').all() as { text: string }[];
    return rows.map(row => row.text.trim()).filter(Boolean).join(' ');
  } finally { db.close(); }
}

export function rescore(raw: Record<string, unknown>, originalName: string, paths: BenchPaths, scoring: { commit: string; dirty: boolean }): Record<string, unknown> {
  const run = parseResult(raw);
  if (run.kind === 'ihm') throw new Error('bench:rescore accepts wer/live results, not ihm.');
  const metadata = { normalizer: NORMALIZER, rescoredFrom: originalName, rescoredAt: new Date().toISOString(), scoringCommit: scoring.commit, scoringDirty: scoring.dirty };
  if (run.kind === 'live') {
    // The live runner stores the exact final rehearsal transcript in its result, independently of logs/temporary audio.
    if (typeof raw.transcript !== 'string') throw new Error(`Missing saved live transcript in ${originalName}; live was not re-run.`);
    const words = reference(run.meetingId, { root: paths.root, fromSec: run.fromSec, toSec: run.fromSec + run.audioSeconds });
    const { overall, breakdown } = scoreBreakdown(words, raw.transcript);
    return { ...raw, ...metadata, wer: overall, breakdown };
  }
  const stamp = fileStamp(new Date(run.createdAt));
  // Load every hypothesis first: a missing session refuses the whole file, with no partial output.
  const hypotheses = run.sessions.map(session => savedFinalText(join(paths.work, 'wer', stamp, session.meetingId, session.mic)));
  const sessions = run.sessions.map((session, i) => {
    const words = reference(session.meetingId, { root: paths.root });
    const { overall, breakdown } = scoreBreakdown(words, hypotheses[i]);
    return { ...session, ...overall, breakdown };
  });
  return { ...raw, ...metadata, sessions, totals: { ...run.totals, ...sumScores(sessions) } };
}

function main(): void {
  const args = process.argv.slice(2), paths = benchPaths();
  if (!args.length || (args.includes('--all') && args.length !== 1) || args.some(arg => arg.startsWith('--') && arg !== '--all')) throw new Error('Usage: npm run bench:rescore -- <result.json ...> | --all');
  const files = args[0] === '--all' ? readdirSync(paths.results).filter(name => name.endsWith('.json')).sort().map(name => join(paths.results, name)) : args.map(file => resolve(file));
  const scoring = sourceInfo(true);
  let failures = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (args[0] === '--all' && (raw.rescoredFrom || raw.kind === 'ihm')) continue;
      const next = rescore(raw, basename(file), paths, scoring);
      const output = resultPath(paths.results, next.kind as 'wer' | 'live');
      writeFileSync(output, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      console.log(`${basename(file)} → ${output}`);
    } catch (error) {
      failures++;
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures) throw new Error(`${failures} result(s) could not be re-scored.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
