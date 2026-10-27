#!/usr/bin/env node
// Fictional Pi protocol fixture: no models, credentials, or network.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const emit = value => console.log(JSON.stringify(value));
const log = event => appendFileSync(process.env.LANE_LOG, JSON.stringify({ event, pid: process.pid }) + '\n');
log('start');
process.on('exit', () => log('end'));
const answer = async () => {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.LANE_DELAY ?? 100)));
  const text = JSON.stringify({ summary: [{ text: 'Keep the lanterns on the rack.', cites: ['S1'], quote: 'Keep the painted lanterns on the rack' }] });
  emit({ type: 'text_delta', delta: text });
  emit({ type: 'message_end', message: { role: 'assistant', provider: 'ollama', model: 'fictional:4b', stopReason: 'stop', content: [{ type: 'text', text }] } });
  emit({ type: 'agent_settled', aborted: false });
};
if (args.includes('rpc')) {
  const input = createInterface({ input: process.stdin });
  input.on('line', async line => { const command = JSON.parse(line); emit({ type: 'response', id: command.id, success: true }); if (command.type === 'prompt') await answer(); });
} else { await answer(); }
