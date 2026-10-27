#!/usr/bin/env node
// Fake /usr/bin/security: never touches a Keychain. Records each call's argv and stdin, keeps items in a JSON file.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_SECURITY_DIR;
const storePath = join(dir, 'store.json');
const store = (() => { try { return JSON.parse(readFileSync(storePath, 'utf8')); } catch { return {}; } })();
const args = process.argv.slice(2);
const stdin = args[0] === '-i' ? readFileSync(0, 'utf8') : '';
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args, stdin })}\n`);
const option = (list, name) => list[list.indexOf(name) + 1];
const item = list => `${option(list, '-s')}/${option(list, '-a')}`;
if (process.env.FAKE_SECURITY_FAIL) process.exit(1);
if (args[0] === '-i') {
  for (const line of stdin.split('\n').filter(Boolean)) {
    const words = line.split(' ');
    if (words[0] === 'add-generic-password' && words.includes('-X')) store[item(words)] = Buffer.from(option(words, '-X'), 'hex').toString('utf8');
  }
  writeFileSync(storePath, JSON.stringify(store));
} else if (args[0] === 'find-generic-password') {
  if (!(item(args) in store)) process.exit(44);
  process.stdout.write(`${store[item(args)]}\n`);
} else if (args[0] === 'delete-generic-password') {
  if (!(item(args) in store)) process.exit(44);
  delete store[item(args)]; writeFileSync(storePath, JSON.stringify(store));
} else process.exit(2);
