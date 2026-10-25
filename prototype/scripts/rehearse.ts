// A disposable, real-time Chrome microphone rehearsal. No app code or user's browser profile is changed.
import { testBrowser } from './test-browser.ts';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { startServer } from '../src/server.ts';
import { clock, loadWav, parseArgs, validateRunFiles, writeTrimmed } from './rehearsal-input.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = join(ROOT, 'prototype/artifacts/rehearsal/runs');
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** The optional observer drives lifecycle/UI checks; the command itself always uses the real UI unmodified. */
export async function runRehearsal(argv: string[], observe?: (page: Page) => Promise<void>) {
  const args = parseArgs(argv);
  // All input validation precedes starting a server or Chrome (or creating a run).
  const mic = args.mic ? await loadWav(resolve(args.mic), args.from, args.minutes) : undefined;
  const them = args.them ? await loadWav(resolve(args.them), args.from, args.minutes) : undefined;
  const executable = testBrowser();
  try { await access(executable); }
  catch { throw new Error(`Google Chrome is not installed at ${executable}.`); }
  let directory: string;
  if (args.open) {
    directory = await realpath(resolve(args.open)).catch(() => { throw new Error(`Run folder not found: ${args.open}`); });
    // Never let --open turn into an alias for the user's app data. Only this worktree's rehearsal runs are accepted.
    if (!directory.startsWith(`${RUNS}${sep}`)) throw new Error(`Open a rehearsal run inside ${RUNS}.`);
    if (!(await stat(join(directory, 'meetings.sqlite')).catch(() => null))?.isFile()) throw new Error(`No meeting database in ${directory}.`);
    await validateRunFiles(directory);
  } else {
    await mkdir(RUNS, { recursive: true, mode: 0o700 });
    if (await realpath(RUNS) !== RUNS) throw new Error('The rehearsal runs folder must not be a symlink.');
    const date = new Date();
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
    directory = join(RUNS, stamp);
    // Preserve earlier runs in the same minute, rather than reusing their data.
    for (let suffix = 0;; suffix++) {
      directory = join(RUNS, `${stamp}${suffix ? `-${suffix + 1}` : ''}`);
      try { await mkdir(directory, { mode: 0o700 }); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  process.env.MEETING_DATA_DIR = directory;
  process.env.MEETING_CLOUD = args.withModels ? '1' : '0';
  let temporary: string | undefined;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let timer: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined;
  let startedAt: number | null = null, stoppedAt: number | null = null;
  let meetingId: string | undefined, finalsWhileRecording = 0, visibleFinalsWhileRecording = 0;
  let reason = 'error';
  const frames: { at: number; source: string; sequence: number; samples: number }[] = [];
  const ends: { at: number; source: string }[] = [];
  const errors: string[] = [];
  let finish!: (reason: string) => void;
  const finished = new Promise<string>(resolve => { finish = resolve; });
  let cancelled = false;
  let releaseSettlement: (() => void) | undefined;
  const interrupt = () => {
    cancelled = true; finish('interrupted'); releaseSettlement?.();
    // Also break out of an in-progress startup wait, rather than waiting for a selector timeout.
    void stop().catch(() => {}).finally(() => context?.close()).catch(() => {});
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, interrupt);
  const checkpoint = () => { if (cancelled) throw new Error('Rehearsal interrupted.'); };
  const stop = async () => {
    if (!page || page.isClosed()) return;
    if (await page.locator('#stop').isVisible() && await page.locator('#stop').isEnabled()) await page.locator('#stop').click({ force: true, timeout: 5000 });
    await page.locator('#stop').waitFor({ state: 'hidden', timeout: 30_000 });
  };
  try {
    temporary = await mkdtemp(join(tmpdir(), 'meeting-rehearsal-'));
    if (mic) await writeTrimmed(join(temporary, 'mic.wav'), mic);
    if (them) await writeTrimmed(join(temporary, 'them.wav'), them);
    checkpoint();
    const { startServer } = await import('../src/server.ts');
    app = await startServer({ directory, port: 0 });
    checkpoint();
    context = await chromium.launchPersistentContext(join(temporary, 'chrome-profile'), {
      executablePath: executable, headless: args.headless, viewport: null,
      // Our finally owns all cleanup; Playwright's default signal handlers would exit the process before it finishes.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        ...(mic ? [`--use-file-for-fake-audio-capture=${join(temporary, 'mic.wav')}%noloop`] : []),
        '--autoplay-policy=no-user-gesture-required', '--disable-crash-reporter', '--disable-crashpad-for-testing'],
    });
    context.on('close', () => finish('window closed'));
    checkpoint();
    page = context.pages()[0] ?? await context.newPage();
    page.on('close', () => finish('window closed'));
    page.on('dialog', dialog => void dialog.accept()); // Closing a recording window must not get stuck on beforeunload.
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      if (new URL(request.url()).pathname.endsWith('/pcm')) frames.push({ at: Date.now(), source: request.headers()['x-audio-source'], sequence: Number(request.headers()['x-sequence']), samples: (request.postDataBuffer()?.length ?? 0) / 4 });
      if (new URL(request.url()).pathname.endsWith('/pcm/end')) ends.push({ at: Date.now(), source: request.postDataJSON().source });
    });
    await page.goto(app.url);
    console.log(mic ? `Playing ${resolve(args.mic!)}${args.them ? ` + Them: ${resolve(args.them)}` : ''}\nFrom ${clock(args.from)} for ${clock(mic.seconds)}${args.withModels ? ' (cloud models on)' : ' (cloud models off)'}` : `Viewing ${directory} (cloud models ${args.withModels ? 'on' : 'off'})`);
    console.log(`${app.url}\nPress Ctrl+C to stop.`);
    if (mic) {
      await page.exposeFunction('__rehearsalStarted', (at: number) => {
        if (startedAt !== null) return;
        startedAt = at;
        timer = setTimeout(() => finish('audio ended'), Math.max(0, at + mic.seconds * 1000 - Date.now()));
      });
      if (them) await page.route('**/__rehearsal-them.wav', route => route.fulfill({ body: them.bytes, contentType: 'audio/wav' }));
      // Only this page is modified. The real app's worklet, upload queues, recognition and Stop stay untouched.
      await page.evaluate(async ({ online }) => {
        let startThem = () => {};
        if (online) {
          const audio = new AudioContext();
          const buffer = await audio.decodeAudioData(await (await fetch('/__rehearsal-them.wav')).arrayBuffer());
          const player = audio.createBufferSource(); player.buffer = buffer;
          const dest = audio.createMediaStreamDestination(); player.connect(dest);
          startThem = () => { void audio.resume(); player.start(); };
          const track = dest.stream.getAudioTracks()[0];
          const originalStop = track.stop.bind(track);
          track.stop = () => { originalStop(); try { player.stop(); } catch { /* not started */ } void audio.close(); };
          navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
            const video = canvas.captureStream(1).getVideoTracks()[0];
            Object.defineProperty(video, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
            return new MediaStream([video, track]);
          };
        }
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
          const stream = await original(constraints);
          startThem(); startThem = () => {};
          void (window as unknown as { __rehearsalStarted(at: number): Promise<void> }).__rehearsalStarted(Date.now());
          return stream;
        };
      }, { online: Boolean(them) });
      await page.locator('#meeting-button').click();
      await page.locator('#new-meeting').click();
      await page.locator('#meeting-name').fill(`Rehearsal: ${basename(args.mic!)} from ${clock(args.from)}`);
      await page.locator('#meeting-name').press('Enter');
      await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
      meetingId = app.store.meetings().find(m => m.title === `Rehearsal: ${basename(args.mic!)} from ${clock(args.from)}`)?.id;
      checkpoint();
      await page.locator('#start').click();
      await page.locator(them ? '#start-online' : '#start-mic').click();
      await page.locator('#stop').waitFor({ state: 'visible', timeout: 15_000 });
      poll = setInterval(() => {
        if (page!.isClosed()) return;
        if (meetingId) finalsWhileRecording = Math.max(finalsWhileRecording, app!.store.segments(meetingId).length);
        void page!.locator('#transcript span[data-id]').count().then(count => { visibleFinalsWhileRecording = Math.max(visibleFinalsWhileRecording, count); }, () => {});
        void page!.locator('#stop').isVisible().then(visible => { if (!visible) finish('user stopped'); }, () => {});
      }, 500);
    }
    await observe?.(page);
    reason = await finished;
    clearTimeout(timer); clearInterval(poll);
    await stop();
    stoppedAt = Date.now();
    // A closed page cannot flush its partial frame. End every saved source so reopening shows a finished recording.
    if (mic && page.isClosed()) for (const source of app.store.openRecordings()) await app.capture.end(source.meetingId, source.source, null);
    // Stop seals the tail; let local finals settle before shutting down their worker. No cloud work is awaited.
    // A signal can interrupt this wait too (the recognizer has its own bounded shutdown).
    if (!cancelled) await Promise.race([app.jobs?.wait(), new Promise<void>(resolve => { releaseSettlement = resolve; })]);
  } catch (error) {
    if (!cancelled && !page?.isClosed()) throw error;
    reason = cancelled ? 'interrupted' : 'window closed';
  } finally {
    clearTimeout(timer); clearInterval(poll);
    // In a failed startup or interrupt, still give the real Stop path a chance to flush its queued frames.
    try { await stop(); } catch { /* closed page or failed startup: server close seals saved frames */ }
    try {
      if (mic && app) {
        await writeFile(join(directory, 'rehearsal.json'), JSON.stringify({
          mic: resolve(args.mic!), them: args.them ? resolve(args.them) : null,
          from: args.from, seconds: mic.seconds, url: app.url, pid: process.pid, temporary,
          reason, startedAt, stoppedAt, meetingId, finalsWhileRecording, visibleFinalsWhileRecording,
          finals: meetingId ? app.store.segments(meetingId).length : 0,
          frames, ends, errors,
        }, null, 2));
      }
    } finally {
      try { await context?.close(); }
      finally {
        try { await app?.close(); }
        finally {
          if (temporary) await rm(temporary, { recursive: true, force: true });
          for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, interrupt);
          console.log(`Run data: ${directory} — reopen: npm run rehearse -- --open ${shellQuote(directory)}`);
        }
      }
    }
  }
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runRehearsal(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
