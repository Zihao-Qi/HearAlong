import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const boundaries = new ESLint({ cwd, overrideConfig: [{
  files: ['**/*.ts'],
  languageOptions: { parserOptions: { project: null } },
  rules: { '@typescript-eslint/no-floating-promises': 'off', '@typescript-eslint/no-misused-promises': 'off' },
}] });
async function rules(file: string, code: string, lint = boundaries) {
  const [result] = await lint.lintText(code, { filePath: file });
  assert.ok(!result.messages.some(m => m.fatal), JSON.stringify(result.messages));
  return result.messages.map(m => m.ruleId);
}

test('browser imports and requires cannot cross into server/scripts/tests or node builtins', async () => {
  for (const source of ['../src/server.ts', '../../scripts/check.ts', '../test/helpers/http.ts', '/app/src/store.ts', 'node:fs', 'node:fs/promises']) {
    assert.ok((await rules('public/app.js', `import '${source}';`)).includes('no-restricted-imports'), source);
    assert.ok((await rules('public/app.js', `/* global require */ require('${source}');`)).includes('no-restricted-modules'), source);
  }
  assert.deepEqual(await rules('public/app.js', "import './capture-clock.js';"), []);
});

test('server boundaries cover nested paths, SDK subpaths, reexports and CommonJS', async () => {
  for (const file of ['src/board.ts', 'src/setup/service.ts', 'src/stt-worker.ts']) {
    for (const source of ['../test/helpers/http.ts', '../../scripts/check.ts', 'openai', 'openai/resources', '@anthropic-ai/sdk', '@google/genai', '@google/generative-ai', 'ollama', '@ai-sdk/openai', 'ai', '@langchain/openai', '@huggingface/inference', '@mistralai/mistralai', 'cohere-ai', 'replicate', '@aws-sdk/client-bedrock-runtime', '@earendil-works/pi-ai/compat', '@earendil-works/pi-coding-agent', '../node_modules/openai/index.js', '../node_modules/@google/genai/index.js', '../node_modules/@earendil-works/pi-ai/compat', '@azure/openai', 'groq-sdk', '../pi-extensions/local-models.ts', '../../pi-extensions/local-transport.ts']) {
      assert.ok((await rules(file, `export * from '${source}';`)).includes('no-restricted-imports'), `${file}: ${source}`);
      assert.ok((await rules(file, `require('${source}');`)).includes('no-restricted-modules'), `${file}: ${source}`);
    }
    assert.deepEqual(await rules(file, "import type { MeetingStore } from './store.ts';"), []);
  }
});

test('native speech stays in workers and spawning stays in the named adapters', async () => {
  for (const source of ['transcribe-cpp', 'transcribe-cpp/native', 'node:child_process', 'child_process', 'node:worker_threads']) {
    assert.ok((await rules('src/board.ts', `import '${source}';`)).includes('no-restricted-imports'), source);
    assert.ok((await rules('src/board.ts', `require('${source}');`)).includes('no-restricted-modules'), source);
  }
  assert.deepEqual(await rules('src/stt-worker.ts', "import 'transcribe-cpp';"), []);
  assert.deepEqual(await rules('src/stt-stream-worker.ts', "import 'transcribe-cpp';"), []);
  assert.deepEqual(await rules('src/pi-task.ts', "import 'node:child_process';"), []);
  assert.ok((await rules('src/pi-task.ts', "import 'transcribe-cpp';")).includes('no-restricted-imports'));
});

