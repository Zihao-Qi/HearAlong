import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const path of ['../../README.md', '../README.md', '../../docs/architecture.md']) test(`read boundary disclosure is explicit in ${path}`, async () => {
  const text = await readFile(new URL(path, import.meta.url), 'utf8');
  assert.ok(text.includes('Generated code can in rare cases leave a background process running after a task; it cannot read file contents or extended attributes outside its allowed folders, use the network, or create links, but it can still see file names and sizes outside the data folder.'));
  assert.ok(text.includes('A public-looking hostname can still resolve to a private address (DNS rebinding); the hook does not resolve DNS.'));
  assert.ok(text.includes('The sandbox still allows other macOS system services by default apart from the named restrictions on clipboard, Spotlight, preferences, AppleEvents and Security.'));
  for (const location of ['/opt/homebrew/Cellar', '/private/etc', '/dev']) assert.ok(text.includes(`\`${location}\``));
});
