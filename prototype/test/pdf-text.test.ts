import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfText, formatText, pageAt, pdfQuoteSpan, quoteReadings, searchForms } from '../src/pdf-text.ts';
import { searchRoots, type Material } from '../src/materials.ts';
import { ActionJobs, actionInput, checkFileSource, type PdfCheck } from '../src/actions.ts';
import { MeetingStore } from '../src/store.ts';
import type { PiTaskResult } from '../src/pi-task.ts';
import type { Recognition } from '../src/recognizer.ts';

// One data folder for the whole file, so the extractor is compiled once; each test has its own materials.
const shared = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-data-')));
after(() => rm(shared, { recursive: true, force: true }));
// An invented garden handout. Blank lines force actual PDF line breaks inside two different kinds of hyphenation.
const PAGES = [
  'Guide: keep the rain-\n\nwater barrel closed and every hose frost-\n\nproof.\n\nOpen the green tap for 14 seconds.',
  'Tool shelf: the copper watering can\n\nholds 7 litres beside the potting bench.',
];
/** A small PDF made by macOS (cupsfilter's text-to-PDF filter); a form feed starts a new page. */
async function makePdf(path: string, pages = PAGES) {
  const txt = `${path}.source.txt`;
  await writeFile(txt, pages.join('\f'));
  await writeFile(path, execFileSync('cupsfilter', ['-i', 'text/plain', '-m', 'application/pdf', txt], { stdio: ['ignore', 'pipe', 'ignore'] }));
  await rm(txt);
}
async function materials() {
  // Material roots are real paths (Projects.addRoot resolves them), as the PDFs' text paths are.
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-materials-')));
  await mkdir(join(folder, 'paper'));
  await makePdf(join(folder, 'paper', 'main.pdf'));
  const roots: Material[] = [{ id: 'R1', scope: 'meeting:m', path: folder, kind: 'folder', label: 'materials' }];
  return { folder, roots, pdf: join(folder, 'paper', 'main.pdf'), close: () => rm(folder, { recursive: true, force: true }) };
}
/** A stand-in extractor (a shell script with the real one's arguments); each run is counted in `<folder>/runs`. */
async function fakeExtractor(folder: string, body: string) {
  const path = join(folder, 'extractor.sh');
  await writeFile(path, `#!/bin/sh\necho run >> "${join(folder, 'runs')}"\n${body}\n`);
  await chmod(path, 0o755);
  return { path, runs: async () => (await readFile(join(folder, 'runs'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length };
}
const ONE_PAGE = `echo '{"pageCount":1,"pages":["hello quoted words on a page"]}'`;
const lineOf = async (pdfText: PdfText, pdf: string, part: string) => (await readFile(pdfText.textPath(pdf), 'utf8')).split('\n').findIndex(l => l.includes(part)) + 1;

test('a PDF is extracted once into the data folder, page by page, and again after it changes', async () => {
  const m = await materials();
  const logs: string[] = [];
  try {
    const pdfText = new PdfText(shared, { log: message => logs.push(message) });
    const first = await pdfText.text(m.pdf);
    assert.ok('path' in first, JSON.stringify(first));
    assert.equal(first.path, pdfText.textPath(m.pdf));
    assert.ok(first.path.startsWith(join(shared, 'pdf-text', 'files')), 'kept in the data folder');
    assert.equal(pdfText.pdfOf(first.path), m.pdf, 'the text file maps back to its PDF');
    const text = await readFile(first.path, 'utf8');
    assert.match(text, /^\[Text of the PDF "main\.pdf" \(2 pages\)/);
    assert.match(text, /\n--- page 1 of 2 ---\nGuide: keep the rain-\nwater barrel closed/);
    assert.match(text, /\n--- page 2 of 2 ---\nTool shelf/);
    assert.deepEqual(first.meta.generated, [1, 2, first.meta.pageStarts[1]], 'the header and the markers are the app\'s own lines');
    assert.deepEqual((await readdir(m.folder, { recursive: true })).sort(), ['paper', 'paper/main.pdf'], 'nothing is written beside the PDF');

    // Cached: a second instance (a restart) uses the same file without extracting again.
    const madeAt = (await stat(first.path)).mtimeMs;
    await new Promise(r => setTimeout(r, 20));
    const again = await new PdfText(shared).text(m.pdf);
    assert.ok('path' in again);
    assert.equal((await stat(again.path)).mtimeMs, madeAt);

    // A changed PDF (new size and time) is extracted again.
    await makePdf(m.pdf, ['Updated shed inventory: 23 bamboo stakes and a yellow bucket.']);
    const changed = await pdfText.read(m.pdf);
    assert.ok('text' in changed);
    assert.match(changed.text, /\(1 pages\)[\s\S]*23 bamboo stakes/);
    assert.deepEqual(logs, []);

    // A file that is not a PDF fails once, is logged once, and is not tried again until it changes.
    const broken = join(m.folder, 'broken.pdf');
    await writeFile(broken, 'not a pdf');
    assert.deepEqual(await pdfText.text(broken), { problem: 'not a readable PDF' });
    assert.deepEqual(await pdfText.text(broken), { problem: 'not a readable PDF' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /broken\.pdf could not be extracted/);
  } finally { await m.close(); }
});

test('the page limit stops the text and says where', async () => {
  const m = await materials();
  try {
    const read = await new PdfText(shared, { maxPages: 1 }).read(m.pdf);
    assert.ok('text' in read);
    assert.match(read.text, /--- page 1 of 2 ---/);
    assert.doesNotMatch(read.text, /page 2 of 2/);
    assert.match(read.text, /The text stops after page 1 of 2/);
    assert.equal(read.generated.length, 3, 'header, marker and the closing note');
  } finally { await m.close(); }
});

test('a PDF that changes while it is read is read again, and its text is stored under the final version', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-change-')));
  try {
    const pdf = join(folder, 'growing.pdf');
    await writeFile(pdf, 'first');
    // The first run changes the PDF before it answers; the second does not.
    const fake = await fakeExtractor(folder, `[ -f "${folder}/changed" ] || { touch "${folder}/changed"; printf more >> "$1"; }\n${ONE_PAGE}`);
    const pdfText = new PdfText(join(folder, 'data'), { extractor: fake.path });
    const got = await pdfText.text(pdf);
    assert.ok('path' in got, JSON.stringify(got));
    assert.equal(await fake.runs(), 2);
    const info = await stat(pdf);
    assert.equal(got.meta.version.split(':').slice(1).join(':'), `${info.size}:${info.mtimeMs}`);
    assert.equal(await fake.runs(), 2);
    assert.ok('path' in await pdfText.text(pdf), 'current, so not extracted again');
    assert.equal(await fake.runs(), 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('an extraction that ends with an older version of the PDF is not used, nor one whose PDF vanished', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-generation-')));
  try {
    const pdf = join(folder, 'paper.pdf');
    await writeFile(pdf, 'v1');
    const fake = await fakeExtractor(folder, ONE_PAGE);
    const pdfText = new PdfText(join(folder, 'data'), { extractor: fake.path });
    // The PDF changes right after the first extraction has finished (after its own checks): a caller waiting on that
    // work, as one that joined it while it ran, must not get the older text.
    const extract = (pdfText as any).extract.bind(pdfText);
    let calls = 0;
    (pdfText as any).extract = async (...args: unknown[]) => { const got = await extract(...args); if (++calls === 1) await writeFile(pdf, 'version two'); return got; };
    const got = await pdfText.text(pdf);
    assert.ok('path' in got, JSON.stringify(got));
    assert.equal(calls, 2);
    const info = await stat(pdf);
    assert.ok(got.meta.version.endsWith(`:${info.size}:${info.mtimeMs}`));

    // The extractor removes the PDF before it answers: a failure, and no text is kept.
    const gone = join(folder, 'gone.pdf');
    await writeFile(gone, 'soon gone');
    const vanishing = await fakeExtractor(folder, `rm "$1"\n${ONE_PAGE}`);
    const other = new PdfText(join(folder, 'data2'), { extractor: vanishing.path });
    assert.deepEqual(await other.text(gone), { problem: 'not found' });
    assert.equal(await stat(other.textPath(gone)).then(() => true, () => false), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the search finds words in PDFs with page and line, also across a hyphenated line break', async () => {
  const m = await materials();
  try {
    const pdfText = new PdfText(shared);
    const result = await searchRoots(m.roots, 'copper', pdfText);
    assert.equal(result.hits.length, 1);
    const hit = result.hits[0];
    assert.equal(hit.file, join('paper', 'main.pdf'));
    assert.equal(hit.page, 2);
    assert.equal(hit.line, await lineOf(pdfText, m.pdf, 'copper'));
    // "rain-" / "water" spans two PDF lines: the whole word is found at its starting line.
    const joined = await searchRoots(m.roots, 'the rainwater', pdfText);
    assert.equal(joined.hits.length, 1, JSON.stringify(joined.hits));
    assert.equal(joined.hits[0].page, 1);
    assert.equal(joined.hits[0].text, 'Guide: keep the rain-\nwater barrel closed and every hose frost-');
    assert.equal((await searchRoots(m.roots, 'frost-proof', pdfText)).hits.length, 1);
    assert.equal((await searchRoots(m.roots, 'can holds', pdfText)).hits[0].line, hit.line, 'across a plain line break');
    assert.equal((await searchRoots(m.roots, 'extracted by the app', pdfText)).hits.length, 0, 'the header is not searched');
    assert.equal((await searchRoots(m.roots, 'page 1 of 2', pdfText)).hits.length, 0, 'nor are the page markers');
    // Without the PDF text the PDF is a filename match only.
    assert.match((await searchRoots(m.roots, 'main', undefined)).hits[0].text, /Filename match only/);
    // A PDF without text is reported, and matched by name.
    await writeFile(join(m.folder, 'scan.pdf'), 'no pdf here');
    const scan = await searchRoots(m.roots, 'scan', pdfText);
    assert.deepEqual(scan.unread, ['scan.pdf (not a readable PDF)']);
    assert.match(scan.hits[0].text, /^Filename match only; not a readable PDF/);
  } finally { await m.close(); }
});

test('a PDF line that looks like a page marker changes no page, and the app\'s own lines are never evidence', async () => {
  const m = await materials();
  try {
    const pdf = join(m.folder, 'forged.pdf');
    await makePdf(pdf, ['First page words here.\n\n--- page 99 of 99 ---\n\nStill the first page of it.', 'Real words on the second page.']);
    const pdfText = new PdfText(shared);
    const read = await pdfText.read(pdf);
    assert.ok('text' in read);
    assert.match(read.text, /\n\\--- page 99 of 99 ---\n/, 'escaped in the text');
    assert.equal((await searchRoots(m.roots, 'still the first page', pdfText)).hits[0].page, 1);
    assert.equal((await searchRoots(m.roots, 'second page', pdfText)).hits.find(h => h.file === 'forged.pdf')!.page, 2);
    const check = (source: object) => checkFileSource({ id: 1, rootId: 'R1', ...source }, m.roots, 60, { text: pdfText });
    const still = await check({ path: 'forged.pdf', lines: `${await lineOf(pdfText, pdf, 'Still the first')}`, quote: 'Still the first page of it' });
    assert.equal(still.status, 'quote found');
    assert.equal(still.pages, '1');
    assert.equal((await check({ path: 'forged.pdf', lines: '1', quote: 'extracted by the app. Cite the PDF with' })).status, 'quote not found', 'the header');
    assert.equal((await check({ path: 'forged.pdf', lines: '2-3', quote: 'page 1 of 2 --- First page words' })).status, 'quote not found', 'a marker');
  } finally { await m.close(); }
});

test('PDF quote matching: line-break and soft hyphens join, inline hyphens stay, and places are those of the words', () => {
  // A−B is the handout's invented tank-balance label, not a research formula.
  const lines = ['save rain-', 'water for seedlings', 'mark A-B on tank', 'wa\u00AD', 'tering cans', 'pre- and post-watering', 'keep hoses frost-', 'proof.',
    'mark A\u2212 B on tank', 'then a watering round follows'];
  const span = (quote: string, generated = new Set<number>(), from = 1, to = lines.length) => pdfQuoteSpan(lines, generated, from, to, quoteReadings(quote));
  assert.deepEqual(span('save rainwater for seedlings'), [1, 2]);
  assert.deepEqual(span('save rain-water for seedlings'), [1, 2], 'the quote copied with its hyphen');
  assert.deepEqual(span('save rain- water for seedlings'), [1, 2], 'or as wrapped text');
  assert.deepEqual(span('mark A-B on tank'), [3, 3]);
  assert.equal(span('mark AB on tank'), null, 'an inline minus is not dropped');
  assert.deepEqual(span('watering cans'), [4, 5], 'a soft hyphen before a line break');
  assert.deepEqual(span('pre- and post-watering'), [6, 6]);
  assert.deepEqual(span('keep hoses frost-proof.'), [7, 8]);
  assert.equal(span('water for seedlings'), null, 'half a word is not a quote');
  // A minus sign (U+2212) followed by a space is an operator, never a broken word.
  assert.equal(span('mark AB on tank', new Set(), 9, 9), null);
  assert.deepEqual(span('mark A\u2212 B on tank', new Set(), 9, 9), [9, 9]);
  // A quote copied with a wrap matches the word written whole, as the text's wraps match a whole quote.
  assert.deepEqual(span('then a wa- tering round'), [10, 10]);
  assert.deepEqual(span('then a wa-\ntering round'), [10, 10]);
  assert.deepEqual(span('then a wa\u00AD\ntering round'), [10, 10], 'a soft hyphen and its line break');
  assert.deepEqual(span('then a wa\u00ADtering round'), [10, 10]);
  // Across a page break: the page markers (the app's lines) are skipped, and the place spans both pages.
  const paged = ['[header]', '--- page 1 of 2 ---', 'save the rain-', '--- page 2 of 2 ---', 'water for seedlings'];
  const at = pdfQuoteSpan(paged, new Set([1, 2, 4]), 1, 5, quoteReadings('the rainwater for seedlings'));
  assert.deepEqual(at, [3, 5]);
  assert.deepEqual([pageAt([2, 4], at![0]), pageAt([2, 4], at![1])], [1, 2]);
  assert.equal(pageAt([2, 4], 1), null);
});

test('PDF quote matching: a quote may end on a word broken across a line, copied up to its break with the hyphen', () => {
  const lines = ['the shed is ven-', 'tilated through two shutters', 'keep hoses frost-', 'proof outdoors', 'mark A\u2212', 'B on tank', 'a wa\u00AD', 'tering can'];
  const span = (quote: string) => pdfQuoteSpan(lines, new Set(), 1, lines.length, quoteReadings(quote));
  assert.deepEqual(span('the shed is ven-'), [1, 1], 'the span ends at the break');
  assert.deepEqual(span('keep hoses frost-'), [3, 3]);
  assert.deepEqual(span('the shed is ventilated through'), [1, 2], 'the whole word still matches');
  assert.equal(span('the shed is ven'), null, 'without the hyphen it is half a word');
  assert.equal(span('the shed is vent-'), null, 'only the part before the break');
  assert.equal(span('shed is ven- through'), null, 'only at the end of the quote');
  assert.equal(span('mark AB'), null, 'a minus sign before a line end is never a word break');
  // The app's own lines between the halves do not change it.
  const paged = ['[header]', 'please keep the shed ven-', '--- page 2 of 2 ---', 'tilated'];
  assert.deepEqual(pdfQuoteSpan(paged, new Set([1, 3]), 1, 4, quoteReadings('please keep the shed ven-')), [2, 2]);
});

test('a query is read like the text: a wrap copied into it finds the word written whole, and a minus is left alone', () => {
  const found = (text: string, query: string) => searchForms(text).some(form => searchForms(query).some(q => form.includes(q)));
  assert.ok(found('then a watering round', 'a wa- tering round'));
  assert.ok(found('then a watering round', 'wa\u00AD tering'));
  assert.ok(found('save the rain-\nwater today', 'the rainwater'));
  assert.ok(found('keep hoses frost-\nproof', 'frost-proof'));
  assert.ok(!found('mark A\u2212 B on tank', 'mark AB'));
});

test('a file name with a line break cannot shift the lines the app wrote', () => {
  const made = formatText('odd\nname\r.pdf', 2, ['first page', 'second page']);
  const lines = made.text.split('\n');
  assert.match(lines[0], /^\[Text of the PDF "odd\\nname\\r\.pdf" \(2 pages\)/);
  assert.deepEqual(made.pageStarts.map(n => lines[n - 1]), ['--- page 1 of 2 ---', '--- page 2 of 2 ---']);
  assert.deepEqual(made.generated, [1, ...made.pageStarts]);
});

test('PDF quote checks: the PDF or its text version may be cited, real .pdf.txt files stay themselves, and nothing outside counts', async () => {
  const m = await materials();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-outside-')));
  try {
    const pdfText = new PdfText(shared);
    const view = join(shared, 'task', 'pdf-text');
    await pdfText.prepare(m.roots, { view });
    const at = await lineOf(pdfText, m.pdf, 'rain-');
    const quote = 'keep the rainwater barrel closed and every hose frost-proof';
    const pdf: PdfCheck = { text: pdfText, view };
    const ok = await checkFileSource({ id: 1, rootId: 'R1', path: 'paper/main.pdf', lines: `${at}`, quote }, m.roots, 60, pdf);
    assert.equal(ok.status, 'quote found', JSON.stringify(ok));
    assert.deepEqual([ok.matchedFrom, ok.matchedTo, ok.pages], [at, at + 2, '1']);
    assert.equal(ok.label, `paper/main.pdf:${at} (p. 1)`);
    // The text version: in the task's view (absolute, or relative to the task folder), in the cache, or "<pdf>.txt".
    for (const path of [join(view, 'R1', 'paper', 'main.pdf.txt'), 'pdf-text/R1/paper/main.pdf.txt', pdfText.textPath(m.pdf), 'paper/main.pdf.txt']) {
      const viaText = await checkFileSource({ id: 2, rootId: 'R1', path, lines: `${at}`, quote }, m.roots, 60, pdf);
      assert.deepEqual([viaText.status, viaText.path, viaText.rootId], ['quote found', 'paper/main.pdf', 'R1'], path);
    }
    const page2 = await lineOf(pdfText, m.pdf, 'copper');
    const second = await checkFileSource({ id: 3, rootId: 'R1', path: 'paper/main.pdf', lines: `${page2}-${page2 + 1}`, quote: 'the copper watering can holds 7 litres' }, m.roots, 60, pdf);
    assert.deepEqual([second.status, second.pages], ['quote found', '2'], 'a quote over a line break');
    assert.equal((await checkFileSource({ id: 4, rootId: 'R1', path: 'paper/main.pdf', lines: `${at}`, quote: 'keep the rainwater barrel open and every hose' }, m.roots, 60, pdf)).status, 'quote not found');

    // A real text material whose name ends in .pdf.txt is checked as itself, with or without a PDF beside it.
    await writeFile(join(m.folder, 'paper', 'notes.pdf.txt'), 'Our own shed checklist, written on a clipboard.');
    await writeFile(join(m.folder, 'paper', 'main.pdf.txt'), 'A summary someone saved beside the PDF.');
    const notes = await checkFileSource({ id: 5, rootId: 'R1', path: 'paper/notes.pdf.txt', lines: '1', quote: 'shed checklist, written on a clipboard' }, m.roots, 60, pdf);
    assert.deepEqual([notes.status, notes.path, notes.pages], ['quote found', 'paper/notes.pdf.txt', undefined]);
    const summary = await checkFileSource({ id: 6, rootId: 'R1', path: 'paper/main.pdf.txt', lines: '1', quote: 'A summary someone saved beside' }, m.roots, 60, pdf);
    assert.deepEqual([summary.status, summary.path], ['quote found', 'paper/main.pdf.txt']);

    // Outside the attached materials: another PDF's text (really extracted), a path out of the root, an escaping symlink.
    const other = join(outside, 'other.pdf');
    await makePdf(other);
    assert.ok('path' in await pdfText.text(other));
    const outsideCheck = (path: string) => checkFileSource({ id: 7, rootId: 'R1', path, lines: `${at}`, quote }, m.roots, 60, pdf);
    assert.equal((await outsideCheck(pdfText.textPath(other))).detail, 'outside the attached materials');
    assert.equal((await outsideCheck(`../${outside.split('/').at(-1)}/other.pdf`)).detail, 'outside the attached materials');
    await symlink(other, join(m.folder, 'linked.pdf'));
    assert.equal((await outsideCheck('linked.pdf')).detail, 'outside the attached materials');
    assert.equal((await outsideCheck('pdf-text/R1/../../task/other.pdf.txt')).status, 'invalid', 'a path out of the view is no alias');
    assert.equal((await outsideCheck(join(view, 'R9', 'other.pdf.txt'))).status, 'invalid', 'nor is an unknown root in it');

    // A single-file root.
    const single: Material[] = [{ id: 'F1', scope: 'meeting:m', path: m.pdf, kind: 'file', label: 'main.pdf' }];
    await pdfText.prepare(single, { view });
    assert.equal((await checkFileSource({ id: 8, rootId: 'F1', path: 'main.pdf', lines: `${at}`, quote }, single, 60, pdf)).status, 'quote found');
    assert.equal((await checkFileSource({ id: 9, rootId: 'F1', path: join(view, 'F1', 'main.pdf.txt'), lines: `${at}`, quote }, single, 60, pdf)).path, 'main.pdf');
  } finally { await m.close(); await rm(outside, { recursive: true, force: true }); }
});

test('a task sees only its roots\' validated PDF text, and an outdated text is never in its view', async () => {
  const m = await materials();
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-other-project-')));
  try {
    const pdfText = new PdfText(shared);
    await makePdf(join(elsewhere, 'private.pdf'));
    await pdfText.prepare([{ id: 'R2', scope: 'project:other', path: elsewhere, kind: 'folder', label: 'other' }], {});
    const view = join(shared, 'task-view', 'pdf-text');
    const [prepared] = await pdfText.prepare(m.roots, { view });
    const { files, ...rest } = prepared;
    assert.deepEqual(rest, { rootId: 'R1', text: join(view, 'R1'), ready: 1, missing: [] });
    // The page lines of exactly the text copied go with the view (a run never reads them later from the shared cache).
    const meta = await pdfText.meta(m.pdf);
    assert.deepEqual(files, [{ file: 'paper/main.pdf', version: meta!.version, pageStarts: meta!.pageStarts, generated: meta!.generated }]);
    assert.deepEqual(await readdir(view, { recursive: true }), ['R1', 'R1/paper', 'R1/paper/main.pdf.txt'], 'nothing of the other project');
    const cached = await readFile(pdfText.textPath(m.pdf), 'utf8');
    assert.equal(await readFile(join(view, 'R1', 'paper', 'main.pdf.txt'), 'utf8'), cached);
    // The view holds copies: a task (a Compute script) that overwrites its copy leaves the cache as it was.
    await writeFile(join(view, 'R1', 'paper', 'main.pdf.txt'), 'overwritten by the task');
    assert.equal(await readFile(pdfText.textPath(m.pdf), 'utf8'), cached);
    const again = await pdfText.read(m.pdf);
    assert.ok('text' in again && again.text === cached);
    const input = actionInput({ action: 'answer', prompt: null, context: { title: 'M', capturedAt: 0, selection: { text: 'x', segmentIds: [], startMs: 0, endMs: 0 }, lines: [],
      contextUntilMs: 0, gapsNear: [], pendingNear: 0, glossaryVersion: null, terms: [], roots: m.roots } }, [prepared]);
    assert.ok(input.includes(`- R1: ${m.folder} (folder)\n  Text of its PDF: ${join(view, 'R1')}`), input);
    assert.ok(!input.includes(pdfText.folder), 'the shared cache is not named');

    // The PDF is replaced by something that cannot be extracted: its old text stays in the cache but not in a new view.
    await writeFile(m.pdf, 'no longer a pdf');
    const [stale] = await pdfText.prepare(m.roots, { view });
    assert.deepEqual(stale.missing, [{ file: join('paper', 'main.pdf'), problem: 'not a readable PDF' }]);
    assert.deepEqual(await readdir(view), [], 'the view is made afresh');
  } finally { await m.close(); await rm(elsewhere, { recursive: true, force: true }); }
});

test('the cleanup removes text only of PDFs that are gone, not of PDFs it cannot see', async () => {
  const m = await materials();
  const locked = join(m.folder, 'locked');
  try {
    const pdfText = new PdfText(shared);
    await mkdir(locked);
    await makePdf(join(locked, 'kept.pdf'));
    await pdfText.prepare(m.roots, {});
    const kept = pdfText.textPath(join(locked, 'kept.pdf'));
    await chmod(locked, 0o000);
    await pdfText.prepare(m.roots, {});
    assert.ok(await stat(kept).then(() => true, () => false), 'an unreadable folder is not "gone"');
    await chmod(locked, 0o700);
    await rm(join(locked, 'kept.pdf'));
    await pdfText.prepare(m.roots, {});
    assert.equal(await stat(kept).then(() => true, () => false), false, 'a deleted PDF\'s text is removed');
    assert.ok(await stat(pdfText.textPath(m.pdf)).then(() => true, () => false));
  } finally { await chmod(locked, 0o700).catch(() => {}); await m.close(); }
});

test('waits are bounded and Cancel stops them; shutdown stops the extractor and starts nothing new', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-slow-')));
  try {
    const pdf = join(folder, 'slow.pdf');
    await writeFile(pdf, 'slow');
    const fake = await fakeExtractor(folder, 'exec sleep 20');
    const pdfText = new PdfText(join(folder, 'data'), { extractor: fake.path });
    let started = Date.now();
    assert.deepEqual(await pdfText.read(pdf, { waitMs: 50 }), { problem: 'its text is still being extracted' });
    assert.ok(Date.now() - started < 2_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    started = Date.now();
    const roots: Material[] = [{ id: 'S', scope: 'meeting:m', path: folder, kind: 'folder', label: 's' }];
    const [prepared] = await pdfText.prepare(roots, { signal: controller.signal, view: join(folder, 'view') });
    assert.deepEqual(prepared.missing, [{ file: 'slow.pdf', problem: 'cancelled' }]);
    assert.ok(Date.now() - started < 2_000);
    // A quote check gives up at its deadline.
    const check = await checkFileSource({ id: 1, rootId: 'S', path: 'slow.pdf', lines: '1', quote: 'hello quoted words' }, roots, 60, { text: pdfText, deadline: Date.now() + 50 });
    assert.equal(check.detail, 'no text from this PDF: its text is still being extracted');
    started = Date.now();
    await pdfText.close();
    assert.ok(Date.now() - started < 2_000, 'the sleeping extractor was stopped');
    const runs = await fake.runs();
    assert.deepEqual(await pdfText.text(pdf), { problem: 'the app is closing' });
    assert.equal(await fake.runs(), runs, 'nothing started after shutdown');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a failed build of the extractor is not held against the PDFs', async () => {
  const m = await materials();
  const data = await mkdtemp(join(tmpdir(), 'meeting-pdf-build-'));
  const path = process.env.PATH;
  const logs: string[] = [];
  try {
    const pdfText = new PdfText(data, { rebuildAfterMs: 0, log: message => logs.push(message) });
    process.env.PATH = '';
    const failed = await pdfText.text(m.pdf);
    assert.ok('problem' in failed && /could not be built \(swiftc was not found/.test(failed.problem), JSON.stringify(failed));
    process.env.PATH = path;
    assert.ok('path' in await pdfText.text(m.pdf), 'tried again once the toolchain is there');
    assert.equal(logs.length, 1);
  } finally { process.env.PATH = path; await m.close(); await rm(data, { recursive: true, force: true }); }
});

async function actionFixture(roots: Material[]) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-pdf-action-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Garden shed setup');
  const recognition: Recognition = { text: 'How should we leave the rainwater barrel?', words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 };
  const chunk = await store.addPcm(meeting.id, 'mic:t', 0, 0, 16000, Buffer.alloc(16000 * 4, 1));
  store.completeChunk(chunk.id, recognition);
  const submit = (jobs: ActionJobs) => jobs.submit(meeting.id, { action: 'answer', selection: { text: 'rainwater barrel', segmentIds: [store.segments(meeting.id)[0].id] } });
  const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 10)); };
  return { directory, store, meeting, roots, submit, until, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const answer = (text: string): PiTaskResult => ({ text, ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [] });

test('an action reads the PDF text in its own view, and its PDF citation is checked against it', async () => {
  const m = await materials();
  const f = await actionFixture(m.roots);
  try {
    const pdfText = new PdfText(shared);
    let input = '', instructions = '', cwd = '';
    const jobs = new ActionJobs({
      store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, rootsFor: () => m.roots, pdfText,
      runner: async options => {
        input = await readFile(options.inputPath, 'utf8');
        instructions = options.instructions;
        cwd = options.cwd;
        const lines = (await readFile(join(cwd, 'pdf-text', 'R1', 'paper', 'main.pdf.txt'), 'utf8')).split('\n');
        const at = lines.findIndex(l => l.includes('rain-')) + 1;
        const meta = { sources: [{ id: 1, type: 'file', rootId: 'R1', path: 'pdf-text/R1/paper/main.pdf.txt', lines: `${at}-${at + 1}`, quote: 'keep the rainwater barrel closed and every hose frost-proof' }] };
        return answer(`Leave the rainwater barrel closed and use frost-proof hoses [1].\n<<<META\n${JSON.stringify(meta)}\nMETA>>>`);
      },
    });
    const { job } = await f.submit(jobs);
    await f.until(() => jobs.get(job.id)!.state === 'done');
    assert.equal(jobs.get(job.id)!.state, 'done', jobs.get(job.id)!.error ?? '');
    assert.ok(input.includes(`  Text of its PDF: ${join(cwd, 'pdf-text', 'R1')}`), input);
    assert.match(instructions, /PDF files cannot be read directly/);
    const check = jobs.get(job.id)!.result!.checks[0];
    assert.deepEqual([check.status, check.path, check.pages], ['quote found', 'paper/main.pdf', '1']);
    const viewGone = async () => !(await stat(join(cwd, 'pdf-text')).then(() => true, () => false));
    for (let i = 0; i < 100 && !(await viewGone()); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(await viewGone(), 'the view is removed after the run');
    // The preview of a PDF citation shows its text.
    const preview = await jobs.preview(f.meeting.id, 'R1', 'paper/main.pdf', check.from!, check.to!);
    assert.match(preview.text!, /rain-/);
    await jobs.close();
  } finally { await f.close(); await m.close(); }
});

test('Cancel stops an action that waits for PDF text', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'meeting-pdf-cancel-')));
  await writeFile(join(folder, 'slow.pdf'), 'slow');
  const roots: Material[] = [{ id: 'S', scope: 'meeting:m', path: folder, kind: 'folder', label: 's' }];
  const f = await actionFixture(roots);
  try {
    const fake = await fakeExtractor(folder, 'exec sleep 20');
    const pdfText = new PdfText(join(f.directory, 'data'), { extractor: fake.path });
    let called = false;
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null, rootsFor: () => roots, pdfText,
      runner: async () => { called = true; return answer('x'); } });
    const { job } = await f.submit(jobs);
    await f.until(() => jobs.get(job.id)!.state === 'running');
    await new Promise(r => setTimeout(r, 100));
    const started = Date.now();
    await jobs.cancel(f.meeting.id, job.id);
    await f.until(() => jobs.get(job.id)!.state === 'cancelled');
    assert.equal(jobs.get(job.id)!.state, 'cancelled');
    assert.ok(Date.now() - started < 2_000);
    assert.equal(called, false, 'Pi never started');
    await jobs.close();
    await pdfText.close();
  } finally { await f.close(); await rm(folder, { recursive: true, force: true }); }
});