test('dynamic imports are forbidden in src and require slash-prefixed string literals in public', async () => {
  for (const file of ['src/board.ts', 'src/pi-task.ts', 'src/server.ts', 'src/explorations.ts', 'src/stt-worker.ts']) {
    for (const expression of ["import('./store.ts')", "import('openai')", "import('../scripts/check.ts')", "import('/plans-fixtures.js')", "import(modulePath)"]) {
      assert.ok((await rules(file, expression + ';')).includes('no-restricted-syntax'), `${file}: ${expression}`);
    }
    assert.deepEqual(await rules(file, "import './store.ts'; export type T = import('./store.ts').MeetingStore;"), []);
  }
  for (const code of [
    "import('../src/server.ts');", "import('node:fs');", "import('./capture-clock.js');",
    "import('openai');", "import('https://example.invalid/model.js');",
    "const path = '/plans-fixtures.js'; import(path);", "import(`/plans-fixtures.js`);",
    "const name = 'plans'; import(`/${name}.js`);", "import('/' + 'plans-fixtures.js');", "import(/fixture/);",
  ]) assert.ok((await rules('public/app.js', code)).includes('no-restricted-syntax'), code);
  for (const code of ["import('/plans-fixtures.js');", "import('/capture-clock.js');", "import './capture-clock.js';"]) {
    assert.deepEqual(await rules('public/app.js', code), [], code);
  }
});

test('only the three named server modules can import or require the process-group launcher', async () => {
  const specifiers = ['../pi-extensions/process-groups.ts', '../../pi-extensions/process-groups.ts'];
  for (const file of ['src/board.ts', 'src/recognizer.ts', 'src/setup/service.ts', 'src/stt-worker.ts', 'src/plans/jobs.ts']) {
    for (const source of specifiers) {
      assert.ok((await rules(file, `import '${source}';`)).includes('no-restricted-imports'), file);
      assert.ok((await rules(file, `export * from '${source}';`)).includes('no-restricted-imports'), file);
      assert.ok((await rules(file, `require('${source}');`)).includes('no-restricted-modules'), file);
    }
  }
  for (const file of ['src/pi-task.ts', 'src/server.ts', 'src/explorations.ts']) {
    assert.deepEqual(await rules(file, "import '../pi-extensions/process-groups.ts';"), [], file);
    assert.deepEqual(await rules(file, "require('../pi-extensions/process-groups.ts');"), [], file);
    assert.ok((await rules(file, "import 'openai';")).includes('no-restricted-imports'), file);
    assert.ok((await rules(file, "import 'transcribe-cpp';")).includes('no-restricted-imports'), file);
  }
});

test('promise rules check async test steps, void returns and bare void, not runner-owned registrations', async () => {
  // CI=true makes typescript-eslint assume one run over files on disk; these snippets replace one file's text repeatedly.
  const lint = new ESLint({ cwd, overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } }] });
  const file = 'test/lint-config.test.ts';
  assert.deepEqual(await rules(file, "import { test } from 'node:test'; test('owned by runner', async () => { await Promise.resolve(); });", lint), []);
  assert.deepEqual(await rules(file, "import { test as register } from 'node:test'; register('alias', () => {});", lint), []);
  assert.ok((await rules(file, 'const test = () => Promise.resolve(); test();', lint)).includes('@typescript-eslint/no-floating-promises'), 'unrelated functions called test are not exempt');
  for (const step of ['Promise.resolve();', 'void Promise.resolve();']) {
    assert.ok((await rules(file, `import { test } from 'node:test'; test('unawaited step', async () => { ${step} });`, lint)).includes('@typescript-eslint/no-floating-promises'));
  }
  assert.ok((await rules(file, "import { test } from 'node:test'; test('parent', async t => { t.test('child', async () => { await Promise.resolve(); }); });", lint)).includes('@typescript-eslint/no-floating-promises'), 'child subtests must still be awaited');
  assert.ok((await rules(file, "import { test } from 'node:test'; test('parent', async () => { test('child', async () => { await Promise.resolve(); }); });", lint)).includes('@typescript-eslint/no-floating-promises'), 'nested calls to the imported test function are not exempt');
  assert.ok((await rules(file, 'setTimeout(async () => { await Promise.resolve(); }, 1);', lint)).includes('@typescript-eslint/no-misused-promises'));
});
