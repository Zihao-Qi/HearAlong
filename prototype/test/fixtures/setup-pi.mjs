#!/usr/bin/env node
// Fake CLI only: never loads Pi, user settings or credentials, and never accesses the network.
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const state = process.env.FAKE_PI_STATE ? JSON.parse(readFileSync(process.env.FAKE_PI_STATE, 'utf8')) : {};
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
if (state.log) appendFileSync(state.log, `${JSON.stringify({ args, pid: process.pid, model, cwd: process.cwd() })}\n`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms ?? 0));
const emit = value => console.log(JSON.stringify(value));
if (args.includes('--list-models')) {
  await delay(state.listDelay);
  if (state.stderr) console.error(state.stderr);
  console.log(state.table ?? 'No models available. Use /login to log into a provider.');
  process.exit(state.listCode ?? 0);
} else if (args[0] === 'list') {
  await delay(state.webDelay);
  console.log(state.packages ?? 'No packages installed.');
  process.exit(state.webCode ?? 0);
} else if (args[0] === 'auth') {
  await delay(state.authDelay);
  console.log(state.authRaw ?? JSON.stringify(state.auth ?? { status: 'ready', provider: 'example' }));
  process.exit(state.authCode ?? (state.auth?.status === 'not_ready' ? 1 : 0));
} else if (args.includes('rpc')) {
  const input = createInterface({ input: process.stdin });
  input.on('line', async line => {
    const command = JSON.parse(line);
    emit({ type: 'response', id: command.id, success: true });
    if (command.type === 'prompt') {
      await delay(state.taskDelay);
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${model}:${process.pid}` }], stopReason: 'stop' } });
      emit({ type: 'agent_settled', aborted: false });
    }
  });
} else if (args.includes('json')) {
  await delay(state.taskDelay);
  emit({ type: 'message_end', message: { role: 'assistant', provider: 'example', model, content: [{ type: 'text', text: state.taskText ?? 'OK' }], stopReason: state.taskError ? 'error' : 'stop', errorMessage: state.taskError } });
  emit({ type: 'agent_settled', aborted: false });
  process.exit(state.taskCode ?? 0);
} else process.exit(2);
