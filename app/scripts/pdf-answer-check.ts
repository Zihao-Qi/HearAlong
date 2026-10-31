// One real Answer action on a PDF through the app's code (cloud on): the PDF's text is extracted into a scratch data folder,
// Pi is told where it is, and the answer's citations are checked against it. One model call; the PDF is only read.
// Usage: node --experimental-strip-types scripts/pdf-answer-check.ts <file.pdf> "<question>" [model]
import { mkdir, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { ActionJobs, piActionRunner } from '../src/actions.ts';
import { PdfText } from '../src/pdf-text.ts';
import type { Material } from '../src/materials.ts';

const [pdf, question, model = 'openai-codex/gpt-6-luna'] = process.argv.slice(2);
if (!pdf || !question) throw new Error('Usage: pdf-answer-check.ts <file.pdf> "<question>" [model]');
const directory = resolve('data', `pdf-answer-check-${Date.now()}`);
await mkdir(directory, { recursive: true });
const store = new MeetingStore(directory);
const meeting = store.createMeeting('PDF check');
const chunk = await store.addPcm(meeting.id, 'mic:check', 0, 0, 16000, Buffer.alloc(16000 * 4, 1));
store.completeChunk(chunk.id, { text: question, words: [], backend: 'check', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
const path = await realpath(pdf);
const roots: Material[] = [{ id: 'paper', scope: `meeting:${meeting.id}`, path, kind: 'file', label: 'paper' }];
const pdfText = new PdfText(directory);
const jobs = new ActionJobs({ store, directory, runner: piActionRunner(model), clock: Date.now, glossaryFor: async () => null, rootsFor: () => roots, pdfText });
const { job } = await jobs.submit(meeting.id, { action: 'answer', prompt: question, selection: { text: question, segmentIds: [store.segments(meeting.id)[0].id] } });
while (!['done', 'failed', 'cancelled'].includes(jobs.get(job.id)!.state)) await new Promise(r => setTimeout(r, 500));
const done = jobs.get(job.id)!;
console.log(`State: ${done.state}${done.error ? ` (${done.error})` : ''}; model ${done.result?.model}; ${Math.round((done.result?.ms ?? 0) / 1000)} s`);
console.log(`Tools: ${(done.result?.tools ?? []).map(t => `${t.name} ${t.arg}`).join('\n       ')}`);
console.log(`\n${done.result?.markdown}\n\nChecks: ${done.result?.summary}`);
for (const check of done.result?.checks ?? []) console.log(`[${check.id}] ${check.label}: ${check.status}${check.detail ? ` (${check.detail})` : ''}\n${check.excerpt ?? ''}\n`);
await jobs.close();
store.close();
if (process.env.KEEP !== '1') await rm(directory, { recursive: true, force: true });
