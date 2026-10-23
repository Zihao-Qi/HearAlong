// Fictional, local-only Pi stand-in. Understands the real task arguments and copied-session continuation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1];
const configPath = process.env.FAKE_PLAN_CONFIG!;
const config = JSON.parse(await readFile(configPath, 'utf8'));
const prompt = args.at(-1)!;
const stage = args.includes('--session') ? Number(/for plan P(\d+)/.exec(prompt)?.[1] ?? 0) : -1;
const name = stage === -1 ? 'stage1' : stage === 0 ? 'fallback' : `p${stage}`;
const session = stage === -1 ? join(flag('--session-dir'), 'session.jsonl') : flag('--session');
await mkdir(dirname(session), { recursive: true });
if (stage === -1) await writeFile(session, JSON.stringify({ original: true, configPath }));
else if (!JSON.parse(await readFile(session, 'utf8')).original) throw new Error('not a copied session');
await writeFile(join(dirname(configPath), `${name}.json`), JSON.stringify({ args, pid: process.pid, env: { RUN_PYTHON_MS: process.env.RUN_PYTHON_MS, RUN_PYTHON_MAX_RUNS: process.env.RUN_PYTHON_MAX_RUNS, RUN_PYTHON_USED: process.env.RUN_PYTHON_USED }, recorded: existsSync(join(process.env.MEETING_PROCESS_DIR!, `pi-${process.pid}.json`)) }));
const event = (e: unknown) => process.stdout.write(JSON.stringify(e) + '\n');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const setting = stage === -1 ? config.stage1 ?? {} : config.writers?.[stage] ?? {};
process.on('SIGTERM', () => { void writeFile(join(dirname(configPath), `${name}.aborted`), 'aborted').then(() => process.exit(0)); });
if (config.material) {
  const line = stage === -1 ? 1 : stage + 1;
  event({ type: 'tool_execution_start', toolCallId: 'same-id', toolName: 'read', args: { path: config.material, offset: line, limit: 1 } });
  await sleep(stage === 1 ? 70 : 10); // starts overlap across writers
  const text = (await readFile(config.material, 'utf8')).split('\n')[line - 1];
  event({ type: 'tool_execution_end', toolCallId: 'same-id', toolName: 'read', result: { content: [{ type: 'text', text }] } });
}
if (stage === -1) {
  event({ type: 'tool_execution_start', toolCallId: 'python', toolName: 'run_python', args: { code: 'print(2)' } });
  event({ type: 'tool_execution_end', toolCallId: 'python', toolName: 'run_python', result: { content: [{ type: 'text', text: '2' }], details: { runNumber: 1, script: 'run-1.py', stdout: '2', stderr: '', status: 'exit 0', exitCode: 0 } } });
}
if (setting.hang) await new Promise(() => { setInterval(() => {}, 10000); });
await sleep(setting.delay ?? 0);
if (setting.rate) {
  await writeFile(join(dirname(configPath), `${name}.rate`), String(Date.now()));
  if (setting.retryEvent) event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 60000, errorMessage: '429 rate limit: quota used up' });
  else event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit: quota used up', content: [], model: 'fiction/model', usage: { input: 1, output: 0, cacheRead: 38000 } } });
  // Model Pi's own retry loop: the invocation does not settle after the provider error.
  if (setting.retryRate) await new Promise(() => { setInterval(() => {}, 10000); });
  process.exit(1);
}
const quote = stage === 1 ? 'The paper lanterns stay on the lower shelf until parade day.' : 'The painted crates must remain beside the workshop door until Friday.';
const plan = { label: stage === 1 ? 'Lantern shelf' : 'Painted crates', question: stage === 1 ? 'Where should lanterns stay?' : 'Where should crates stay?', from: [`N${stage}`],
  stateNow: [{ id: `p${stage}k1`, text: quote, source: { type: 'file', path: 'R1/guide.md', line: stage + 1, quote } }],
  answer: { text: 'Use the location in the guide; coordinate with P2.', complete: true, open: null, basis: [`p${stage}k1`] }, next: null,
  labelLine: null, answerLine: 'Use the guide location', stepLine: null, followOn: [], waitingOn: [], decideAfter: [], changeIf: null, further: null,
  checks: stage === 1 ? [{ id: 'p1c1', run: 1, showed: 'Two crates counted' }] : [] };
const text = setting.invalid ? 'not JSON' : setting.empty ? '{"plans":[]}' : stage === -1 ? config.outline ?? 'P1 | Lantern shelf | N1\nP2 | Painted crates | N2\nD | N3 | Already settled' : JSON.stringify({ plans: [plan], deferred: [{ item: 'N4', why: 'ignored' }] });
event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], model: 'fiction/model', usage: { input: stage === -1 ? 45000 : 290, output: 100, cacheRead: stage === -1 ? 0 : 38000 } } });
event({ type: 'agent_settled', aborted: false });
