import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(outcome: (attempt: number) => unknown, durations: number[] = [], jumps: number[] = []) {
  const { uploadWithRetry } = await import('../public/upload-retry.js');
  let now = 1000;
  const attempts: { at: number; timeout: number }[] = [], waits: number[] = [];
  return {
    attempts, waits, elapsed: () => now - 1000,
    run: (until?: number) => uploadWithRetry({
      until, now: () => now,
      sleep: async (ms: number) => { now += ms + (jumps[waits.length] ?? 0); waits.push(ms); },
      attempt: async (timeout: number) => {
        attempts.push({ at: now, timeout });
        now += durations[attempts.length - 1] ?? 0;
        return outcome(attempts.length);
      },
    }),
  };
}
const network = new Error('network unavailable');
const http = (status: number) => Object.assign(new Error(`server says ${status}`), { status });

for (const success of [1, 2, 5]) test(`saves on attempt ${success} with exponential waits capped at four seconds`, async () => {
  const f = await fixture(n => { if (n < success) throw network; return 'saved'; });
  assert.equal(await f.run(), 'saved');
  assert.equal(f.attempts.length, success);
  assert.deepEqual(f.waits, [500, 1000, 2000, 4000].slice(0, success - 1));
});
for (const status of [400, 403, 409, 429, 302]) test(`HTTP ${status} fails without retry`, async () => {
  const error = http(status), f = await fixture(() => { throw error; });
  await assert.rejects(f.run, e => e === error);
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.waits, []);
});
for (const error of [network, new DOMException('aborted', 'AbortError'), http(500), http(503), http(599)]) test(`${error.message} retries`, async () => {
  const f = await fixture(n => { if (n === 1) throw error; return 'saved'; });
  assert.equal(await f.run(), 'saved');
  assert.equal(f.attempts.length, 2);
});
test('thirty seconds after only two failures still owes a third attempt', async () => {
  const f = await fixture(n => { if (n <= 2) throw network; return 'saved'; }, [15000, 15000]);
  assert.equal(await f.run(), 'saved');
  assert.equal(f.attempts.length, 3);
  assert.equal(f.attempts[2].timeout, 10000, 'an owed attempt gets ten seconds after the deadline');
});
test('three quick failures do not give up before thirty seconds', async () => {
  const f = await fixture(() => { throw network; });
  await assert.rejects(f.run, e => e === network);
  assert.ok(f.attempts[2].at - f.attempts[0].at < 5000);
  assert.equal(f.elapsed(), 30000);
  assert.deepEqual(f.waits, [500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000, 2500]);
});
for (const success of [2, 3, null]) test(`ten-minute wake jump still tries required attempts (success ${success})`, async () => {
  const f = await fixture(n => { if (n === success) return 'saved'; throw network; }, [], [600000]);
  if (success) assert.equal(await f.run(), 'saved');
  else await assert.rejects(f.run, e => e === network);
  assert.equal(f.attempts.length, success ?? 3);
  assert.deepEqual(f.attempts.map(a => a.timeout), Array(success ?? 3).fill(10000), 'wake does not shrink owed attempts to zero');
});
test('the first three timeouts are ten seconds; later attempts shrink to the remaining time', async () => {
  const f = await fixture(() => { throw network; }, [10000, 10000, 1000, 5500]);
  await assert.rejects(f.run, e => e === network);
  assert.deepEqual(f.attempts.map(a => a.timeout), [10000, 10000, 10000, 5500]);
  assert.equal(f.elapsed(), 30000);
});
test('a wake with 100 ms remaining still gives the third attempt ten seconds to save', async () => {
  const { uploadWithRetry } = await import('../public/upload-retry.js');
  let now = 0, sleeps = 0;
  const timeouts: number[] = [];
  const saved = await uploadWithRetry({ now: () => now,
    sleep: async ms => { now += ms; if (++sleeps === 2) now = 29900; },
    attempt: async timeout => {
      timeouts.push(timeout);
      if (timeouts.length < 3) throw network;
      now += Math.min(200, timeout);
      if (timeout < 200) throw new Error('attempt timed out');
      return 'saved';
    },
  });
  assert.equal(saved, 'saved');
  assert.deepEqual(timeouts, [10000, 10000, 10000]);
  assert.equal(now, 30100);
});
test('an expired Stop deadline starts zero attempts', async () => {
  const f = await fixture(() => 'saved');
  await assert.rejects(() => f.run(999));
  assert.equal(f.attempts.length, 0);
});
test('a Stop deadline in three seconds caps even the first attempt and ends after one failure', async () => {
  const f = await fixture(() => { throw network; }, [3000]);
  await assert.rejects(() => f.run(4000));
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].timeout, 3000);
  assert.deepEqual(f.waits, []);
});
test('sleeps and subsequent attempts cannot cross the shared Stop deadline', async () => {
  const f = await fixture(() => { throw network; });
  await assert.rejects(() => f.run(4000));
  assert.equal(f.elapsed(), 3000);
  assert.deepEqual(f.attempts.map(a => a.timeout), [3000, 2500, 1500]);
  assert.deepEqual(f.waits, [500, 1000, 1500]);
  assert.ok(f.attempts.every(a => a.at < 4000));
});
test('Stop wins over owed attempts after a sleep jumps beyond its deadline', async () => {
  const f = await fixture(() => { throw network; }, [], [600000]);
  await assert.rejects(() => f.run(4000));
  assert.equal(f.attempts.length, 1);
});
test('an upload already retrying observes a newly established Stop deadline', async () => {
  const { uploadWithRetry } = await import('../public/upload-retry.js');
  let now = 1000, until: number | undefined;
  const timeouts: number[] = [];
  await assert.rejects(() => uploadWithRetry({ now: () => now, get until() { return until; },
    sleep: async ms => { now += ms; },
    attempt: async timeout => {
      timeouts.push(timeout);
      if (timeouts.length === 1) until = now + 3000;
      else now += timeout;
      throw network;
    },
  }));
  assert.deepEqual(timeouts, [10000, 2500]);
  assert.equal(now, 4000);
});
test('Stop establishes one deadline before ending any source and never extends it', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('async function stopCapture()'), app.indexOf('/** Wires a granted stream'));
  let now = 1000, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session: any = { sources: new Map([['mic', {}], ['tab', {}]]), stopping: null };
  const deadlines: number[] = [];
  const stop = runInNewContext(`${code}\nstopCapture`, { capture: session, Date: { now: () => now },
    sourceIds: () => [], post: async () => {}, freezeSource() {}, controls() {}, finishSession: async () => {},
    endSource: (owner: any) => { deadlines.push(owner.drainUntil); return gate; },
  });
  const first = stop(); now = 8000; const again = stop();
  release(); await Promise.all([first, again]);
  assert.equal(session.drainUntil, 31000);
  assert.deepEqual(deadlines, [31000, 31000]);
});
test('endSource during session Stop establishes or reuses the shared deadline even if already ending', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('function endSource('), app.indexOf('/** Stops the physical input'));
  let now = 1000;
  const end = runInNewContext(`${code}\nendSource`, { Date: { now: () => now } });
  const session: any = { stopping: Promise.resolve() }, source = { ending: Promise.resolve() };
  await end(session, source); assert.equal(session.drainUntil, 31000);
  now = 8000; await end(session, source); assert.equal(session.drainUntil, 31000);
});
test('giving up reports the last failure, not the first one', async () => {
  let last: Error;
  const f = await fixture(n => { last = new Error(`failure ${n}`); throw last; }, [10000, 10000, 8500]);
  await assert.rejects(f.run, error => error instanceof Error && error === last && error.message === 'failure 3');
});
test('pageRequest retains the server message and attaches HTTP status', async () => {
  const code = (await readFile(new URL('../public/page-session.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  for (const status of [403, 409, 429, 500, 503]) {
    const request = runInNewContext(`${code}\npageRequest`, {
      crypto, window: { addEventListener() {} },
      fetch: async () => new Response(JSON.stringify({ error: 'fictional server message' }), { status, headers: { 'Content-Type': 'application/json' } }),
    });
    await assert.rejects(request('/api/example'), (error: any) => error.status === status && error.message === 'fictional server message');
  }
  const request = (fetch: typeof globalThis.fetch) => runInNewContext(`${code}\npageRequest`, { crypto, window: { addEventListener() {} }, fetch });
  await assert.rejects(request(async () => new Response('', { status: 403 }))('/api/example'),
    (error: any) => error.status === 403 && error.message === 'HTTP 403');
  await assert.rejects(request(async () => { throw network; })('/api/example'), error => error === network);
});
for (const [status, response] of [
  [409, () => new Response('', { status: 409, headers: { 'Content-Type': 'application/json' } })],
  [403, () => new Response('{bad', { status: 403, headers: { 'Content-Type': 'application/json' } })],
  [429, () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('truncated body')); } }), { status: 429, headers: { 'Content-Type': 'application/json' } })],
] as const) test(`an unreadable HTTP ${status} body keeps its status and is never retried`, async () => {
  const { uploadWithRetry } = await import('../public/upload-retry.js');
  const code = (await readFile(new URL('../public/page-session.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const request = runInNewContext(`${code}\npageRequest`, { crypto, window: { addEventListener() {} }, fetch: async () => response() });
  let now = 0, attempts = 0, failure: any;
  try {
    await uploadWithRetry({ now: () => now, sleep: async ms => { now += ms; },
      attempt: async () => { attempts++; return request('/api/example'); },
    });
  } catch (error) { failure = error; }
  assert.equal(attempts, 1);
  assert.equal(failure?.status, status);
  assert.equal(failure?.message, `HTTP ${status}`);
});
test('successful pageRequest responses keep their original parsing behavior', async () => {
  const code = (await readFile(new URL('../public/page-session.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const request = (response: Response) => runInNewContext(`${code}\npageRequest`, { crypto, window: { addEventListener() {} }, fetch: async () => response })('/api/example');
  assert.deepEqual(await request(Response.json({ saved: true })), { saved: true });
  assert.equal(JSON.stringify(await request(new Response('plain text'))), '{}');
  await assert.rejects(request(new Response('', { headers: { 'Content-Type': 'application/json' } })),
    (error: any) => error.name === 'SyntaxError' && error.status === undefined);
});
