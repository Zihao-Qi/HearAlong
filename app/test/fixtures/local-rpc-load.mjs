#!/usr/bin/env node
// Scaled cold loading and RPC only; never loads Pi or connects to a model server.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const emit = value => console.log(JSON.stringify(value));
const log = event => appendFileSync(process.env.RPC_LOAD_LOG, `${JSON.stringify({ event, pid: process.pid })}\n`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
process.on('exit', () => log('exit'));
createInterface({ input: process.stdin }).on('line', async line => {
  const command = JSON.parse(line);
  emit({ type: 'response', id: command.id, success: true });
  if (command.type !== 'prompt') return;
  log('loading');
  if (command.message === 'hang') return;
  const loadMs = Number(process.env.RPC_LOAD_MS ?? 0), loadBound = Number(process.env.RPC_LOAD_BOUND_MS ?? 3000);
  await delay(Math.min(loadMs, loadBound));
  if (loadMs >= loadBound) {
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Fictional model did not finish loading.', content: [] } });
  } else {
    log('loaded');
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Fictional answer' }] } });
  }
  emit({ type: 'agent_settled', aborted: false });
});
