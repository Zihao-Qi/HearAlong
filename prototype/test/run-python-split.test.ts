import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('continuations have no Python runs left, even when stage 1 used fewer than three; tool definition stays identical', async () => {
  // Fail safely on an old extension, before it could start uv or execute any Python.
  const source = await readFile(new URL('../pi-extensions/run-python.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.RUN_PYTHON_USED/);
  const before = { ...process.env };
  try {
    process.env.RUN_PYTHON_MS = '60000'; process.env.RUN_PYTHON_MAX_RUNS = '3';
    const { default: register } = await import('../pi-extensions/run-python.ts');
    const getTool = () => { let tool: any; register({ registerTool: (t: any) => { tool = t; } } as any); return tool; };
    delete process.env.RUN_PYTHON_USED;
    const first = getTool();
    for (const used of [0, 1, 3]) {
      process.env.RUN_PYTHON_USED = String(used);
      const copy = getTool();
      for (const key of ['name', 'description', 'parameters', 'promptSnippet', 'promptGuidelines']) assert.deepEqual(copy[key], first[key]);
      // An already-stopped signal is not used: rejection must be the existing budget error, before any script is written.
      await assert.rejects(copy.execute('copy', { code: 'print("not executed")' }), /run_python limit reached \(3 runs in this task\)/);
    }
    process.env.RUN_PYTHON_USED = '3';
    await assert.rejects(getTool().execute('copy', { code: 'print("not executed")' }), /limit reached/);
  } finally { process.env = before; }
});
