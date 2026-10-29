import { test } from 'node:test';
import assert from 'node:assert/strict';
import register from '../pi-extensions/calculate.ts';

test('continuations have no calculation runs left, even when stage 1 used fewer than three; definition stays identical', async () => {
  const before = { ...process.env };
  try {
    process.env.CALCULATE_MS = '60000'; process.env.CALCULATE_MAX_RUNS = '3';
    const getTool = () => { let tool: any; register({ registerTool: (t: any) => { tool = t; } } as any); return tool; };
    delete process.env.CALCULATE_USED;
    const first = getTool();
    for (const used of [0, 1, 3]) {
      process.env.CALCULATE_USED = String(used);
      const copy = getTool();
      for (const key of ['name', 'description', 'parameters', 'promptSnippet', 'promptGuidelines']) assert.deepEqual(copy[key], first[key]);
      await assert.rejects(copy.execute('copy', { code: 'console.log("not executed")' }), /calculate limit reached \(3 runs in this task\)/);
    }
  } finally { process.env = before; }
});
