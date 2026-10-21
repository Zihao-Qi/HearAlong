// Learn how the local recognizer actually mishears glossary terms: synthesize each term with macOS voices
// inside a carrier sentence, transcribe it, and keep what was heard in the term's place.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runBinary } from './audio.ts';
import type { GlossaryTerm } from './correction.ts';

export const PROBE_VOICES = ['Samantha', 'Daniel', 'Rishi', 'Karen'];
const CARRIERS: [string, string][] = [['I think the', 'part matters here.'], ['So we tried', 'again today.']];
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/**
 * How the term is said aloud: plain terms as written; symbols by their first spoken variant. spokenVariants mixes
 * pronunciations with guessed mishearings, so a symbol probe may say a guess; the probe is a diagnostic, not wired in.
 */
export function speakable(term: GlossaryTerm): string | null {
  if (/^[\p{L}\s'.-]+$/u.test(term.term) && term.term.replace(/[^\p{L}]/gu, '').length >= 3) return term.term;
  return term.spokenVariants.find(v => /^[A-Za-z\s'-]+$/.test(v)) ?? null;
}

/** The heard words between the carrier's prefix and suffix, or null when the carrier itself was garbled. */
export function heardBetween(transcript: string, prefix: string, suffix: string): string | null {
  const heard = words(transcript), before = words(prefix), after = words(suffix);
  if (heard.length < before.length + after.length + 1) return null;
  if (before.some((w, i) => heard[i] !== w) || after.some((w, i) => heard[heard.length - after.length + i] !== w)) return null;
  return heard.slice(before.length, heard.length - after.length).join(' ');
}

export type ProbeResult = { term: string; heard: string[]; clips: number; garbled: number };

/**
 * `recognize` transcribes one 16 kHz WAV file. Variants that equal the spoken form are dropped:
 * only real mishearings are useful to the corrector.
 */
export async function probeTerms(terms: GlossaryTerm[], options: {
  workDir: string; recognize: (path: string) => Promise<string>; voices?: string[]; concurrency?: number;
}): Promise<ProbeResult[]> {
  await mkdir(options.workDir, { recursive: true });
  const voices = options.voices ?? PROBE_VOICES;
  const jobs = terms.flatMap((term, t) => {
    const spoken = speakable(term);
    return spoken ? voices.flatMap((voice, v) => CARRIERS.map((carrier, c) => ({ term, spoken, voice, carrier, path: join(options.workDir, `${t}-${v}-${c}.wav`) }))) : [];
  });
  const results = new Map<string, ProbeResult>();
  try {
    // Synthesis is parallel; recognition is serial (one native model). All workers settle before cleanup.
    const queue = [...jobs];
    const synthesis = await Promise.allSettled(Array.from({ length: options.concurrency ?? 6 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await runBinary('say', ['-v', job.voice, '-o', job.path, '--file-format=WAVE', '--data-format=LEI16@16000', `${job.carrier[0]} ${job.spoken} ${job.carrier[1]}`], { timeoutMs: 20_000 });
      }
    }));
    const failure = synthesis.find(r => r.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    for (const job of jobs) {
      const result = results.get(job.term.term) ?? { term: job.term.term, heard: [], clips: 0, garbled: 0 };
      results.set(job.term.term, result);
      result.clips++;
      const heard = heardBetween(await options.recognize(job.path), ...job.carrier);
      if (heard === null) { result.garbled++; continue; }
      const same = [job.term.term, job.spoken].some(form => words(form).join(' ') === heard);
      if (!same && heard && heard.split(' ').length <= 6 && !result.heard.includes(heard)) result.heard.push(heard);
    }
  } finally { await rm(options.workDir, { recursive: true, force: true }); }
  return [...results.values()];
}
