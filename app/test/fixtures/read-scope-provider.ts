// Real Pi CLI, fictional model: requests go only to the test's ephemeral loopback SSE endpoint.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function register(pi: ExtensionAPI) {
  pi.registerProvider('scope-fixture', {
    baseUrl: process.env.SCOPE_FIXTURE_URL!, apiKey: 'fictional-key', api: 'openai-completions',
    models: [{ id: 'scripted', name: 'Scripted scope fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  });
}
