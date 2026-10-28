import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEventStream, Model, Provider } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { localFetch, loopbackBase } from './local-transport.ts';
import { loadedContexts, type LocalKind } from './local-context.ts';
import { assertLocalContext, localAnswerRoom } from '../src/local-ai.ts';
export { loopbackBase } from './local-transport.ts';

export const LOCAL_BASES = { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1' } as const;
type LocalRequest = { thinking: boolean; allowance: number };
export function localProvider(kind: LocalKind, base: string = LOCAL_BASES[kind], notesThinking = false): Provider<'openai-completions'> {
  const url = loopbackBase(base), contexts = loadedContexts(kind, url);
  let models: Model<'openai-completions'>[] = [];
  const api = openAICompletionsApi();
  const checkModel = (model: Model<'openai-completions'>) => { loopbackBase(model.baseUrl); if (new URL(model.baseUrl).origin !== url.origin) throw new Error('Local model endpoint overrides are not allowed.'); return model; };
  const inferenceFetch = (model: Model<'openai-completions'>, record: (value: LocalRequest) => void): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    loopbackBase(request.url);
    if (new URL(request.url).origin !== url.origin) throw new Error('Local model endpoint overrides are not allowed.');
    try {
      const payload = await request.json() as any;
      if (payload.model !== model.id) throw new Error('Local model overrides are not allowed.');
      const size = await contexts.require(model.id, request.signal);
      const requested = payload.max_tokens ?? payload.max_completion_tokens;
      // Pi clamps against the catalog context (pi-ai api/simple-options). Its unknown sentinel yields 1,
      // not an intentional output limit. Only a measured catalog context can supply a lower allowance.
      const text = JSON.stringify({ messages: payload.messages, tools: payload.tools });
      const room = Math.min(16384, localAnswerRoom(size, text));
      const thinking = kind === 'ollama' && notesThinking && room >= 6144;
      const output = thinking ? room : Math.min(model.contextWindow > 1 && Number.isSafeInteger(requested) && requested > 0 ? requested : 4096, 4096, Math.floor(size / 4));
      assertLocalContext(`${kind}/${model.id}`, size, output, text);
      delete payload.max_completion_tokens;
      payload.max_tokens = output;
      if (kind === 'ollama') payload.reasoning_effort = thinking ? 'medium' : 'none';
      record({ thinking, allowance: output });
      return localFetch(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(payload), signal: request.signal });
    } catch (error) {
      return new Response(JSON.stringify({ error: { message: (error as Error).message } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  };
  const measuredStream = (model: Model<'openai-completions'>, run: (fetch: typeof globalThis.fetch) => AssistantMessageEventStream) => {
    let decision: LocalRequest | undefined;
    const inner = run(inferenceFetch(model, value => { decision = value; })), stream = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of inner) {
        const message = 'partial' in event ? event.partial : event.type === 'done' ? event.message : event.error;
        if (decision) Object.assign(message, { localRequest: decision });
        stream.push(event);
      }
      stream.end();
    })();
    return stream;
  };
  return {
    id: kind, name: kind === 'ollama' ? 'Ollama' : 'LM Studio', baseUrl: url.href,
    auth: { apiKey: { name: 'On this Mac', resolve: async () => ({ auth: { apiKey: 'local' } }) } },
    getModels: () => models,
    async refreshModels(context) {
      let found: Model<'openai-completions'>[] = [];
      try {
        const endpoint = new URL(kind === 'ollama' ? '/api/tags' : '/v1/models', url);
        const response = await localFetch(endpoint, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(1500)]) });
        if (response.ok) {
          const body = await response.json() as any;
          const entries = kind === 'ollama' ? body.models : body.data;
          if (Array.isArray(entries)) {
            await contexts.read(context.signal);
            found = entries.flatMap((entry: any) => {
              const id = kind === 'ollama' ? entry?.name : entry?.id;
              if (typeof id !== 'string' || !id || /\s/.test(id)) return [];
              // 1 is an unusable/unknown sentinel, never a guessed context. Inference measures the selected model after loading it.
              const contextWindow = contexts.get(id) ?? 1;
              return [{ id, name: id, provider: kind, api: 'openai-completions' as const, baseUrl: url.href,
                reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow,
                maxTokens: contextWindow > 1 ? Math.min(4096, Math.floor(contextWindow / 4)) : 4096 }];
            });
          }
        }
      } catch { /* A stopped local server has no live catalog. */ }
      await context.publish({ update: () => { models = found; } });
    },
    stream: (model, context, options) => measuredStream(checkModel(model), fetch => api.stream(model, context, { ...options, fetch })),
    streamSimple: (model, context, options) => measuredStream(checkModel(model), fetch => api.streamSimple(model, context, { ...options, fetch })),
  };
}

export default async function (pi: ExtensionAPI) {
  pi.on('session_before_compact', async () => ({ cancel: true }));
  await Promise.all((Object.keys(LOCAL_BASES) as LocalKind[]).map(async kind => {
    const base = process.env[kind === 'ollama' ? 'MEETING_OLLAMA_BASE' : 'MEETING_LMSTUDIO_BASE'] ?? LOCAL_BASES[kind];
    const provider = localProvider(kind, base, process.env.MEETING_LOCAL_NOTES_THINKING === '1');
    await provider.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(5000), publish: async publication => { publication.update?.(); return true; } });
    pi.registerProvider(provider);
  }));
}
