// Run the voice probe on a glossary file and print what the local recognizer hears for each term.
// Usage: node --experimental-strip-types scripts/probe-glossary.ts <glossary.json> [out.json]
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverModel } from '../src/config.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import { probeTerms } from '../src/probe.ts';
import type { Chunk } from '../src/store.ts';

const [input, output] = process.argv.slice(2);
if (!input) throw new Error('Usage: probe-glossary.ts <glossary.json> [out.json]');
const glossary = JSON.parse(await readFile(resolve(input), 'utf8'));
const model = await discoverModel();
if (!model.available || !model.path) throw new Error(model.error ?? 'No local model.');
const recognizer = new LocalRecognizer(model.path);
const started = performance.now();
let n = 0;
try {
  const results = await probeTerms(glossary.terms, {
    workDir: join(tmpdir(), `meeting-probe-${process.pid}`),
    recognize: async path => (await recognizer.transcribe({ id: `probe-${n++}`, path, decodeStart: 0, seconds: 30, sampleRate: null } as Chunk)).text,
  });
  const seconds = (performance.now() - started) / 1000;
  for (const r of results) console.log(`${r.term}: ${r.garbled === r.clips ? '(no usable clips)' : r.heard.join(' | ') || '(always right)'}${r.garbled ? `  [${r.garbled}/${r.clips} garbled]` : ''}`);
  console.log(`${results.length} terms, ${n} clips, ${seconds.toFixed(0)} s`);
  if (output) await writeFile(resolve(output), JSON.stringify({ seconds, results }, null, 2));
} finally { await recognizer.close(); }
