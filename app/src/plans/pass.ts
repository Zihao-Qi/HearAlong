// The plan pass reads once, then continues independent copies of that session in parallel.
// Keep the model, tool definitions and environment stable: changing them forfeits the shared prompt cache.
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ExplorationContext, ExplorationPiOptions } from '../explorations.ts';
import { checkCompleted, extractJson } from '../pi-task.ts';
import { ItemScanner, updatePlanProgress, type PlanProgress } from '../progress.ts';
import { RATE_LIMIT, modelRateLimit } from '../quota.ts';
import { PLAN_PASS_VERSION, PLAN_PROMPT, PLAN_STAGE1, PLAN_STAGE2_FALLBACK, planStage2 } from './prompt.ts';
import { MAX_PLANS } from './validate.ts';

export type OutlinePlan = { number: number; label: string; notes: string[] };
export function parseOutline(text: string) {
  const plans: OutlinePlan[] = [], deferred: { item: string; why: string }[] = [], review: string[] = [];
  let extra = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '');
    const p = /^P([1-9]\d*)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/.exec(line);
    if (p) {
      const number = Number(p[1]);
      if (plans.some(p => p.number === number)) { review.push(`Duplicate outline number P${number} was ignored.`); continue; }
      if (plans.length >= MAX_PLANS) { extra++; continue; }
      plans.push({ number, label: p[2].trim(), notes: p[3].match(/\bN\d+\b/g) ?? [] });
      continue;
    }
    const d = /^D\s*\|\s*(N\d+)\s*\|\s*(\S.*)$/.exec(line);
    if (d) deferred.push({ item: d[1], why: d[2].trim() });
  }
  if (extra) review.push(`${extra} outline plan(s) beyond the ${MAX_PLANS}-plan limit were ignored.`);
  return { plans, deferred, review };
}
/** Source locators/quotes stay verbatim. A meeting's own P-names are never outline references. */
export function replaceOutlineRefs(value: unknown, plans: OutlinePlan[], input = ''): unknown {
  const token = /(?<![\p{L}\p{N}_])P(\d+)(?![\p{L}\p{N}_])/gu;
  const meetingNames = new Set([...input.matchAll(token)].map(m => m[0]));
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(token, (match, n) => {
      const plan = plans.find(p => p.number === Number(n));
      return plan && !meetingNames.has(match) ? `“${plan.label}”` : match;
    });
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
      [key, key === 'source' ? v : visit(v)]));
    return value;
  };
  return visit(value);
}

