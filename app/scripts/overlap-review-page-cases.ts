import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright-core';
import { miniLog, type Preview, type PendingPreview } from '../public/preview-composition.js';
import type { DisplaySegment } from '../public/transcript-view.js';
import type { ParagraphBarrier } from '../public/live-shared.js';

const segment = (id: string, startMs: number, text: string, speaker = 'Me'): DisplaySegment & { source: string } => ({ id, startMs, endMs: startMs + 1000,
  text, revision: 0, speaker, source: speaker === 'Me' ? 'mic:review' : 'tab:review' });
const preview = (chunkId: string, startMs: number, text: string, speaker = 'Me'): PendingPreview => ({ chunkId, window: chunkId,
  source: speaker === 'Me' ? 'mic:review' : 'tab:review', speaker, windowStartMs: startMs, committedUntilMs: startMs, coveredUntilMs: startMs + 1000,
  cutMs: startMs + 1500, text, behind: false, words: [{ text, startMs, endMs: startMs + 1000 }] });

/** Production renderers in an isolated page/mini; synthetic text, no audio device or playback. */
export async function checkOverlapReviewPage(context: BrowserContext, url: string, results: string[]) {
  // The dashboard installs its offline service worker; these wire fixtures must not be intercepted by it.
  const isolated = await context.browser()!.newContext({ serviceWorkers: 'block' });
  const page = await isolated.newPage(), mini = await isolated.newPage(), errors: string[] = [];
  let state: { segments: ReturnType<typeof segment>[]; drafts: Preview[]; pending: PendingPreview[]; paragraphBarriers: ParagraphBarrier[] }
    = { segments: [], drafts: [], pending: [], paragraphBarriers: [] };
  try {
    page.on('pageerror', error => errors.push(error.message));
    mini.on('pageerror', error => errors.push(error.message));
    await page.route('**/overlap-review-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
<link rel="stylesheet" href="/style.css"><style>body{padding:40px}#box{height:240px;width:550px;overflow:auto;overflow-anchor:none}.para{min-height:36px}</style><div id="box"></div><script type="module">
import {createTranscriptView} from '/transcript-view.js';
window.view=createTranscriptView(document.querySelector('#box'),{segmentNode:s=>{const n=document.createElement('span');n.dataset.id=s.id;n.textContent=s.text+' ';return n}});
window.paint=s=>window.view.render({...s,labelled:true});window.ready=true;
</script>` }));
    await page.goto(url + '/overlap-review-fixture'); await page.waitForFunction(() => (window as any).ready);
    await mini.setViewportSize({ width: 360, height: 330 });
    await mini.route('**/api/live*', route => {
      const log = miniLog(state.segments, state.drafts, state.pending, [], state.paragraphBarriers);
      return route.fulfill({ json: { recording: { meetingId: 'review', session: 1, clockMs: 0, labelled: true,
        paragraphsFrom: 0, paragraphsTag: '', paragraphs: log.paragraphs.map(p => ({ ...p, text: p.segments.map(s => s.text).join(' ') })),
        pending: state.pending.map(p => ({ ...p, placements: log.placements.filter(r => r.chunkId === p.chunkId) })), drafts: [], notices: [], card: null }, mini: { state: 'open' } } });
    });
    await mini.goto(url + '/mini.html');
    const paint = async (segments: typeof state.segments, pending: PendingPreview[] = [], drafts: Preview[] = [], paragraphBarriers: ParagraphBarrier[] = []) => {
      state = { segments, pending, drafts, paragraphBarriers };
      await page.evaluate(s => (window as any).paint(s), state);
      await mini.evaluate(async () => { await (window as any).miniRefresh(); });
      await mini.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#m-scroll .final')].map(n => n.textContent)) === expected,
        JSON.stringify(miniLog(segments, drafts, pending, [], paragraphBarriers).paragraphs.map(p => p.segments.map(s => s.text).join(' '))));
    };
    const history = Array.from({ length: 15 }, (_, i) => segment(`review-history-${i}:0`, i * 4000, `Fictional copper lantern ${i} was stored.`));
    const tails = Array.from({ length: 12 }, (_, i) => segment(`review-tail-${i}:0`, 200000 + i * 4000, `Blue wooden turtle ${i} arrived.`));
    const first = segment('growing:0', 100000, 'Violet baskets contain painted wooden plums and striped paper leaves, '.repeat(3));
    const other = segment('reading:0', 101000, 'A quiet row of silver bells.', 'Them');
    const growth = segment('growth:0', 102000, 'and green glass buttons fill the remaining shelves. '.repeat(3));
    await paint([...history, first, other, ...tails]);
    // No selection, with an open paragraph partly offscreen above the row being read.
    const anchors = [];
    for (const [target, box, selector] of [[page, '#box', '[data-key="chunk:reading"]'], [mini, '#m-scroll', '[data-key="reading:0"]']] as const) {
      anchors.push(await target.evaluate(({ box, selector }) => {
        getSelection()!.removeAllRanges();
        const pane = document.querySelector(box)!, row = document.querySelector(selector)!;
        pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 25;
        pane.dispatchEvent(new Event('scroll'));
        return row.getBoundingClientRect().top;
      }, { box, selector }));
    }
    await paint([...history, first, other, growth, ...tails]);
    for (const [i, target] of [page, mini].entries()) {
      const top = await target.locator(i ? '[data-key="reading:0"]' : '[data-key="chunk:reading"]').evaluate(n => n.getBoundingClientRect().top);
      assert.ok(Math.abs(top - anchors[i]) <= 1, `${i ? 'mini' : 'main'} reader drift on earlier paragraph growth: ${top - anchors[i]}px`);
    }
    results.push('PASS review: no-selection reader anchor survives partly scrolled-off earlier paragraph growth in main and mini (<=1 px)');

    // With no row starting inside the mini viewport, keep the partly visible row's bottom stable.
    const tall = { ...first, text: first.text.repeat(5) };
    await paint([...history, tall, other, ...tails]);
    const bottom = await mini.locator('[data-key="growing:0"]').evaluate(n => {
      const pane = document.querySelector('#m-scroll')!;
      pane.scrollTop += n.getBoundingClientRect().top - pane.getBoundingClientRect().top + 35;
      pane.dispatchEvent(new Event('scroll')); return n.getBoundingClientRect().bottom;
    });
    await paint([...history, tall, other, growth, ...tails]);
    const newBottom = await mini.locator('[data-key="growing:0"]').evaluate(n => n.getBoundingClientRect().bottom);
    assert.ok(Math.abs(newBottom - bottom) <= 1, `mini partial-row bottom drift ${newBottom - bottom}px`);
    results.push('PASS review: mini bottom-edge fallback holds when its only visible open row grows (<=1 px)');

    // A pending row becomes a line inside an earlier multi-line paragraph, rather than aligning that paragraph's top.
    const pendingText = 'Amber toy wagons arrived.';
    const pending = preview('merge', 102000, pendingText);
    const later = segment('after-merge:0', 104000, 'The paper gate is closed.', 'Them');
    await paint([...history, first, later, ...tails], [pending]);
    const pendingAnchors = [];
    for (const [target, box, selector] of [[page, '#box', '[data-key="chunk:merge"] .preview-text'], [mini, '#m-scroll', '[data-key="pending:merge"] .pending-preview']] as const) {
      pendingAnchors.push(await target.evaluate(({ box, selector }) => {
        const pane = document.querySelector(box)!, row = document.querySelector(selector)!;
        pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20;
        pane.dispatchEvent(new Event('scroll'));
        return row.getBoundingClientRect().top;
      }, { box, selector }));
    }
    await paint([...history, first, segment('merge:0', 102000, pendingText), later, ...tails]);
    const mainMerged = await page.locator('[data-id="merge:0"]').evaluate(n => n.getBoundingClientRect().top);
    const miniMerged = await mini.locator('[data-key="growing:0"] .final').evaluate((node, text) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let part;
      while ((part = walker.nextNode())) {
        const at = part.textContent!.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange(); range.setStart(part, at); range.setEnd(part, at + text.length); return range.getBoundingClientRect().top;
      }
      throw new Error('Merged words missing');
    }, pendingText);
    assert.ok(Math.abs(mainMerged - pendingAnchors[0]) <= 1, `main pending merge drift ${mainMerged - pendingAnchors[0]}px`);
    assert.ok(Math.abs(miniMerged - pendingAnchors[1]) <= 1, `mini pending merge drift ${miniMerged - pendingAnchors[1]}px`);
    results.push('PASS review: pending-to-earlier-paragraph merge anchors matching words, not paragraph top (main/mini <=1 px)');

    // A selection in one final must not retain an unrelated removed pending row as well as its new final.
    const selected = segment('select-review:0', 100000, 'Fictional marble shelves.', 'Them');
    const wait = preview('unselected-wait', 102000, 'Pink paper limes.');
    await paint([...history, selected, later, ...tails], [wait]);
    await mini.locator('[data-key="select-review:0"] .final').evaluate(n => {
      const range = document.createRange(); range.selectNodeContents(n); getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await paint([...history, selected, segment('unselected-wait:0', 102000, 'Pink paper limes.'), later, ...tails]);
    assert.equal(await mini.locator('#m-scroll .pending-preview').count(), 0);
    assert.equal((await mini.locator('#m-scroll').textContent())!.split('Pink paper limes.').length - 1, 1);
    assert.equal(await mini.evaluate(() => getSelection()!.toString()), 'Fictional marble shelves.');
    await mini.evaluate(() => getSelection()!.removeAllRanges());
    results.push('PASS review: unrelated pending completion during mini selection appears once, selection unchanged');

    // Extending a live log paragraph must preserve the old text node and add only new text.
    await paint([...history, first, other, ...tails]);
    await mini.locator('[data-key="growing:0"] .final').evaluate(n => {
      (window as any).oldLog = { row: n.parentElement, text: n.firstChild, added: [] };
      (window as any).logObserver = new MutationObserver(records => {
        for (const r of records) for (const added of r.addedNodes) (window as any).oldLog.added.push(added.textContent);
      });
      (window as any).logObserver.observe(n.parentElement, { childList: true, subtree: true });
    });
    await paint([...history, first, other, growth, ...tails]);
    const log = await mini.locator('[data-key="growing:0"] .final').evaluate(n => {
      (window as any).logObserver.disconnect(); const old = (window as any).oldLog;
      return { row: n.parentElement === old.row, text: n.firstChild === old.text, added: old.added };
    });
    assert.deepEqual(log, { row: true, text: true, added: [' ' + growth.text] });
    results.push('PASS review: role=log paragraph extension appends only new text, preserving existing row/text nodes');

    // A changed paragraph replaces the caret's text nodes. Restore by segment id/text offset, not old scrollTop.
    const readLine = segment('caret-line:0', 102000, 'The violet parcel was marked with a copper seal.');
    await paint([...history, first, readLine, ...tails]);
    const caret = await page.locator('[data-id="caret-line:0"]').evaluate(n => {
      const pane = document.querySelector('#box')!;
      pane.scrollTop += n.getBoundingClientRect().top - pane.getBoundingClientRect().top - 35;
      pane.dispatchEvent(new Event('scroll'));
      const text = n.firstChild!, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
      const r = range.getBoundingClientRect(); return { x: r.left + 1, y: r.top + 8, top: r.top };
    });
    await page.mouse.move(caret.x, caret.y);
    await page.evaluate(s => (window as any).paint(s), { segments: [...history,
      { ...first, text: first.text + ' More painted leaves and tiny paper roofs, '.repeat(4), revision: 1 }, readLine, ...tails], pending: [], drafts: [] });
    const restoredCaret = await page.locator('[data-id="caret-line:0"]').evaluate(n => {
      const range = document.createRange(); range.setStart(n.firstChild!, 0); range.setEnd(n.firstChild!, 1); return range.getBoundingClientRect().top;
    });
    assert.ok(Math.abs(restoredCaret - caret.top) <= 1, `replaced caret drift ${restoredCaret - caret.top}px`);
    results.push('PASS review: paragraph refill restores the reading caret by segment id after preceding text grows (<=1 px)');

    // Non-final chunks must split exactly their own lane even when there are no grey words to act as a barrier.
    const split = [segment('barrier-me:0', 100000, 'Mint toy wagons', 'Me'), segment('barrier-them:0', 101000, 'Copper birds wait', 'Them'),
      segment('barrier-me-end:0', 103000, 'rolled.', 'Me'), segment('barrier-them-end:0', 105000, 'here.', 'Them')];
    await paint(split, [], [], [{ startMs: 102000, speaker: 'Me' }]);
    const expectedSplit = ['Mint toy wagons', 'Copper birds wait here.', 'rolled.'];
    assert.deepEqual(await page.locator('#box .para p').allTextContents().then(xs => xs.map(x => x.trim())), expectedSplit);
    assert.deepEqual(await mini.locator('#m-scroll .final').allTextContents(), expectedSplit);
    await paint(split);
    assert.deepEqual(await page.locator('#box .para p').allTextContents().then(xs => xs.map(x => x.trim())), ['Mint toy wagons rolled.', 'Copper birds wait here.']);
    results.push('PASS second review: chunk barriers without previews split only their own lane in main/mini, and regroup when finalized');

    // Bound mini geometry work: a refresh while reading at the top must not measure the far-offscreen history/tail.
    const manyTails = Array.from({ length: 250 }, (_, i) => segment(`scan-tail-${i}:0`, 200000 + i * 4000, `Fictional blue parcel ${i} arrived.`));
    await paint([...history, first, other, ...manyTails]);
    await mini.evaluate(() => {
      const pane = document.getElementById('m-scroll')!; pane.scrollTop = 0; pane.dispatchEvent(new Event('scroll'));
      const original = Element.prototype.getBoundingClientRect, measured = new Set<string>();
      (window as any).miniScan = { original, measured };
      Element.prototype.getBoundingClientRect = function () {
        if (this.matches('.ln, .pending-ln') && this.closest('#m-scroll')) measured.add((this as HTMLElement).dataset.key!);
        return original.call(this);
      };
    });
    await mini.evaluate(async () => { await (window as any).miniRefresh(); });
    const scan = await mini.evaluate(() => {
      const { original, measured } = (window as any).miniScan;
      Element.prototype.getBoundingClientRect = original;
      return { measured: [...measured] as string[], total: document.querySelectorAll('#m-scroll .ln').length };
    });
    assert.ok(scan.total > 250);
    assert.ok(scan.measured.length < 20, `mini measured ${scan.measured.length} of ${scan.total} rows at the top`);
    assert.equal(scan.measured.includes('scan-tail-249:0'), false);
    results.push(`PASS second review: mini anchor refresh measures ${scan.measured.length} of ${scan.total} rows, not every offscreen row`);

    // Paragraph timelines overlap, but gaps between a speaker's lines do not own another speaker's audio.
    const heard = [segment('heard-me:0', 0, 'Purple toy ships', 'Me'), segment('heard-them:0', 2000, 'Copper moons.', 'Them'),
      segment('heard-them:1', 3500, 'Small stars.', 'Them'), segment('heard-me:1', 5000, 'sailed.', 'Me')];
    await paint(heard);
    const highlights = await page.evaluate(() => {
      const keys = [];
      for (const ms of [2500, 5500, 4500]) { (window as any).view.hear(ms); keys.push(document.querySelector('.para.heard')?.getAttribute('data-key') ?? null); }
      return keys;
    });
    assert.deepEqual(highlights, ['chunk:heard-them', 'chunk:heard-me', null]);
    await paint([segment('tie-me:0', 2000, 'Fictional red acorns.'), segment('tie-them:0', 2000, 'Fictional blue acorns.', 'Them')]);
    assert.equal(await page.evaluate(() => { (window as any).view.hear(2500); return document.querySelector('.para.heard')?.getAttribute('data-key'); }), 'chunk:tie-them');
    results.push('PASS review: playback chooses latest-start covering segment in screen order, not overlapping paragraph ranges');
    assert.deepEqual(errors, []);
  } finally { await isolated.close(); }
}
