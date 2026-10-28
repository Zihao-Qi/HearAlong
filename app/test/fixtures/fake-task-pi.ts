// Test-only stand-in for `pi --mode json` in a recorded process group: never calls a model.
// Usage: fake-task-pi.ts <mode> <out.json>. Every mode first says whether its own record was on disk when it started, streams a
// little text and one web tool call, then:
//   answer    — a normal answer, and exits;
//   ratelimit — the model's rate-limit error, and exits 1;
//   python    — starts a "script" recorded like run_python's (its own group) and a helper in its own group, writes their pids to
//               <out.json>, and waits forever (to be cancelled, timed out or killed);
//   leaky     — leaves a helper in Pi's group holding Pi's stdout, answers and exits; leaky-detached: the helper is in a
//               group of its own;
//   stubborn  — leaves a helper in Pi's group that ignores SIGTERM, writes the pids to <out.json>, and waits forever;
//   hang      — waits forever.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnGated } from '../../pi-extensions/process-groups.ts';

const [mode, outPath] = process.argv.slice(2);
const dir = process.env.MEETING_PROCESS_DIR;
const out = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
const recorded = Boolean(dir && existsSync(join(dir, `pi-${process.pid}.json`)));
const forever = () => setInterval(() => {}, 60_000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = async (data: unknown) => { await writeFile(`${outPath}.tmp`, JSON.stringify(data)); await rename(`${outPath}.tmp`, outPath); };

out({ type: 'agent_start' });
out({ type: 'message_start', message: { role: 'assistant' } });
out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `recorded=${recorded}` } });
out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'web_search', args: { query: 'q' } });
out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'web_search', isError: false, result: { content: [{ type: 'text', text: 'found it' }] } });
out({ type: 'message_start', message: { role: 'assistant' } });
out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'and more' } });

if (mode === 'answer') {
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `answer recorded=${recorded}` }], provider: 'fake', model: 'fake-1' } });
  out({ type: 'agent_settled', aborted: false });
  if (outPath) await report({ pi: process.pid, recorded });
} else if (mode === 'ratelimit') {
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'You have hit your usage limit (429).', content: [] } });
  process.exitCode = 1;
} else if (mode === 'python') {
  const script = await spawnGated(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { dir: dir!, kind: 'python', cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] });
  script.release();
  // A helper in Pi's own group (an ordinary child): ended with Pi's group.
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  await report({ pi: process.pid, python: script.record.pid, helper: helper.pid, recorded });
  forever();
} else if (mode === 'leaky' || mode === 'leaky-detached') {
  // A helper that inherited Pi's stdout and outlives it: in Pi's own group, or in a group of its own (not recorded anywhere).
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: mode === 'leaky-detached' });
  helper.unref();
  await report({ pi: process.pid, helper: helper.pid, recorded });
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'answer with a helper left' }], provider: 'fake', model: 'fake-1' } });
  out({ type: 'agent_settled', aborted: false });
} else if (mode === 'stubborn') {
  // A helper in Pi's group that ignores SIGTERM: only the SIGKILL of the cleanup ends it.
  const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], { stdio: 'ignore' });
  await sleep(300); // its handler is in place
  await report({ pi: process.pid, helper: helper.pid, recorded });
  forever();
} else forever();
