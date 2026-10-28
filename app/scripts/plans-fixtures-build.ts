// The Plans page's fixtures (public/plans-fixtures-data.js), made through the real plan domain and the page's projection: the
// model's answers below are checked by checkPlans against evidence recorded from tool results on real files, published by
// PlanVersions, added and undone by PlanTodos in a real database, and projected by plansPage (src/plans/view.ts), so a fixture
// has exactly the shape and the states the server gives. Every state of M7b §3 and the States board has one.
// The content is invented for these fixtures (a bird-call detector study); nothing is taken from any test meeting.
// Usage: node --experimental-strip-types scripts/plans-fixtures-build.ts  (writes public/plans-fixtures-data.js;
// test/plans-fixtures.test.ts checks that the file is current, and that the fixture API keeps the domain's rules).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cooldowns } from '../src/quota.ts';
import { Explorations, type ExplorationJob } from '../src/explorations.ts';
import { Memory } from '../src/memory.ts';
import { MeetingStore } from '../src/store.ts';
import type { ToolResult } from '../src/pi-task.ts';
import type { NoteItem, Section } from '../src/notes.ts';
import {
  EvidenceRecorder, PlanTodos, PlanVersions, buildPlanInput, checkPlans, currentPins, materialLocator, memoryStamp, planRoots, plansDocument,
  plansPage, type ListedJob, type PlanPins, type PlansDocument, type PlansPage, type Progress, type PublishedVersion,
} from '../src/plans/index.ts';

/** The fixtures' clock: every time in them is relative to this; the fixture API moves them to now. */
export const T0 = Date.UTC(2031, 9, 8, 15, 40, 0);
const MIN = 60_000;
export const PROJECT = { id: 'prj-birdcalls', name: 'Bird-call detector', planAfterNotes: false };
export const OTHER = { id: 'prj-fieldacoustics', name: 'Field acoustics', planAfterNotes: false };

// ---------- The meeting: its transcript lines, its notes and the materials ----------

export const LINES = [
  'Let us start with the forest site, the recall there looked lower than on the training sites.',
  'The paper still says we keep ninety percent recall everywhere, and I do not think that is true any more.',
  'Could the drop come from the forest recorders? I think they record at a lower sample rate.',
  'Marta said she can label the new forest clips, but only in November.',
  'We need about two hundred labelled clips for a fair test on that site.',
  'Did we already try noise augmentation? I remember rain and wind in one of the runs.',
  'Yes, run fourteen had rain and wind noise, that is the baseline now.',
  'How many GPU hours do we have left before the December deadline?',
  'Nobody knows, the allocation changed in November.',
  'The ecology partners keep asking whether we can tell alarm calls from song.',
  'Some labels mention alarm calls in the notes field, but I never counted them.',
  'Also, who is booking the field van for next week?',
];
const note = (section: Section, text: string, lines: number[], owner: string | null = null): NoteItem =>
  ({ text, cites: lines.map(n => `seg${n}`), startMs: (lines[0] - 1) * 30_000, quote: '', quoteIn: 'corrected', section, ...(section === 'actions' ? { owner } : {}) });
