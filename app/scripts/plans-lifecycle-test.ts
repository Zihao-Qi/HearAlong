// Focused real-DOM regression runner; no model, generated fixture content only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../src/server.ts';
import { plansLifecycleCheck } from './plans-lifecycle-check.ts';

const directory = await mkdtemp(join(tmpdir(), 'plans-lifecycle-'));
const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, notes: null, actions: null, board: null, plans: null });
let browser: Browser | undefined;
try {
  assert.ok(process.env.MEETING_TEST_CHROME, 'Set MEETING_TEST_CHROME to the permitted headless shell');
  browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(app.url);
  const checks = await plansLifecycleCheck(page);
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  assert.ok(checks.every(([, ok]) => ok), 'Plans lifecycle regressions');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