type PassResult = { answer: unknown; warnings: string[]; review: string[] };
type ProcessUsage = { process: string; passVersion: string; model: string; durationMs: number; usage: unknown; error?: string };
export async function runPlanPass(ctx: ExplorationContext, options: ExplorationPiOptions, onEvent: (event: any) => void, progress: PlanProgress): Promise<PassResult> {
  const usage: ProcessUsage[] = [];
  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.signal, ...(options.signal ? [options.signal] : []), stop.signal]);
  let quotaError: Error | undefined;
  const quota = (error: Error) => { quotaError ??= error; stop.abort(quotaError); };
  // Usage is also captured from message_end: a provider error may reject the task rather than return its result.
  const run = async (name: string, prompt: string, opts: ExplorationPiOptions, event: (event: any) => void) => {
    const record: ProcessUsage = { process: name, passVersion: PLAN_PASS_VERSION, model: options.model, durationMs: 0, usage: null };
    usage.push(record);
    const started = performance.now();
    let sawUsage = false;
    const total: Record<string, number> = { input: 0, output: 0, cacheRead: 0 };
    try {
      const r = await ctx.pi(prompt, { ...opts, signal, onEvent: e => {
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          record.model = e.message.model ?? record.model;
          if (e.message.usage) {
            sawUsage = true;
            for (const key of Object.keys(total)) total[key] += Number(e.message.usage[key]) || 0;
            record.usage = { ...total };
          }
        }
        const limited = modelRateLimit(e);
        if (limited) quota(new Error(limited));
        onEvent(e); event(e);
      } });
      record.model = r.model ?? record.model;
      if (!sawUsage) record.usage = r.usage ?? record.usage;
      if (quotaError) throw quotaError;
      return checkCompleted(r, name === 'stage1' ? 'The plan pass' : 'The plan writer');
    } catch (error) {
      if (RATE_LIMIT.test((error as Error).message)) quota(error as Error);
      const failure = quotaError ?? error as Error;
      record.error = failure.message; throw failure;
    }
    finally { record.durationMs = Math.round(performance.now() - started); }
  };
  const scanner = new ItemScanner(['plans'], (_, p) => { progress.written++; if (typeof p.label === 'string') progress.latest = p.label; });
  let used = 0;
  try {
    const sessionDir = join(ctx.folder, 'stage1');
    const first = await run('stage1', `${PLAN_PROMPT}\n\n${PLAN_STAGE1}`, { ...options, sessionDir }, e => {
      if (e.type === 'tool_execution_start' && e.toolName === 'calculate') used++;
      // Stage 1's text is an outline, not written plans.
      if (e.type === 'tool_execution_start' || e.type === 'tool_execution_end') updatePlanProgress(progress, e, scanner);
    });
    await writeFile(join(ctx.folder, 'outline.txt'), first.text, { mode: 0o600 });
    let direct: unknown;
    try { direct = extractJson(first.text); } catch { /* An outline (or unparseable text) needs writers. */ }
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && 'plans' in direct && Array.isArray(direct.plans)) {
      progress.exact = true; progress.expected = direct.plans.length; progress.written = direct.plans.length;
      const last = direct.plans.at(-1);
      progress.latest = typeof last?.label === 'string' ? last.label : null;
      return { answer: direct, warnings: [], review: [] };
    }
    const outline = parseOutline(first.text);
    const warnings: string[] = [], review = [...outline.review];
    if (outline.plans.length || outline.deferred.length) {
      progress.exact = true; progress.expected = outline.plans.length; progress.written = 0; progress.latest = null;
    }
    if (!outline.plans.length && outline.deferred.length) return { answer: { plans: [], deferred: outline.deferred }, warnings, review };
    const sessions = (await readdir(sessionDir)).filter(f => f.endsWith('.jsonl'));
    if (sessions.length !== 1) throw new Error('The plan pass session could not be found.');
    const session = join(sessionDir, sessions[0]);
    const copyOptions = async (tag: string): Promise<ExplorationPiOptions> => {
      signal.throwIfAborted();
      const folder = join(ctx.folder, `write-${tag}`);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const copy = join(folder, basename(session));
      await copyFile(session, copy);
      // Re-attaching the input would add a second copy of it to the continued conversation.
      const { files: _files, sessionDir: _dir, ...same } = options;
      return { ...same, session: copy, signal, env: { ...options.env, CALCULATE_USED: String(used) } };
    };
    progress.phase = 'write';
    if (!outline.plans.length) {
      const r = await run('fallback', PLAN_STAGE2_FALLBACK, await copyOptions('all'), e => updatePlanProgress(progress, e, scanner));
      try { return { answer: extractJson(r.text), warnings, review }; }
      catch { throw new Error('The model\'s answer could not be read as plans.'); }
    }
    const input = (await Promise.all((options.files ?? []).map(file => readFile(resolve(ctx.cwd, file), 'utf8')))).join('\n');
    let fatal: Error | undefined;
    const results = await Promise.all(outline.plans.map(async p => {
      try {
        const r = await run(`write-p${p.number}`, planStage2(p.number), await copyOptions(`p${p.number}`), e => {
          if (e.type === 'tool_execution_start' || e.type === 'tool_execution_end') updatePlanProgress(progress, e, scanner);
        });
        const json = extractJson(r.text) as { plans?: unknown[] };
        const plan = json?.plans?.[0];
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('The writer returned no plan.');
        progress.written++; progress.latest = p.label;
        return { plan, extra: json.plans!.length - 1 };
      } catch (error) {
        const e = error as Error & { reason?: string };
        // A sibling's abort must never hide this process's provider error (or the total time limit).
        if (RATE_LIMIT.test(e.message) || e.reason === 'timeout') {
          if (!fatal || RATE_LIMIT.test(e.message)) fatal = e;
          stop.abort();
        }
        return null;
      }
    }));
    if (quotaError) throw quotaError;
    ctx.signal.throwIfAborted();
    if (fatal) throw fatal;
    const failed = outline.plans.filter((_, i) => !results[i]);
    if (failed.length === results.length) throw new Error('No plans could be written.');
    if (failed.length) warnings.push(`${failed.length} plan${failed.length === 1 ? ' could' : 's could'} not be written: ${failed.map(p => p.label).join(', ')}.`);
    results.forEach((r, i) => { if (r?.extra) review.push(`${outline.plans[i].label}: ${r.extra} extra plan(s) from its writer were ignored.`); });
    return { answer: replaceOutlineRefs({ plans: results.flatMap(r => r ? [r.plan] : []), deferred: outline.deferred }, outline.plans, input), warnings, review };
  } catch (error) { throw quotaError ?? error; }
  finally {
    try { await writeFile(join(ctx.folder, 'usage.json'), JSON.stringify(usage, null, 2), { mode: 0o600 }); }
    catch (error) { console.warn(`A plan run's usage could not be saved: ${(error as Error).message}`); }
  }
}
