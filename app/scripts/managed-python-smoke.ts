// Explicit diagnostic: default preparation MAY DOWNLOAD. --offline forbids downloads, including preparation.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePython, stopPython } from '../src/python-env.ts';
import { readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';
import { toolEnv } from '../pi-extensions/tool-sandbox.ts';

export const MATH_CASES = [
  { name: 'numpy', code: `import numpy as np\nassert np.__version__ == '2.2.6'\na = np.array([[1., 2.], [3., 4.]])\nassert np.allclose(a @ np.array([2., 1.]), [4., 10.])\nprint('PASS numpy')` },
  { name: 'scipy.linalg.solve', code: `import numpy as np\nfrom scipy.linalg import solve\nimport scipy\nassert scipy.__version__ == '1.17.1'\na = np.array([[3., 1.], [1., 2.]])\nx = solve(a, np.array([9., 8.]))\nassert np.allclose(x, [2., 3.])\nprint('PASS scipy.linalg.solve')` },
  { name: 'scipy.sparse.linalg.svds', code: `import numpy as np\nfrom scipy.sparse import diags\nfrom scipy.sparse.linalg import svds\nimport scipy\nassert scipy.__version__ == '1.17.1'\na = diags([1., 2., 4., 8.], format='csr')\ns = svds(a, k=1, return_singular_vectors=False, v0=np.ones(4))\nassert np.allclose(s, [8.])\nprint('PASS scipy.sparse.linalg.svds')` },
  { name: 'sympy', code: `import sympy as sp\nassert sp.__version__ == '1.14.0'\nx = sp.Symbol('x')\nassert sp.integrate(x**2, (x, 0, 3)) == 9\nassert sp.solve(x**2 - 4, x) == [-2, 2]\nprint('PASS sympy')` },
] as const;

/** Keep failed tool/exception diagnostics useful without dumping the full bounded output. */
export function smokeErrorExcerpt(text: string): string { return text.split(/\r?\n/).slice(0, 20).join('\n'); }

/** Uses first-Compute preparation, then the actual extension tool (owner, offline uv, and final Seatbelt profile). */
async function managedPythonSmoke(directory: string, offline = false): Promise<boolean> {
  const data = resolve(directory), before = process.cwd(), saved = { ...process.env };
  await mkdir(join(data, 'scratch'), { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(data, 'scratch', 'managed-python-smoke-'));
  const controller = new AbortController();
  const stop = () => { controller.abort(); stopPython(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const home = join(cwd, 'home'), temporary = join(cwd, '.tmp');
    await mkdir(home, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
    process.env = { ...toolEnv(saved), HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), MEETING_DATA_DIR: data,
      MEETING_PROCESS_DIR: join(cwd, 'processes'), TMPDIR: temporary, TMP: temporary, TEMP: temporary, [READ_SCOPE_ENV]: JSON.stringify(readRoots([cwd])),
      RUN_PYTHON_MS: '120000', RUN_PYTHON_MAX_RUNS: String(MATH_CASES.length), ...(offline ? { UV_OFFLINE: '1' } : {}) };
    delete process.env.RUN_PYTHON_USED;
    process.chdir(cwd);
    console.log(offline ? 'Preparation is offline: downloads forbidden.' : 'Preparation may download managed CPython 3.12 from GitHub and pinned packages from the configured index (PyPI by default).');
    let passed = true;
    try { await ensurePython(data); console.log('PASS prepare'); }
    catch (error) {
      passed = false; console.log(`FAIL prepare${offline ? ' (managed interpreter/packages unavailable offline)' : ' (managed runtime preparation failed)'}`);
      console.log(smokeErrorExcerpt(error instanceof Error ? error.message : String(error)));
    }
    // Import only after setting the per-task environment: the extension captures its budgets and process-record directory.
    const { default: register } = await import('../pi-extensions/run-python.ts');
    let tool: any; register({ registerTool: (definition: any) => { tool = definition; } } as any);
    for (const check of MATH_CASES) {
      try {
        const result = await tool.execute(check.name, { code: check.code }, controller.signal);
        const output = result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim();
        const ok = !result.isError && output === `PASS ${check.name}`;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${check.name}`);
        if (!ok && output) console.log(smokeErrorExcerpt(output));
        passed &&= ok;
      } catch (error) {
        passed = false; console.log(`FAIL ${check.name}`);
        console.log(smokeErrorExcerpt(error instanceof Error ? error.message : String(error)));
      }
    }
    return passed;
  } finally {
    stopPython(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.chdir(before); process.env = saved;
    await rm(cwd, { recursive: true, force: true }); // Keep only the app-owned prepared runtime/cache, never delete the given data dir.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), offline = args.includes('--offline'), paths = args.filter(arg => !arg.startsWith('--'));
  if (args.includes('--help')) {
    console.log('Usage: node --experimental-strip-types scripts/managed-python-smoke.ts DATA_DIR [--offline]\nDefault preparation uses the first-Compute code path and may download managed Python/packages. Use a temporary DATA_DIR. --offline prohibits downloads. Runs real numpy/scipy native-library/sympy computations through run_python.');
  } else if (paths.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--offline')) {
    console.error('Supply an explicit DATA_DIR and optional --offline; use --help for download and cleanup details.'); process.exitCode = 2;
  } else {
    try { if (!await managedPythonSmoke(paths[0], offline)) process.exitCode = 1; }
    catch { console.error('FAIL setup'); process.exitCode = 1; }
  }
}