/** N1–N4 open questions, N5–N9 action items, N10 a decision, N11 the summary; S1–S12 the lines. */
function meetingNotes(nothing = false) {
  const sources = Object.fromEntries(LINES.map((text, i) => [`seg${i + 1}`, { startMs: i * 30_000, endMs: i * 30_000 + 4000, text, originalText: text, revision: 0 }]));
  if (nothing) {
    return { title: 'Detector check-in', sources, notes: { suggestedTitle: null, otherMatters: [], needsReview: [], otherTalk: [], openQuestions: [], decisions: [],
      actions: [note('actions', 'Send the slides to Marta.', [4], 'Marta'), note('actions', 'Book the field van for next week.', [12])],
      summary: [note('summary', 'Recall at the forest site is lower than at the training sites.', [1])] } };
  }
  return { title: 'Detector check-in', sources, notes: {
    suggestedTitle: null, otherMatters: [], needsReview: [], otherTalk: [],
    openQuestions: [
      note('openQuestions', 'Can Section 4 still claim 90% recall at every site?', [2]),
      note('openQuestions', 'Is the lower forest recall caused by the recorders’ sample rate?', [3]),
      note('openQuestions', 'Did earlier runs already try noise augmentation?', [6]),
      note('openQuestions', 'Should the detector tell alarm calls apart from song?', [10]),
    ],
    actions: [
      note('actions', 'Marta labels 200 forest clips in November.', [4, 5], 'Marta'),
      note('actions', 'Find out how many GPU hours are left before the December deadline.', [8]),
      note('actions', 'Book the field van for next week.', [12]),
      note('actions', 'Count the labels that mention alarm calls.', [11]),
      note('actions', 'Make a poster for the lab open day.', [12]),
    ],
    decisions: [note('decisions', 'Run 14 with rain and wind noise stays the baseline.', [7])],
    summary: [note('summary', 'Recall at the forest site is lower than at the training sites.', [1])],
  } };
}
/** Files whose cited line is at the line number the plans give; the rest is filler. */
const FILES: Record<string, [number, string]> = {
  'paper/section4.tex': [212, 'We find that the detector maintains a recall above 90% across all recording sites, including the newly added forest transects.'],
  'results/per_site.csv': [7, 'forest_north, 412 files, recall 0.81, precision 0.77, recorded at 22050 Hz'],
  'data/README.md': [41, 'Forest transect units (AudioMoth v1.1) were configured at 22.05 kHz to save card space.'],
  'runs/run14/config.yaml': [18, '# Run 14 adds rain and wind noise at 0 to 10 dB; every later run keeps it as the baseline.'],
  'labels/SCHEMA.md': [12, 'One label per species per clip. Call type is not a field; annotators may add it under notes.'],
  'logs/train_run22.txt': [88, 'epoch 31 | train_loss 0.214 | val_recall 0.83 | lr 3.0e-4 | bn_momentum 0.10'],
  'runs/run22/config.yaml': [9, 'freeze_bn_after_epoch: 30  # keep batch norm statistics fixed after epoch 30'],
  'results/resample_check.md': [3, 'Recall on 10 forest files: 0.80 as recorded, 0.88 after resampling to 48 kHz.'],
};
const fileLines = (path: string) => {
  const [at, text] = FILES[path];
  return Array.from({ length: at + 6 }, (_, i) => i + 1 === at ? text : `${path.split('/').pop()} line ${i + 1}`);
};
const PAGES: Record<string, string> = {
  'https://example.org/field-guide/alarm-calls': 'Field guide. Alarm calls carry more information about predator presence than song does, so partners record them apart from song.',
  'https://example.org/benchmarks/birdcalls-2022': 'A benchmark of bird-call detectors at several sample rates and recorder types.',
};
const SCRIPTS: Record<number, [string, string]> = {
  1: ["import soundfile as sf, glob, collections\nrates = collections.Counter(sf.info(p).samplerate for p in glob.glob('data/forest_north/*.wav'))\nprint('forest', dict(rates))\nrates = collections.Counter(sf.info(p).samplerate for p in glob.glob('data/train/*/*.wav'))\nprint('train', dict(rates))",
    'forest {22050: 412}\ntrain {48000: 3184}'],
};
const EXPLORE_SCRIPT: [string, string] = ["import detector, resample\nfiles = detector.labelled('forest_north')[:10]\nfor name, fn in [('as recorded', lambda a: a), ('48 kHz', lambda a: resample.to(a, 48000))]:\n    print(name, detector.recall(files, transform=fn))",
  'as recorded 0.80\n48 kHz 0.88'];

// ---------- The model's answers (prompt v1.7's form) ----------

const file = (path: string, quote: string) => ({ type: 'file', path: `R1/${path}`, line: FILES[path][0], quote });
const said = (n: number, quote: string) => ({ type: 'transcript', ref: `S${n}`, quote });
const web = (url: string, quote: string) => ({ type: 'web', url, quote });
const k = (id: string, text: string, source: unknown) => ({ id, text, source });
const LONG_STEP = ['Resample ten labelled forest files to 48 kHz with the resampler of the training pipeline, keeping the original files untouched in their own folder.',
  'Rerun the detector on the resampled files and on the same ten files as recorded, with the thresholds of run 14, and write both recall numbers into a small table.',
  'Then compare the two columns site by site, note any file whose result changes by more than five points, and keep the scripts and the table in the scratch folder for the next meeting.',
  'If the resampled files score better, list which recorders need a new configuration before the November field trip.'].join(' ');
