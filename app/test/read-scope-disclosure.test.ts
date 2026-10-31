import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const path of ['../README.md', '../../docs/architecture.md']) test(`read boundary disclosure is explicit in ${path}`, async () => {
  const text = await readFile(new URL(path, import.meta.url), 'utf8');
  assert.match(text, /bundled Node with bundled mathjs/);
  assert.match(text, /nothing is installed or downloaded for (?:them|calculations)/);
  assert.match(text, /cannot start (?:programs|child processes)/);
  assert.ok(text.includes('Node 22 permissions do not control networking'));
  assert.ok(text.includes('Seatbelt is the network and cross-process signal boundary'));
  assert.match(text, /256 MB/); assert.match(text, /512 MB/);
  assert.match(text, /not a hard allocation quota/);
  assert.match(text, /250 ms/);
  assert.match(text, /[Pp]aused time counts toward the (?:existing )?wall-clock limit/);
  assert.match(text, /memory could not be checked/);
  assert.match(text, /only if code was never sent or no valid sample arrived/);
  assert.match(text, /ordinary timeout/);
  assert.ok(text.includes('A public-looking hostname can still resolve to a private address (DNS rebinding); the hook does not resolve DNS.'));
  assert.ok(text.includes('The sandbox still allows other macOS system services by default apart from the named restrictions on clipboard, Spotlight, preferences, AppleEvents and Security.'));
  for (const location of ['/opt/homebrew/Cellar', '/private/etc', '/dev']) assert.ok(text.includes(`\`${location}\``));
});
