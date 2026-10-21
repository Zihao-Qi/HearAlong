// The rows the Plans section shows (M7b §3, layout D1): one row per decision, with its answer line and its step line, the
// first three open and the rest folded. An answer counts as an answer only when every source it rests on checked out; an
// unchecked one is shown as unchecked. Texts are the model's row texts, whole (an over-long one is flagged, never cut).
import { freshness, type CurrentPins, type PublishedVersion } from './versions.ts';
import type { TodoState } from './todos.ts';
import type { CheckState, RunStatus } from './validate.ts';

export const SECTION_LABEL = 'Plans — sources checked, not the ideas themselves';
export const SHOWN_ROWS = 3;
export type PlanRow = {
  id: string; label: string; flags: string[];
  /** "for Vela": the verified owner only. */
  owner: string | null;
  answer: { kind: 'answer' | 'so far' | 'unchecked'; text: string } | null;
  /** The next step; "Next:" only when the row also has an answer line. Add to to-dos goes by its to-do state. */
  step: { id: string; prefix: 'Next:' | null; text: string; check: CheckState; todo: TodoState | null } | null;
  folded: boolean;
  /** "Made before the notes changed", with Plan again; null while the plan's inputs are current. Per plan, from its own origin. */
  outOfDate: string | null;
  review: number;
};
const MESSAGE: Record<RunStatus, string | null> = {
  plans: null,
  'nothing to plan': 'The meeting left no open decision to plan.',
  'all plans failed checks': 'Plans were made, but none passed the source checks. See Needs review.',
};

export function planRows(version: PublishedVersion, options: { todos?: Record<string, TodoState>; current?: CurrentPins } = {}) {
  const rows: PlanRow[] = version.plans.map((plan, i) => {
    const a = plan.answer;
    const answer = a ? { kind: a.check !== 'checked' ? 'unchecked' as const : a.complete ? 'answer' as const : 'so far' as const, text: plan.answerLine ?? a.text } : null;
    const next = plan.steps.find(s => s.kind === 'next');
    return {
      id: plan.id, label: plan.label ?? plan.question, flags: plan.rowFlags, owner: plan.owner, answer,
      step: next ? { id: next.id, prefix: answer ? 'Next:' as const : null, text: plan.stepLine ?? next.text, check: next.check, todo: options.todos?.[next.id] ?? null } : null,
      folded: i >= SHOWN_ROWS, outOfDate: options.current ? freshness(plan, options.current).label : null, review: plan.review.length,
    };
  });
  return { label: SECTION_LABEL, version: version.version, status: version.status, message: MESSAGE[version.status], rows,
    folded: Math.max(0, rows.length - SHOWN_ROWS), warnings: version.warnings };
}
