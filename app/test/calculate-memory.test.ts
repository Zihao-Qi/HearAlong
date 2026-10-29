import { test } from 'node:test';
import assert from 'node:assert/strict';
import { physicalFootprintBytes } from '../pi-extensions/calculate.ts';

test('calculation footprint parser reads only the requested PID and handles top units', () => {
  for (const [value, bytes] of [
    ['1024B', 1024], ['4096K', 4 * 1024 ** 2], ['512M', 512 * 1024 ** 2],
    ['513M+', 513 * 1024 ** 2], ['511M-', 511 * 1024 ** 2], ['1.5G', 1.5 * 1024 ** 3], ['1T', 1024 ** 4],
  ] as const) {
    const output = `Processes: 512 total\n2026/10/29 16:47:23\nPhysMem: 15G used\n\nPID MEM\n  123 ${value}  \n124 900M\n`;
    assert.equal(physicalFootprintBytes(output, 123), bytes, value);
    assert.equal(physicalFootprintBytes(output, 124), 900 * 1024 ** 2);
    assert.equal(physicalFootprintBytes(output, 12), null);
  }
});

test('calculation footprint parser rejects missing, zero, malformed and ambiguous samples', () => {
  for (const output of ['', 'PID MEM\n', '124 600M', '123 N/A', '123 0B', '123 -1M', '123 512', '123 512MB', '123 NaNM', '123 InfinityG', '123 600M extra']) {
    assert.equal(physicalFootprintBytes(output, 123), null, output);
  }
});
