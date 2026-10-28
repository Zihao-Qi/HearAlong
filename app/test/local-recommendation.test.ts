import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RECOMMENDED_LOCAL_MODEL } from '../src/pi-command.ts';

test('real local: recommend the verified 4b model and explain the 32k Ollama setting', () => {
  assert.equal(RECOMMENDED_LOCAL_MODEL, 'qwen3.5:4b');
  const source = readFileSync(new URL('../public/setup-ui.js', import.meta.url), 'utf8');
  assert.match(source, /About 4 GB\. LM Studio works too\./);
  assert.ok(source.includes("In Ollama's settings, set the context length to 32k so a long meeting fits."));
});