function mainAnswer(options: { longStep?: boolean } = {}) {
  return { plans: [
    { label: 'Recall claim in Section 4', answerLine: 'No: the forest site reaches 0.81 recall; 90% holds only on the training sites.',
      stepLine: 'Rewrite the recall sentence from the per-site table already in results.',
      question: 'Can Section 4 say the detector keeps 90% recall at the new forest site?', from: ['N1', 'S2'], owner: null,
      stateNow: [
        k('k1', 'The draft claims 90% recall at every site.', file('paper/section4.tex', 'the detector maintains a recall above 90% across all recording sites')),
        k('k2', 'The per-site table shows 0.81 recall at the forest site.', file('results/per_site.csv', 'forest_north, 412 files, recall 0.81, precision 0.77')),
        k('k3', 'The meeting doubted the claim.', said(2, 'The paper still says we keep ninety percent recall everywhere')),
      ],
      answer: { text: 'No. The per-site table gives 0.81 recall at the forest site. The 90% figure holds only for the three training sites.', complete: true, open: null, basis: ['k1', 'k2'] },
      next: { text: 'Replace the sentence in section4.tex that claims 90% recall at every site with the per-site numbers from results/per_site.csv, and say that the forest site is below it.', basis: ['k1', 'k2'] },
      followOn: [{ if: 'the advisor wants one headline number', then: 'report the median over sites and give the range beside it', basis: ['k2'] }],
      changeIf: 'A re-run at the forest site with resampled audio that brings recall back above 0.9.', checks: [], waitingOn: [], decideAfter: [],
      further: { state: 'ready', what: 'Draft the replacement paragraph with the table.', why: 'the wording is the open part', minutes: 10 } },
    { label: 'Forest sample rate', answerLine: 'Possibly: forest files are 22.05 kHz, training used 48 kHz; the effect is untested.',
      stepLine: 'Resample ten forest files to 48 kHz and rerun the detector on them.',
      question: 'Is the lower forest recall caused by the forest recorders’ lower sample rate?', from: ['N2', 'S3'], owner: null,
      stateNow: [k('k4', 'The forest recorders write 22.05 kHz files; training used 48 kHz.', file('data/README.md', 'Forest transect units (AudioMoth v1.1) were configured at 22.05 kHz'))],
      checks: [{ id: 'c1', run: 1, showed: 'Of the 412 forest files, all are 22.05 kHz; every training file is 48 kHz.' }],
      answer: { text: 'Possibly. Every forest file is 22.05 kHz and every training file is 48 kHz, so the detector never saw this rate. Whether that explains the drop is not tested.', complete: false, open: 'Whether resampling restores recall.', basis: ['k4', 'c1', 'k2'] },
      next: { text: options.longStep ? LONG_STEP : 'Resample ten labelled forest files to 48 kHz with the training pipeline’s resampler, rerun the detector on them, and compare recall with the same ten files as recorded.', basis: ['k4', 'c1', 'k2'] },
      followOn: [{ if: 'recall rises to the training sites’ level', then: 'resample all forest files and report both numbers', basis: [] },
        { if: 'recall stays near 0.81', then: 'treat the site itself as the cause and wait for Marta’s labels', basis: [] }],
      changeIf: 'The resampled files scoring no better than the originals.', waitingOn: [], decideAfter: [],
      further: { state: 'ready', what: 'Run the ten-file comparison in the scratch folder.', why: 'it settles the cause', minutes: 15 } },
    { label: 'Labels for the forest site', answerLine: null, stepLine: 'Send Marta the 200-clip list and the labelling guide; she labels them.',
      question: 'Who labels the 200 forest clips needed for a fair test, and when?', from: ['N5'], owner: 'Marta',
      stateNow: [k('k5', 'Marta offered to label the forest clips, in November.', said(4, 'Marta said she can label the new forest clips')),
        k('k6', 'A fair test needs about 200 labelled clips.', said(5, 'We need about two hundred labelled clips for a fair test'))],
      answer: null, next: { text: 'Send Marta the list of 200 forest clips (stratified by hour) and the labelling guide. She labels them in November and returns the CSV in the usual format.', basis: ['k5', 'k6'] },
      followOn: [], changeIf: 'An existing labelled forest set turning up.', checks: [], waitingOn: ['Marta’s time in November'], decideAfter: [],
      further: { state: 'blocked', what: 'Score the detector on the labelled clips.', why: 'after Marta’s labels arrive', minutes: null } },
    { label: 'Noise augmentation', answerLine: 'Yes: run 14 added rain and wind noise at 0–10 dB; it is the current baseline.', stepLine: null,
      question: 'Did the earlier runs already try noise augmentation?', from: ['N3', 'N10'], owner: null,
      stateNow: [k('k7', 'Run 14 used rain and wind noise at 0–10 dB and is the baseline.', file('runs/run14/config.yaml', 'Run 14 adds rain and wind noise at 0 to 10 dB')),
        k('k8', 'The meeting confirmed run 14 is the baseline.', said(7, 'run fourteen had rain and wind noise, that is the baseline now'))],
      answer: { text: 'Yes. Run 14 added rain and wind noise at 0 to 10 dB signal-to-noise ratio, and every later run uses it as the baseline.', complete: true, open: null, basis: ['k7', 'k8'] },
      next: null, followOn: [], changeIf: 'A later run that dropped the augmentation.', checks: [], waitingOn: [], decideAfter: [], further: null },
    { label: 'GPU hours left before the December deadline for the three planned ablations', answerLine: null,
      stepLine: 'Ask the lab manager for the remaining GPU hours on the shared cluster before planning the three ablations, because the November allocation changed and nobody at the meeting knew the new number.',
      question: 'How many GPU hours are left for the ablations before the December deadline?', from: ['N6'], owner: null,
      stateNow: [k('k9', 'The November cluster allocation changed and nobody knew the new number.', said(9, 'Nobody knows, the allocation changed in November'))],
      answer: null, next: { text: 'Ask the lab manager for the remaining GPU hours on the shared cluster for November and December, then size the three ablations to fit.', basis: ['k9'] },
      followOn: [], changeIf: 'The allocation being larger than last term’s.', checks: [], waitingOn: [], decideAfter: ['Which of the three ablations to drop if the hours are short.'], further: null },
    { label: 'Alarm calls apart from song', answerLine: 'Partners want it; current labels keep one class per species, so they cannot separate them.',
      stepLine: 'Count the existing labels that mention alarm calls in their notes field.',
      question: 'Should the detector tell alarm calls apart from song?', from: ['N4', 'N8'], owner: null,
      stateNow: [k('k10', 'The ecology partners asked for alarm calls apart from song.', said(10, 'The ecology partners keep asking whether we can tell alarm calls from song')),
        k('k11', 'The label schema has one class per species; alarm calls are only in a free-text notes field.', file('labels/SCHEMA.md', 'Call type is not a field; annotators may add it under notes')),
        k('k12', 'The partners’ field guide says alarm calls carry the most behaviour information.', web('https://example.org/field-guide/alarm-calls', 'Alarm calls carry more information about predator presence than song does'))],
      answer: { text: 'The ecology partners want it, and their field guide says alarm calls carry the most behaviour information. The current labels keep one class per species, so the detector cannot separate them yet.', complete: false, open: 'Whether there are enough labelled alarm calls to train on.', basis: ['k10', 'k11', 'k12'] },
      next: { text: 'Count the existing labels whose notes field mentions an alarm call, per species, with a short script over labels/*.csv.', basis: ['k11'] },
      followOn: [{ if: 'there are more than 300 such labels', then: 'plan a second output head for alarm calls', basis: [] },
        { if: 'there are fewer', then: 'keep one class and list alarm calls as future work in the paper', basis: [] }],
      changeIf: 'The partners accepting call type as a later extension.', checks: [], waitingOn: [], decideAfter: [],
      further: { state: 'ready', what: 'Count the labels and estimate the class balance.', why: 'it decides the second head', minutes: 15 } },
  ], deferred: [{ item: 'N7', why: 'Routine logistics; it needs no plan.' }] };
}
function mixedAnswer() {
  return { plans: [
    { label: 'Recall claim in Section 4', answerLine: 'No: the forest site reaches 0.81 recall; 90% holds only on the training sites.', stepLine: 'Rewrite the recall sentence from the per-site table already in results.',
      question: 'Can Section 4 say the detector keeps 90% recall at the new forest site?', from: ['N1'], owner: null,
      stateNow: [k('k1', 'The draft claims 90% recall at every site.', file('paper/section4.tex', 'the detector maintains a recall above 90% across all recording sites')),
        k('k2', 'The per-site table shows 0.81 recall at the forest site.', file('results/per_site.csv', 'forest_north, 412 files, recall 0.81, precision 0.77'))],
      answer: { text: 'No. The per-site table gives 0.81 recall at the forest site.', complete: true, open: null, basis: ['k1', 'k2'] },
      next: { text: 'Replace the sentence in section4.tex that claims 90% recall at every site with the per-site numbers.', basis: ['k1', 'k2'] },
      followOn: [], changeIf: 'A re-run at the forest site above 0.9 recall.', checks: [], waitingOn: [], decideAfter: [], further: null },
    { label: 'Batch-norm drift', answerLine: null, stepLine: 'Rerun run 22 with batch norm frozen from epoch 30 and compare forest recall.',
      question: 'Did batch-norm drift cause the late drop in forest recall?', from: ['N2', 'S99'], owner: null,
      stateNow: [k('k3', 'Batch-norm statistics drifted after epoch 30 in run 22.', file('logs/train_run22.txt', 'bn running_var drifted by 38% between epoch 30 and 60 on the forest split')),
        k('k4', 'Run 22 froze batch norm after epoch 30.', file('runs/run22/config.yaml', 'keep batch norm statistics fixed after epoch 30'))],
      answer: null, next: { text: 'Rerun run 22 with batch norm frozen from epoch 30, and compare forest validation recall at epoch 60 with the original run.', basis: ['k3', 'k4'] },
      followOn: [{ if: 'recall holds with frozen statistics', then: 'freeze batch norm in every later run', basis: ['k3'] }],
      changeIf: 'Recall dropping even with frozen statistics.', checks: [], waitingOn: [], decideAfter: [],
      further: { state: 'ready', what: 'Find the drift in the training logs.', why: 'the log is long', minutes: 20 } },
    { label: 'Sample rate for the paper', answerLine: '16 kHz input would lose most high-pitched calls, so 48 kHz stays.', stepLine: null,
      question: 'Can the paper move to 16 kHz input to save compute?', from: ['N2'], owner: null,
      stateNow: [k('k5', 'A 2022 benchmark reports that 16 kHz input loses most high-pitched calls.', web('https://example.org/benchmarks/birdcalls-2022', 'downsampling to 16 kHz removed most energy above 8 kHz, where warblers call'))],
      checks: [{ id: 'c1', run: 2, showed: 'The forest files are 22.05 kHz.' }],
      answer: { text: 'No: a published benchmark found that 16 kHz input loses most calls above 8 kHz.', complete: true, open: null, basis: ['k5'] },
      next: null, followOn: [], changeIf: 'A test on this data showing no loss at 16 kHz.', waitingOn: [], decideAfter: [], further: { state: 'ready', what: 'Test 16 kHz on ten files.', why: 'cheap', minutes: 30 } },
    { label: 'Field van', question: 'Who books the field van for next week?', from: ['N44'], next: { text: 'Book the van', basis: [] } },
  ], deferred: [{ item: 'N3: noise augmentation', why: 'Answered in the meeting.' }, { item: 'N4', why: 'Waits for the label count.' }, { item: 'N5', why: 'Marta has it.' },
    { item: 'N6', why: 'The lab manager answers it.' }, { item: 'N7', why: 'Routine logistics.' }, { item: 'N8', why: 'Part of the label count.' }, { item: 'N12', why: '' },
    { item: 'Project-memory items outside this meeting', why: 'Outside this meeting’s scope.' }] };
}
const allFailedAnswer = () => ({ plans: [
  { label: 'Recall claim', question: 'Can Section 4 say the detector keeps 90% recall at the forest site?', from: ['N40'], next: { text: 'Rewrite it', basis: [] } },
  { label: 'Sample rate', question: 'Is the forest drop caused by the lower sample rate?', from: [], next: { text: 'Resample', basis: [] } },
  { label: 'Labels', question: 'Who labels the forest clips?', from: ['S40'], next: { text: 'Ask Marta', basis: [] } },
], deferred: [] });
function exploredAnswer() {
  return { plans: [{ label: 'Forest sample rate', answerLine: 'Mostly: resampling ten forest files to 48 kHz lifts recall from 0.80 to 0.88.',
    stepLine: 'Resample all forest files to 48 kHz and report both recall numbers.',
    question: 'Is the lower forest recall caused by the forest recorders’ lower sample rate?', from: ['N2', 'S3'], owner: null,
    stateNow: [k('k1', 'Resampled to 48 kHz, the ten forest files reach 0.88 recall (0.80 as recorded).', file('results/resample_check.md', 'Recall on 10 forest files: 0.80 as recorded, 0.88 after resampling'))],
    checks: [{ id: 'c1', run: 1, showed: 'Recall on ten forest files: 0.80 as recorded, 0.88 resampled to 48 kHz.' }],
    answer: { text: 'Mostly. On ten labelled forest files, resampling to 48 kHz raises recall from 0.80 to 0.88. The rest of the gap to 0.9 is still open.', complete: false, open: 'What explains the remaining gap.', basis: ['k1', 'c1'] },
    next: { text: 'Resample all 412 forest files to 48 kHz with the training resampler, rerun the detector, and report recall as recorded and resampled in the per-site table.', basis: ['k1', 'c1'] },
    followOn: [], changeIf: 'The full set not reproducing the ten-file gain.', waitingOn: [], decideAfter: [], further: null }], deferred: [] };
}

