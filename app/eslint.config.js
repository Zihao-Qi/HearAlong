import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Cover bare/absolute and relative specifiers, including nested ../ paths.
const folders = names => names.flatMap(name => [name, `${name}/**`, `**/${name}`, `**/${name}/**`]);
const serverBoundaries = [
  { group: folders(['scripts', 'test']), message: 'Server code must not depend on scripts or tests.' },
  {
    group: [
      'openai', 'openai/**', '@anthropic-ai/*', '@google/*', 'ollama', 'ollama/**', '@ollama/*',
      'ai', 'ai/**', '@ai-sdk/*', 'langchain', 'langchain/**', '@langchain/*',
      '@huggingface/*', '@mistralai/*', 'cohere-ai', 'cohere-ai/**', '@cohere-ai/*',
      'replicate', 'replicate/**', 'groq-sdk', 'groq-sdk/**', '@cerebras/*', '@together-ai/*',
      '@azure/openai', '@azure/openai/**', '@azure/ai-inference', '@azure/ai-inference/**',
      '@google-cloud/vertexai', '@google-cloud/vertexai/**', '@google-cloud/aiplatform', '@google-cloud/aiplatform/**',
      '@xenova/transformers', '@xenova/transformers/**', '@aws-sdk/client-bedrock*', '@aws-sdk/client-sagemaker-runtime',
      '@earendil-works/pi-ai', '@earendil-works/pi-ai/**',
      '@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/**',
      ...folders(['local-models.ts', 'local-context.ts', 'local-transport.ts']),
    ].flatMap(pattern => pattern.startsWith('**/') ? [pattern] : [pattern, `**/${pattern}`]),
    message: 'No model client in the server: inference and local discovery belong in the Pi child.',
  },
];
const restrict = patterns => ({
  'no-restricted-imports': ['error', { patterns: patterns.map(p => ({ ...p, group: [...new Set(p.group)] })) }],
  'no-restricted-modules': ['error', { patterns: [...new Set(patterns.flatMap(p => p.group))] }],
});
const speechBoundary = {
  group: ['transcribe-cpp', 'transcribe-cpp/**'],
  message: 'Only the isolated speech workers load the native speech library.',
};
const processBoundary = {
  group: ['child_process', 'child_process/**', 'node:child_process', 'node:child_process/**', 'worker_threads', 'worker_threads/**', 'node:worker_threads', 'node:worker_threads/**'],
  message: 'Process creation belongs in the documented process adapters.',
};
const processGroupBoundary = {
  group: folders(['process-groups.ts']),
  message: 'Only pi-task, server and explorations may import the process-group launcher.',
};
const processOwners = [
  'audio.ts', 'drafts.ts', 'recognizer.ts', 'pdf-text.ts', 'pi-rpc.ts', 'pi-task.ts', 'server.ts',
  'memory-files.ts', 'setup/api-keys.ts', 'setup/service.ts', 'setup/pi-models.ts',
].map(file => `src/${file}`);

// Only module-level node:test registrations are runner-owned. A name-only safe-call exception would
// also hide unawaited t.test() subtests, which Node cancels when their parent finishes.
const floating = tseslint.plugin.rules['no-floating-promises'];
function runnerOwned(node, source) {
  const call = node.expression;
  if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return false;
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.type.includes('Function')) return false;
  for (let scope = source.getScope(node); scope; scope = scope.upper) {
    const binding = scope.set.get(call.callee.name);
    if (!binding) continue;
    return binding.defs.some(def => def.type === 'ImportBinding' && def.parent.source.value === 'node:test'
      && (def.node.type === 'ImportDefaultSpecifier' || (def.node.type === 'ImportSpecifier' && def.node.imported.name === 'test')));
  }
  return false;
}
const promisePlugin = { ...tseslint.plugin, rules: { ...tseslint.plugin.rules,
  'no-floating-promises': { ...floating, create(context) {
    const listeners = floating.create(context);
    return { ...listeners, ExpressionStatement(node) {
      if (!runnerOwned(node, context.sourceCode)) listeners.ExpressionStatement(node);
    } };
  } },
} };

export default [
  { ignores: ['public/vendor/**'] },
  {
    files: ['{src,scripts,test}/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': promisePlugin },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: true }],
    },
  },
  {
    files: ['public/**/*.js'],
    ...js.configs.recommended,
  },
  {
    files: ['public/**/*.js'],
    rules: {
      ...restrict([
        { group: folders(['src', 'scripts', 'test']), message: 'Browser code cannot import server, script or test modules.' },
        { group: ['node:*'], message: 'Node builtins do not belong in the browser.' },
      ]),
      'no-restricted-syntax': ['error', {
        selector: "ImportExpression:not([source.type='Literal'][source.value=/^\\u002f/]:not([source.regex]))",
        message: 'Browser dynamic imports must use a string literal starting with /.',
      }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      ...restrict([...serverBoundaries, processGroupBoundary, speechBoundary, processBoundary]),
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'Server code must not use dynamic imports.' }],
    },
  },
  {
    files: processOwners,
    rules: restrict([...serverBoundaries, processGroupBoundary, speechBoundary]),
  },
  {
    files: ['src/stt-worker.ts', 'src/stt-stream-worker.ts'],
    rules: restrict([...serverBoundaries, processGroupBoundary, processBoundary]),
  },
  {
    files: ['src/pi-task.ts', 'src/server.ts'],
    rules: restrict([...serverBoundaries, speechBoundary]),
  },
  {
    files: ['src/explorations.ts'],
    rules: restrict([...serverBoundaries, speechBoundary, processBoundary]),
  },
  {
    files: ['public/**/*.js'],
    ignores: ['public/sw.js', 'public/pcm-worklet.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['public/starting.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
  {
    files: ['public/pcm-worklet.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly',
        sampleRate: 'readonly', currentFrame: 'readonly', currentTime: 'readonly',
      },
    },
  },
];
