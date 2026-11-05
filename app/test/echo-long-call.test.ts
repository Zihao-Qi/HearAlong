import test from 'node:test';
import { simulateEchoCall } from '../scripts/bench/aec-simulation.ts';
import { delayedAec } from './fixtures/delayed-aec.ts';
for (const ppm of [-200, 200]) test(`two-hour sample identity: mic ${ppm} ppm, call ${-ppm} ppm, sleep, +30 s UTC step, delayed pre-sleep callback and leave/rejoin`, async () => {
  const result = await simulateEchoCall(delayedAec().module, { exact: true, ppm });
  console.log('AEC_LONG_CALL', JSON.stringify(result));
});