// ---------- Building: the domain on a temporary folder ----------

let calls = 0;
const tool = (name: string, args: unknown, text: string, extra: Partial<ToolResult> = {}): ToolResult => ({ id: `call-${++calls}`, name, args, text, isError: false, ...extra });
type Run = { run: string; kind?: 'plan' | 'explore'; base: number | null; plan?: string; at: number; pins?: Partial<PlanPins>; nothing?: boolean;
  python?: [number, [string, string]][]; files?: string[]; pages?: string[]; publish?: boolean; warnings?: string[] };

/**
 * One meeting's world: its own database (memory, to-dos) and published versions, so one fixture's to-dos never change another's
 * memory stamp. `run` is one run as PlanJobs runs it: input, evidence recorded from tool results, checks, publication.
 */
async function world(directory: string, meetingId: string, roots: ReturnType<typeof planRoots>, rootPath: string) {
  await mkdir(directory, { recursive: true });
  let now = T0 - 120 * MIN;
  const clock = () => now;
  const store = new MeetingStore(directory);
  const memory = new Memory(store, clock);
  const todos = new PlanTodos(store, memory, clock);
  const versions = new PlanVersions(directory, clock);
  let ops = 0;
  const op = () => `fixture-op-${meetingId}-${String(++ops).padStart(4, '0')}`;
  async function run(raw: unknown, meta: Run) {
    now = meta.at;
    const input = buildPlanInput({ notes: meetingNotes(meta.nothing), roots });
    if ('refused' in input) throw new Error(input.refused);
    const folder = join(directory, 'runs', meta.run);
    await mkdir(folder, { recursive: true });
    const evidence = new EvidenceRecorder(folder, { cwd: folder, locate: materialLocator({ roots: input.refs.roots }) });
    for (const path of meta.files ?? Object.keys(FILES)) {
      const lines = fileLines(path);
      await evidence.record(tool('read', { path: join(rootPath, path), offset: 1, limit: lines.length }, lines.join('\n')));
    }
    for (const url of meta.pages ?? Object.keys(PAGES)) await evidence.record(tool('fetch_content', { url }, PAGES[url], { structured: { urls: [{ url, title: 'A page', content: PAGES[url] }] } }));
    for (const [n, [script, output]] of meta.python ?? []) {
      await evidence.record(tool('run_python', { code: script }, output, { details: { runNumber: n, script: `run-${n}.py`, status: 'exit 0', stdout: output, stderr: '' } }));
    }
    const pins: PlanPins = { notesVersion: 3, notesWarnings: [], memoryStamp: memoryStamp(memory, PROJECT.id), manifest: 'a7c2', project: PROJECT.id, ...meta.pins };
    const checked = checkPlans(raw, { run: meta.run, refs: input.refs, evidence: await evidence.read(), pins });
    const doc: PlansDocument = plansDocument(checked, { kind: meta.kind ?? 'plan', base: meta.base, plan: meta.plan ?? null, createdAt: meta.at, finished: true, evidenceComplete: true,
      pins: { ...pins, materials: { roots: [], files: {}, complete: true, digest: pins.manifest } }, warnings: meta.warnings });
    if (meta.publish === false) return { doc, version: null };
    const result = await versions.publish(meetingId, doc);
    if (!('published' in result)) throw new Error(`${meetingId} ${meta.run}: ${JSON.stringify(result)}`);
    return { doc, version: result.published };
  }
  const all = async () => Promise.all((await versions.list(meetingId)).map(async n => (await versions.get(meetingId, n)) as PublishedVersion));
  return { meetingId, store, memory, todos, versions, run, op, all };
}

