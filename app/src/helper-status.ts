// A small, read-only view of the work that keeps an installed helper alive. Page presence and working() stay server-owned.
const activities = {
  'the notes': { kind: 'notes', label: 'Writing notes' },
  'the plans': { kind: 'plans', label: 'Making plans' },
  'an action': { kind: 'actions', label: 'Writing answers' },
  'the memory update': { kind: 'memory', label: 'Updating memory' },
  'a board scan': { kind: 'board', label: 'Scanning the Board' },
  'the glossary corrections': { kind: 'corrections', label: 'Correcting the transcript' },
  'the glossary build': { kind: 'glossary', label: 'Building the glossary' },
  'the recording': { kind: 'recording', label: 'Finishing the recording' },
  'the replay': { kind: 'replay', label: 'Finishing the replay' },
  'the transcription': { kind: 'transcription', label: 'Transcribing audio' },
  'the import': { kind: 'import', label: 'Importing audio' },
  'the speech download': { kind: 'download', label: 'Downloading the speech model' },
} as const;
export type HelperActivity = keyof typeof activities;
export type HelperWork = { activity: string; title?: string };
export function helperStatus(pageOpen: boolean, working: boolean, work?: HelperWork) {
  const activity = work && Object.hasOwn(activities, work.activity) ? activities[work.activity as HelperActivity] : undefined;
  const chars = Array.from((work?.title ?? '').replace(/\s+/g, ' ').trim());
  const title = chars.length > 40 ? chars.slice(0, 39).join('') + '…' : chars.join('');
  return { pageOpen, working,
    label: working && activity ? `${activity.label}${title ? ` for ${title}` : ''}` : 'Finishing work in the background',
    kind: working ? activity?.kind ?? null : null, title: working ? title || null : null };
}
