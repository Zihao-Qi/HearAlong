// Worker-local UTC step only; no OS clock change and no alternate production DSP/scheduler.
const wall = Date.now.bind(Date), start = performance.now();
Date.now = () => wall() - (performance.now() - start >= 40 ? 1000 : 0);
await import('../../src/echo-worker.ts');
export {};
