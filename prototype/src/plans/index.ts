// The plan domain of M7b (docs/design/M7b-exploration.md §2b): one module for the app and scripts/plan-probe.ts.
export { EXPLORE_INSTRUCTION, EXPLORE_PROMPT, EXPLORE_PROMPT_VERSION, PLAN_PROMPT, PLAN_PROMPT_SHA256, PLAN_PROMPT_VERSION } from './prompt.ts';
export { INPUT_LIMIT, TOO_LONG, buildPlanInput, exploreInput, notesWarnings, planRoots, type InputRefs, type LineRef, type MemoryInput, type NoteRef, type NotesLike, type PlanInput, type RootRef } from './input.ts';
export { EVIDENCE_LIMITS, EvidenceRecorder, blockHash, materialLocator, normUrl, type EvidenceItem, type EvidenceState, type Locate, type SavedEvidence } from './evidence.ts';
export { LINE_SLACK, MAX_PLANS, ROW_WORDS, checkPlans, entriesOf, wordCount, type Answer, type CheckContext, type CheckedPlan, type CheckedRun, type EvidenceEntry, type PlanPins, type Registry, type RunStatus, type Step } from './validate.ts';
export { PLANS_SCHEMA, PlanVersions, changedFiles, changedSinceRead, currentPins, freshness, loadRunPlans, materialsManifest, memoryStamp, pinRun, plansDocument, saveRunPlans, type CurrentPins, type Manifest, type PlansDocument, type PublishResult, type PublishedVersion, type RunPins } from './versions.ts';
export { PlanTodos, eligibility, payloadHash, stepPayload, todoText, type AcceptResult, type Refusal, type TodoPayload, type TodoState } from './todos.ts';
export { AutoPlanning, onManualPlan, onNotes, onSettingOff, type AutoDecision, type PlanRun } from './auto.ts';
export { SECTION_LABEL, planRows, type PlanRow } from './rows.ts';
export { activeJob, jobData, jobResult, plansPage, runView, shownJobs, type DocView, type Freshness, type KeptView, type ListedJob, type PlanJobData, type PlanJobResult, type PlanView, type PlansPage, type Progress, type RunOrigin, type RunView, type StepView } from './view.ts';
