// Worker-local UTC step only; no OS clock change and no alternate production DSP/scheduler.
import { parentPort } from 'node:worker_threads';
const wall = Date.now.bind(Date), start = performance.now();
let stepped = false;
Date.now = () => {
  const step = performance.now() - start >= 40;
  if (step && !stepped) { stepped = true; parentPort!.postMessage({ kind: 'echo-observed', event: 'utc-step' }); }
  return wall() - (step ? 1000 : 0);
};
await import('./echo-observed-worker.ts');
export {};
