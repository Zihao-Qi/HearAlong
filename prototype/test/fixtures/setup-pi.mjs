#!/usr/bin/env node
// Fake CLI only: never loads Pi, user settings or credentials, and never accesses the network.
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const state = process.env.FAKE_PI_STATE ? JSON.parse(readFileSync(process.env.FAKE_PI_STATE, 'utf8')) : {};
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
// The variables HearAlong sets for Pi (fictional keys only), so tests can see what each spawn path received.
const env = Object.fromEntries(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PI_TELEMETRY', 'PI_SKIP_VERSION_CHECK', 'PI_OFFLINE'].filter(name => name in process.env).map(name => [name, process.env[name]]));
if (state.log) appendFileSync(state.log, `${JSON.stringify({ args, pid: process.pid, model, cwd: process.cwd(), env })}\n`);
// A provider is signed in through Pi (`stored`, like auth.json) or has its key in the environment; either lists its `keyRows`.
const VARS = { google: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
// `ignoreEnv`: a Pi that does not pick up keys from its environment.
const ready = provider => (state.stored ?? []).includes(provider) || (!state.ignoreEnv && Boolean(process.env[VARS[provider]]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms ?? 0));
const emit = value => console.log(JSON.stringify(value));
if (args.includes('--list-models')) {
  await delay(state.listDelay);
  if (state.stderr) console.error(state.stderr);
  const extra = Object.entries(state.keyRows ?? {}).filter(([provider]) => ready(provider)).flatMap(([, rows]) => rows);
  const rows = extra.map(row => row.split(' ').join('  ')).join('\n');
  const table = !extra.length ? state.table : state.table && !state.table.startsWith('No models') ? `${state.table.trimEnd()}\n${rows}`
    : `provider  model  context  max-out  thinking  images\n${rows}`;
  console.log(table ?? 'No models available. Use /login to log into a provider.');
  process.exit(state.listCode ?? 0);
} else if (args[0] === 'list') {
  await delay(state.webDelay);
  console.log(state.packages ?? 'No packages installed.');
  process.exit(state.webCode ?? 0);
} else if (args[0] === 'auth' && args.includes('--provider')) {
  const provider = args[args.indexOf('--provider') + 1];
  await delay(state.authDelay);
  if (state.providerAuthRaw !== undefined) { console.log(state.providerAuthRaw); process.exit(state.providerAuthCode ?? 2); }
  const stored = (state.stored ?? []).includes(provider);
  console.log(JSON.stringify(stored || ready(provider) ? { status: 'ready', provider, authType: stored ? state.storedType ?? 'oauth' : 'api_key' }
    : { status: 'not_ready', provider, reason: 'credentials_not_configured' }));
  process.exit(stored || ready(provider) ? 0 : 1);
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
