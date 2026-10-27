# Local context admission

HearAlong uses Pi's OpenAI-compatible streaming API for both local providers. The pinned Pi 1.3.0 implementation accepts a per-request `fetch`; it does not supply an Ollama-native `options.num_ctx` setting. We do not assume adding that field to an OpenAI request changes server context.

## Measure the loaded model, not its trained maximum

- **Ollama:** `/api/tags` supplies IDs. `/api/show`'s `model_info.*.context_length` is a trained maximum, not the context actually allocated. The provider instead reads `/api/ps`, matching `name` or `model` and taking `context_length`.
- **LM Studio:** OpenAI `/v1/models` supplies IDs, not usable context. REST `/api/v1/models` supplies `models[].key` (or `id`) and `loaded_instances[].config.context_length`. For the older REST shape, `/api/v0/models` supplies `data[].id`, `state: "loaded"`, and `loaded_context_length`. `max_context_length` is not used. If several instances report different contexts, use the smallest; an instance without a context makes it unknown.
- Catalog context metadata is cached in the Pi process for five seconds. Before **each inference POST**, the provider re-reads loaded metadata, replacing the cache if the server reports a different allocation.
- If metadata shows the selected model is not loaded, send one fixed request to the same `/v1/chat/completions` endpoint: `messages: [{role: "user", content: "Hi"}]`, `max_tokens: 1`, `stream: false`. It contains no meeting text. Read loaded metadata again before admitting the actual request. Concurrent requests for the same model share that warm-up within one provider process.
- If context is still unknown, refuse with instructions to set Ollama's context length (for example 32768, in settings or `OLLAMA_CONTEXT_LENGTH`) and restart, or to set LM Studio's context length when loading the model. A one-token catalog sentinel represents **unknown**, not an inferred usable default. Unloaded models are measured inside the provider; the notes preflight does not reject that sentinel before warm-up can occur.

## Admission estimate

The estimate is **3 Unicode characters per token, plus 25%, plus 512 fixed tokens**, with the requested output allowance added separately. Output is capped at the smaller of 4096 tokens and one quarter of the measured context. This is a deliberately padded estimate, not an exact tokenizer. The provider checks the complete serialized messages/tool declarations and the effective output limit immediately before sending the actual prompt; notes also preflight known catalog limits. No transcript is sliced, no server truncation is requested, and Pi automatic compaction is cancelled. Over-limit requests fail instead of sending a deliberately shortened prompt.

The allocation and tokenizer are controlled by the local server; the estimate is not a mathematical bound for every tokenizer or custom chat template. A separate real Ollama check is required before accepting practical context behavior. In particular, another client must not resize/unload the model between measurement and submission. Tests here use loopback fakes only, including a reduced loaded context and a too-long prompt that never reaches the fake inference endpoint.

## Transport and evidence

Discovery, warm-up, metadata and both Pi streaming methods use one loopback-only fetch with its own direct Undici dispatcher, independent of global/environment proxy configuration. All redirect responses are refused before another origin is contacted. Local Pi children additionally lose every case variant of HTTP/HTTPS/ALL/NO_PROXY. Endpoints and every individual request URL are checked.

Evidence sources available offline were Pi's `docs/custom-provider.md`, `docs/models.md`, and `pi-ai/dist/api/openai-completions.js` / `types.d.ts`. Separate Ollama/LM Studio API manuals were not installed in this checkout. The response shapes above follow the published [Ollama running-model API](https://docs.ollama.com/api/ps) and [LM Studio REST model APIs](https://lmstudio.ai/docs/developer/rest) as understood from their documented contracts; those links were **not fetched**. This integration and its context policy were verified with fakes only and need one real check with Ollama.