const job = (meetingId: string, id: string, over: Partial<ListedJob> = {}): ListedJob => ({
  id, meetingId, kind: 'plan', key: 'plan', state: 'done', createdAt: T0 - 10 * MIN, startedAt: T0 - 10 * MIN, finishedAt: T0 - 7 * MIN, error: null, stopped: null,
  limitMs: 5 * MIN, runLimitMs: 15 * MIN, worker: null, data: { origin: 'manual', opId: null, base: null, plan: null, label: null, notesVersion: null }, result: null, waiting: null, ...over });

/** The fixture states, and each state's world, so the contract test can run the same operations through PlanTodos. */
export async function buildFixtures(directory: string) {
  process.env.TZ = 'UTC'; // the runtime's waiting text names a clock time
  calls = 0;
  const materials = join(directory, 'bird-call-detector');
  for (const path of Object.keys(FILES)) {
    await mkdir(dirname(join(materials, path)), { recursive: true });
    await writeFile(join(materials, path), fileLines(path).join('\n'));
  }
  const rootPath = await realpath(materials);
  const roots = planRoots([{ id: 'root-birdcalls', scope: `project:${PROJECT.id}`, path: rootPath, kind: 'folder', label: 'bird-call-detector' }]);
  const make = (name: string) => world(join(directory, name), name, roots, rootPath);
  const python = { python: [[1, SCRIPTS[1]]] as [number, [string, string]][] };

  // The main meeting: version 1, Marta's step added from it; version 2 (Plan again) with its first step added, and the GPU
  // step added and undone.
  const main = await make('fx-main');
  const v1 = (await main.run(mainAnswer(), { run: 'r-4a20', base: null, at: T0 - 50 * MIN, ...python })).version!;
  main.todos.accept(v1, 'p3.s1', { opId: main.op(), expect: 0, project: PROJECT.id });
  const v2 = (await main.run(mainAnswer(), { run: 'r-5e1c', base: 1, at: T0 - 3 * MIN, ...python })).version!;
  main.todos.accept(v2, 'p1.s1', { opId: main.op(), expect: 0, project: PROJECT.id });
  main.todos.accept(v2, 'p5.s1', { opId: main.op(), expect: 0, project: PROJECT.id });
  main.todos.undo(v2, 'p5.s1', { opId: main.op(), expect: 1, project: PROJECT.id });
  const mainJobs = (id: string) => [job(id, 'r-5e1c', { createdAt: T0 - 6 * MIN, startedAt: T0 - 6 * MIN, finishedAt: T0 - 3 * MIN, result: { outcome: 'published', version: 2 } }),
    job(id, 'r-4a20', { createdAt: T0 - 54 * MIN, startedAt: T0 - 54 * MIN, finishedAt: T0 - 50 * MIN, result: { outcome: 'published', version: 1 } })];
  // Explore further on "Forest sample rate" (version 3), and a Plan again based on version 2 that finished after it: kept aside.
  const explored = await make('fx-explored');
  await explored.run(mainAnswer(), { run: 'r-4a20', base: null, at: T0 - 52 * MIN, ...python });
  const e2 = (await explored.run(mainAnswer(), { run: 'r-5e1c', base: 1, at: T0 - 50 * MIN, ...python })).version!;
  explored.todos.accept(e2, 'p1.s1', { opId: explored.op(), expect: 0, project: PROJECT.id });
  await explored.run(exploredAnswer(), { run: 'r-e902', kind: 'explore', base: 2, plan: 'p2', at: T0 - 4 * MIN, python: [[1, EXPLORE_SCRIPT]], files: ['results/resample_check.md'], pages: [] });
  const exploredJobs = [job(explored.meetingId, 'r-e902', { kind: 'explore', key: 'p2', limitMs: 20 * MIN, createdAt: T0 - 18 * MIN, startedAt: T0 - 18 * MIN, finishedAt: T0 - 4 * MIN,
    data: { origin: 'manual', opId: null, base: 2, plan: 'p2', label: 'Forest sample rate', notesVersion: null }, result: { outcome: 'published', version: 3 } }), ...mainJobs(explored.meetingId)];
  const kept = (await explored.run(mainAnswer(), { run: 'r-k3p7', base: 2, at: T0 - MIN, ...python, publish: false })).doc;
  // Mixed evidence, nothing to plan, all failed, a step too long for a to-do, plans with no project.
  const mixed = await make('fx-mixed');
  await mixed.run(mixedAnswer(), { run: 'r-77b0', base: null, at: T0 - 6 * MIN, pins: { notesWarnings: [
    'Missing speech: 12:40–13:10.', '2 audio chunk(s) were still being transcribed when the notes were written.',
    '3 line(s) had not been checked for misheard terms.', 'The transcript changed after the notes were written.',
  ] }, warnings: ['The materials changed during this run (R1/paper/section4.tex).', 'Quick checks were off for this run: Python unavailable.',
    '1 older project-memory item was left out to fit.'] });
  const nothing = await make('fx-nothing');
  await nothing.run({ plans: [], deferred: [{ item: 'N1', why: 'Already a clear action item with its owner.' }, { item: 'N2', why: 'Routine scheduling.' }] },
    { run: 'r-0a11', base: null, at: T0 - MIN, nothing: true });
  const failed = await make('fx-failed');
  await failed.run(allFailedAnswer(), { run: 'r-3c9d', base: null, at: T0 - 2 * MIN });
  const refused = await make('fx-refused');
  await refused.run(mainAnswer({ longStep: true }), { run: 'r-5e1c', base: null, at: T0 - 3 * MIN, ...python });
  const none = await make('fx-none');
  await none.run(mainAnswer(), { run: 'r-5e1c', base: null, at: T0 - 3 * MIN, pins: { memoryStamp: null, project: null }, ...python });
  const idle = await make('fx-idle');

  // ---------- The states, as GET …/plans gives them ----------

  const cooldowns = new Cooldowns(() => T0);
  let recording: string | null = null, own: string | null = null;
  const runtime = new Explorations({ directory: join(directory, 'runtime'), clock: () => T0, cooldowns, recording: () => recording, meetingWork: () => own });
  const waitingFor = (meetingId: string, why: 'recording' | 'notes' | 'quota') => {
    recording = why === 'recording' ? 'the recording to end' : null;
    own = why === 'notes' ? 'the notes' : null;
    if (why === 'quota') cooldowns.hit('model', 'notes', 25 * MIN);
    const reason = runtime.waitingFor(job(meetingId, 'r-wait', { state: 'waiting' }));
    recording = own = null;
    return reason;
  };
  const progress: Record<string, Progress> = { 'r-run1': { files: 0, pages: 3, checks: 1 }, 'r-run2': { files: 6, pages: 0, checks: 1 } };
  type World = Awaited<ReturnType<typeof make>>;
  const page = async (w: World, options: { project?: typeof PROJECT | null; jobs?: ListedJob[]; notesVersion?: number; manifest?: string; kept?: PlansDocument; version?: number } = {}): Promise<PlansPage> => {
    const project = options.project === undefined ? PROJECT : options.project;
    const list = (await w.all()).filter(v => options.version === undefined || v.version <= options.version);
    const latest = list.at(-1);
    const current = latest ? currentPins({ notesVersion: options.notesVersion ?? 3, manifest: options.manifest ?? 'a7c2', memory: w.memory, project: project?.id ?? null,
      meetingId: w.meetingId, todos: w.todos, versions: list }) : null;
    return plansPage({ enabled: true, notes: { version: options.notesVersion ?? 3, at: T0 - 40 * MIN }, project, projectName: id => [PROJECT, OTHER].find(p => p.id === id)?.name ?? null,
      versions: list, todos: latest ? w.todos.states(latest, project?.id ?? null) : {}, current, jobs: options.jobs ?? [],
      progress: id => progress[id] ?? { files: 0, pages: 0, checks: 0 }, kept: options.kept ?? null });
  };
  const running = (meetingId: string, id: string) => job(meetingId, id, { state: 'running', createdAt: T0 - MIN, startedAt: T0 - MIN, finishedAt: null });
  const waiting = (meetingId: string, why: 'recording' | 'notes' | 'quota', origin: 'auto' | 'manual') =>
    job(meetingId, 'r-wait', { state: 'waiting', createdAt: T0, startedAt: null, finishedAt: null, waiting: waitingFor(meetingId, why),
      data: { origin, opId: null, base: null, plan: null, label: null, notesVersion: origin === 'auto' ? 3 : null } });
  const I = idle.meetingId, M = main.meetingId, E = explored.meetingId;
  /** Each state's page, its world, and what the fixture API needs besides (the next to-do id; a refusal on Add). */
  const states: Record<string, { page: PlansPage; extra: Record<string, unknown>; world: World; project: typeof PROJECT | null }> = {};
  const add = async (name: string, w: World, options: Parameters<typeof page>[1] = {}, extra: Record<string, unknown> = {}) => {
    const list = await w.all();
    const history = await Promise.all(list.map(async v => (await page(w, { ...options, jobs: [], version: v.version })).current));
    const acceptances = (w.store.db.prepare(`SELECT a.version, a.step, a.generation, a.project, a.todo, a.payload,
      a.aliasOf IS NOT NULL AS alias, b.undoneBy IS NULL AS active FROM plan_acceptances a JOIN memory_batches b ON b.id=a.batch ORDER BY a.createdAt, a.rowid`).all() as
      { version: number; step: string; generation: number; project: string; todo: string; payload: string; alias: number; active: number }[])
      .map(a => ({ ...a, payload: JSON.parse(a.payload), alias: Boolean(a.alias), active: Boolean(a.active), batch: `fixture-seed-${a.project}-${a.todo}` }));
    states[name] = { page: await page(w, options), world: w, project: options.project === undefined ? PROJECT : options.project,
      // Historical versions and acceptance rows let the browser stand-in enforce the same rules after a publication too.
      extra: { nextTodo: w.memory.items(PROJECT.id).length + 1, history, acceptances,
        originProjects: Object.fromEntries(list.flatMap(v => v.plans.map(p => [p.origin.run, p.originPins.project]))), ...extra } };
  };
  await add('idle', idle);
  await add('running', idle, { jobs: [running(I, 'r-run1')] });
  await add('waiting-recording', idle, { jobs: [waiting(I, 'recording', 'auto')] });
  await add('waiting-notes', idle, { jobs: [waiting(I, 'notes', 'manual')] });
  await add('waiting-quota', idle, { jobs: [waiting(I, 'quota', 'manual')] });
  await add('plans', main, { jobs: mainJobs(M) });
  await add('replanning', main, { jobs: [running(M, 'r-run2'), ...mainJobs(M)] });
  await add('mixed', mixed, { jobs: [job(mixed.meetingId, 'r-77b0', { result: { outcome: 'published', version: 1 } })] });
  await add('nothing', nothing);
  await add('all-failed', failed);
  await add('stopped', idle, { jobs: [job(I, 'r-stop', { state: 'stopped', stopped: 'time limit', error: 'Stopped at the time limit (5 min).', finishedAt: T0 - 2 * MIN })] });
  await add('closed', idle, { jobs: [job(I, 'r-stop', { state: 'interrupted', stopped: 'crash', error: 'The app stopped before this run finished.', finishedAt: T0 - 28 * MIN })] });
  await add('failed', main, { jobs: [job(M, 'r-fail', { state: 'failed', error: 'The model\'s answer could not be read as plans.', createdAt: T0 - 2 * MIN, finishedAt: T0 - MIN }), ...mainJobs(M)] });
  await add('stale', main, { jobs: mainJobs(M), notesVersion: 4 });
  await add('stale-materials', main, { jobs: mainJobs(M), manifest: '19be' });
  await add('explored', explored, { jobs: exploredJobs });
  await add('explore-stopped', explored, { jobs: [job(E, 'r-ex2', { kind: 'explore', key: 'p6', state: 'stopped', stopped: 'time limit', limitMs: 20 * MIN,
    error: 'Stopped at the time limit (20 min).', createdAt: T0 - 22 * MIN, startedAt: T0 - 22 * MIN, finishedAt: T0 - 2 * MIN,
    data: { origin: 'manual', opId: null, base: 3, plan: 'p6', label: 'Alarm calls apart from song', notesVersion: null } }), ...exploredJobs] });
  await add('newer', explored, { kept, jobs: [job(E, 'r-k3p7', { createdAt: T0 - 5 * MIN, startedAt: T0 - 5 * MIN, finishedAt: T0 - MIN, result: { outcome: 'kept', newest: 3 } }), ...exploredJobs] });
  // A step too long for a to-do; and on Add on the last plan, the meeting turns out to have moved to another project.
  await add('refused', refused, {}, { refuse: { step: 'p6.s1', status: 409, code: 'other project', error: 'These plans were made in another project. Plan again to add steps here.' },
    after: await page(refused, { project: OTHER }) });
  await add('moved', main, { jobs: mainJobs(M), project: OTHER });
  await add('no-project', none, { project: null });
  await runtime.close();
  const worlds = [main, explored, mixed, nothing, failed, refused, none, idle];
  return {
    /** What public/plans-fixtures-data.js holds: per state, the page and the fixture API's extras. */
    data: Object.fromEntries(Object.entries(states).map(([name, s]) => [name, { page: s.page, extra: s.extra }])),
    states, close() { for (const w of worlds) w.store.close(); },
  };
}

/** The data module the fixture API imports. One state per line, so a change shows as a change of that state. */
export function fixturesModule(states: Record<string, unknown>) {
  return ['// Generated by scripts/plans-fixtures-build.ts through the real plan domain and the page\'s projection (src/plans/view.ts).',
    '// Do not edit: run the script again. test/plans-fixtures.test.ts checks that this file is current.',
    `export const T0 = ${T0};`, 'export const STATES = {', ...Object.entries(states).map(([name, state]) => `  ${JSON.stringify(name)}: ${JSON.stringify(state)},`), '};', ''].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-plans-fixtures-'));
  try {
    const built = await buildFixtures(directory);
    built.close();
    const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'plans-fixtures-data.js');
    await writeFile(out, fixturesModule(built.data));
    console.log(`${Object.keys(built.data).length} states → ${out}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
