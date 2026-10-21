// Scripted token hypotheses on the stream audio clock. Feed's first sample chooses a revision; no model is loaded.
let window: string | undefined;
const token = (text: string, t0Ms: number, t1Ms: number) => ({ text: ` ${text}`, t0Ms, t1Ms });
const stable = token('stable', 100, 200), carry = token('carry', 1100, 1300);
const cases: Record<number, { tokens: ReturnType<typeof token>[]; committedMs: number }> = {
  0: { tokens: [], committedMs: 0 },
  1: { tokens: [token('before', 100, 300), token('carry', 17100, 17300), token('tail', 23100, 23300)], committedMs: 24000 },
  2: { tokens: [stable, carry], committedMs: 400 },
  3: { tokens: [stable], committedMs: 400 },
  4: { tokens: [stable, carry], committedMs: 1300 },
  6: { tokens: [stable, token('far', 7400, 7600)], committedMs: 400 },
  8: { tokens: [token('tab-tie', 100, 300)], committedMs: 1000 },
};
process.on('message', (message: any) => {
  if (message.kind === 'shutdown') { process.disconnect(); return; }
  if (message.kind === 'begin') { window = message.window; return; }
  if (message.kind !== 'feed') return;
  if (message.window !== window) { process.send?.({ kind: 'ack', window: message.window }); return; }
  const revision = Math.round(message.pcm[0]), hypothesis = cases[revision];
  if (!hypothesis) throw new Error(`Unknown hypothesis ${revision}`);
  process.send?.({ kind: 'draft', window, ...hypothesis, receivedMs: 24000,
    text: hypothesis.tokens.map(t => t.text.trim()).join(' ') });
});
process.send?.({ kind: 'ready', backend: 'scripted-hypotheses' });
