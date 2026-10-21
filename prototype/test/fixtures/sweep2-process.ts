// Local-only harness: no Pi executable, uv download or model. The schema stub is unused by the tool execution.
import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { spawnGated } from '../../pi-extensions/process-groups.ts';

const [mode, directory, out] = process.argv.slice(2);
if (mode === 'gate') {
  await spawnGated('/bin/sleep', ['30'], { dir: directory, kind: 'pi', cwd: directory, stdio: ['ignore', 'ignore', 'ignore'] });
} else {
  registerHooks({
    resolve(specifier, context, next) { return specifier === 'typebox' ? { url: 'sweep2:typebox', shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === 'sweep2:typebox' ? { format: 'module', source: 'export const Type = { Object: x => x, String: x => x };', shortCircuit: true } : next(url, context); },
  });
  process.chdir(directory);
  const extensionPath = '../../pi-extensions/run-python.ts';
  const { default: extension } = await import(extensionPath);
  let tool: any;
  extension({ registerTool: (definition: any) => { tool = definition; } } as any);
  const success = await tool.execute('success', { code: 'import subprocess, sys\nsubprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])\nprint(42, flush=True)\n' });
  const timeout = await tool.execute('timeout', { code: 'import time\ntime.sleep(20)\n' });
  await writeFile(out, JSON.stringify({ success, timeout }));
}
