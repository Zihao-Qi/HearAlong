import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateAi, consentCovers, providerSet } from '../src/setup/ai-settings.ts';

const models = ['openai/example', 'google/example', 'ollama/example'];
for (const seen of [false, true]) for (const cloud of [false, true]) for (const local of [false, true]) test(`AI migration seen=${seen}, cloud=${cloud}, local=${local}`, () => {
  const result = migrateAi({ setupSeen: seen }, [...(cloud ? models.slice(0, 2) : []), ...(local ? models.slice(2) : [])], false, 123);
  assert.equal(result.aiMode, seen && cloud ? 'cloud' : local ? 'local' : 'off');
  assert.equal(result.cloudNotice, seen && cloud);
  if (seen && cloud) assert.deepEqual(result.cloudConsent, { providers: ['google', 'openai'], time: 123, legacy: true });
  else assert.equal(result.cloudConsent, undefined);
});

test('forced Off never grants consent or overwrites a saved mode', () => {
  assert.equal(migrateAi({ setupSeen: true }, models, true, 123).aiMode, 'off');
  const saved = { aiMode: 'cloud' as const, cloudConsent: { providers: ['openai'], time: 1 }, cloudNotice: false };
  assert.equal(migrateAi(saved, models, true, 123), saved);
});

test('consent is scoped to the exact provider set; a new provider needs consent', () => {
  const consent = { providers: ['openai'], time: 123 };
  assert.deepEqual(providerSet(['openai/example', 'openai/quick']), ['openai']);
  assert.equal(consentCovers(consent, ['openai/example', 'openai/quick']), true);
  assert.equal(consentCovers(consent, ['google/example', 'openai/quick']), false);
  assert.equal(consentCovers(undefined, ['openai/example']), false);
});
