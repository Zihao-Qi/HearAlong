// Test-only stand-in for `pi --mode rpc`: speaks the JSONL protocol, never calls a model.
let input = '';
let emptyOnce = true;
let abandoned = false;
let resetMode: 'ok' | 'fail' | 'silent' = 'ok';
const out = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
const answer = (text: string) => {
  out({ type: 'agent_start' });
  out({ type: 'message_end', message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [], provider: 'fake', model: 'fake-1', stopReason: 'stop' } });
  out({ type: 'agent_settled', aborted: false });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (part: string) => {
  input += part;
  for (let i = input.indexOf('\n'); i >= 0; i = input.indexOf('\n')) {
    const command = JSON.parse(input.slice(0, i));
    input = input.slice(i + 1);
    if (command.type === 'extension_ui_response') { answer(`dialog ${command.cancelled ? 'cancelled' : 'answered'}`); continue; }
    if (command.type === 'new_session' && resetMode === 'silent') continue;
    if (command.type === 'prompt' && abandoned) { abandoned = false; answer('answer to FIRST'); }
    if (command.type === 'prompt' && command.message === 'no-ack') {
      abandoned = true; // Deliver the late answer on the next prompt if this child is incorrectly reused.
      out({ type: 'extension_ui_request', method: 'notify', message: 'no-ack received' });
      continue;
    }
    if (command.type === 'new_session' && resetMode === 'fail') { out({ type: 'response', id: command.id, command: 'new_session', success: false, error: 'cancelled by extension' }); continue; }
    out({ type: 'response', id: command.id, command: command.type, success: true, data: command.type === 'prompt' ? { disposition: 'started' } : {} });
    if (command.type !== 'prompt') continue;
    const message = String(command.message);
    if (message === 'reset-fails' || message === 'reset-silent') { resetMode = message === 'reset-fails' ? 'fail' : 'silent'; answer('reset mode set'); }
    else if (message === 'pid') answer(String(process.pid));
    else if (message === 'split') {
      // One record delivered in two writes, containing a U+2028 that readline would split on.
      const record = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a b' }] } });
      process.stdout.write(record.slice(0, 20));
      setTimeout(() => { process.stdout.write(`${record.slice(20)}\n`); out({ type: 'agent_settled', aborted: false }); }, 20);
    } else if (message === 'empty-once') {
      answer(emptyOnce ? '' : 'second try');
      emptyOnce = false;
    } else if (message === 'dialog') {
      out({ type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Allow?' });
    } else if (message === 'hang') {
      // Never settles.
    } else answer(`echo: ${message}`);
  }
});
process.stdin.on('end', () => process.exit(0));
