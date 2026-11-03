#!/usr/bin/env node
'use strict';
// Only the development integration check selects this executable. No audio APIs.
const { appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const events = process.env.HEARALONG_DESKTOP_TEST_CAPTURE_EVENTS;
const write = value => appendFileSync(events, JSON.stringify({ ...value, at: Date.now(), pid: process.pid }) + '\n');
if (!existsSync(join(process.env.MEETING_DATA_DIR, 'ready.json'))) throw new Error('Capture started before server readiness');
const [base, origin, group] = process.argv.slice(2);
if (base !== origin || Number(group) <= 0) throw new Error('Missing server arguments');
write({ event: 'start', base, group: Number(group) });
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', async () => {
  const response = await fetch(base + '/');
  write({ event: 'term', serverAlive: response.status < 400 });
  // Model a pending pcm/end drain. The server must stay up until this completes.
  setTimeout(async () => {
    const response = await fetch(base + '/');
    write({ event: 'drained', serverAlive: response.status < 400 });
    clearInterval(timer); process.exit(0);
  }, 600);
});
