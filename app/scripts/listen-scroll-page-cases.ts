import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright-core';

/** A real scroll changes geometry before Chromium dispatches its scroll event. No sleeps or CPU load. */
export async function checkDelayedPlaybackScroll(context: BrowserContext, url: string) {
  const page = await context.newPage();
  try {
    await page.route('**/delayed-playback-scroll', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
<style>#box{height:300px;overflow-y:auto;overflow-anchor:none;padding:0}.para{height:60px}p{margin:0}</style><div id="box"></div>
<script type="module">
import {createTranscriptView} from '/transcript-view.js';
const box=document.querySelector('#box');
// Hold delivery, not the scroll itself: playback and a poll may run in this interval in a real page.
box.addEventListener('scroll',event=>{if(window.holdScroll)event.stopImmediatePropagation()},true);
window.snapshot={segments:Array.from({length:80},(_,i)=>({id:'fictional-'+i+':0',revision:0,startMs:i*4000,endMs:(i+1)*4000,text:'Fictional line '+i}))};
window.changes=0;
window.view=createTranscriptView(box,{segmentNode:s=>document.createTextNode(s.text),changed:()=>window.changes++});
window.ready=true;
</script>` }));
    await page.goto(url + '/delayed-playback-scroll');
    await page.waitForFunction(() => (window as any).ready);
    for (const operation of ['playback', 'poll']) {
      const positions = await page.evaluate(operation => {
        const { view, snapshot } = window as any, box = document.getElementById('box')!;
        view.reset(); view.render(snapshot); view.hear(operation === 'poll' ? 64000 : 1000);
        (window as any).holdScroll = true;
        box.scrollTop = 20;
        const before = box.scrollTop, changes = (window as any).changes;
        if (operation === 'poll') view.render(snapshot); else view.hear(64000);
        const after = box.scrollTop, notified = (window as any).changes > changes;
        (window as any).holdScroll = false;
        box.dispatchEvent(new Event('scroll'));
        view.hear(68000);
        return { before, after, afterDelivery: box.scrollTop, notified };
      }, operation);
      assert.deepEqual(positions, { before: 20, after: 20, afterDelivery: 20, notified: true }, `${operation}: playback must respect scroll before event delivery`);
    }
  } finally { await page.close(); }
}
