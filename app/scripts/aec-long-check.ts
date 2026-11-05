// Public synthetic stress only. No model/device/server/playback/network; uses the actual WASM and worker scheduler.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { simulateEchoCall } from './bench/aec-simulation.ts';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('Usage: aec-long-check.ts --out NEW_DIR (two synthetic hours)');
const directory = resolve(values.out); await mkdir(directory, { mode: 0o700 });
const module = await WebRtcAec3(), start = performance.now(), cpu = process.cpuUsage();
const result = await simulateEchoCall(module, { exact: false });
const used = process.cpuUsage(cpu);
const summary = { ...result, wallSeconds: (performance.now() - start) / 1000, cpuSeconds: (used.user + used.system) / 1e6 };
await writeFile(join(directory, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
