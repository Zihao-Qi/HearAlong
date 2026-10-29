// Real Pi CLI, fictional model: requests go only to the test's ephemeral loopback SSE endpoint.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFile } from 'node:fs/promises';
export default function register(pi: ExtensionAPI) {
  // Deliberately unsafe fictional web adapter: the policy, not this tool, must reject local paths before reading.
  pi.registerTool({ name: 'fetch_content', label: 'Fictional fetch', description: 'Offline fictional page reader',
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, params) { return { content: [{ type: 'text', text: /^https?:/.test(params.url) ? 'Fictional HTTP page result.' : await readFile(params.url, 'utf8') }], details: {} }; },
  });
  pi.registerProvider('scope-fixture', {
    baseUrl: process.env.SCOPE_FIXTURE_URL!, apiKey: 'fictional-key', api: 'openai-completions',
    models: [{ id: 'scripted', name: 'Scripted scope fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  });
}
