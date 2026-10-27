import { setTimeout as delay } from 'node:timers/promises';
import { localFetch } from './local-transport.ts';
import { contextGuidance } from '../src/local-ai.ts';

export type LocalKind = 'ollama' | 'lmstudio';
const valid = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 2048;
const CACHE_MS = 5000;
/** Trained maxima and /v1/models hints do not describe the server's loaded context. */
export function loadedContexts(kind: LocalKind, base: URL, limits = { loadMs: 300_000, pollMs: 1000 }) {
  let at = -Infinity;
  let contexts = new Map<string, number>();
  let known = false;
  let disconnected = false;
  let loaded = new Set<string>();
  let loading = new Set<string>();
  let pending: Promise<void> | undefined;
  const json = async (path: string, signal: AbortSignal) => {
    const response = await localFetch(new URL(path, base), { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
    return response.ok ? response.json() : null;
  };
  const read = async (signal: AbortSignal, force = false) => {
    if (pending) { await pending; if (!force) return; }
    if (!force && Date.now() - at < CACHE_MS) return;
    pending = (async () => {
      const next = new Map<string, number>(), instances = new Set<string>(), starting = new Set<string>();
      let available = false;
      disconnected = false;
      try {
        if (kind === 'ollama') {
          const data = await json('/api/ps', signal) as any;
          if (Array.isArray(data?.models)) {
            available = true;
            for (const item of data.models) for (const id of [item?.name, item?.model]) if (typeof id === 'string') {
              instances.add(id); if (valid(item.context_length)) next.set(id, item.context_length);
              if (item.context_length === 0) starting.add(id);
            }
          }
        } else {
          const data = await json('/api/v1/models', signal) as any;
          if (Array.isArray(data?.models)) {
            available = true;
            for (const item of data.models) {
              const id = item?.key ?? item?.id;
              if (typeof id !== 'string' || !Array.isArray(item.loaded_instances)) continue;
              if (item.loaded_instances.length) instances.add(id);
              const sizes = item.loaded_instances.map((instance: any) => instance?.config?.context_length);
              if (sizes.length && sizes.every(valid)) next.set(id, Math.min(...sizes));
            }
          } else {
            const old = await json('/api/v0/models', signal) as any;
            if (Array.isArray(old?.data)) {
              available = true;
              for (const item of old.data) if (typeof item?.id === 'string' && item.state === 'loaded') {
                instances.add(item.id); if (valid(item.loaded_context_length)) next.set(item.id, item.loaded_context_length);
              }
            }
          }
        }
      } catch (error) {
        // A busy metadata endpoint can time out while loading; a stopped server should not consume the load bound.
        disconnected = /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET/.test(String((error as any)?.cause?.code ?? ''));
      }
      contexts = next; loaded = instances; loading = starting; known = available; at = Date.now();
    })().finally(() => { pending = undefined; });
    await pending;
  };
  const warming = new Map<string, { promise: Promise<number>; controller: AbortController; users: number }>();
  const requireContext = async (id: string, cancelled: AbortSignal) => {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(limits.loadMs)]);
    const server = kind === 'ollama' ? 'Ollama' : 'LM Studio';
    const failed = () => new Error(`${kind}/${id} failed to load. Check ${server} on this Mac, then try again.`);
    try {
      // Always re-measure before sending meeting text; a cached catalog is not authority for a changed server load.
      await read(signal, true);
      signal.throwIfAborted();
      if (contexts.has(id)) return contexts.get(id)!;
      if (disconnected) throw failed();
      if (loaded.has(id) && !loading.has(id)) throw new Error(contextGuidance(`${kind}/${id}`));
      if (!loaded.has(id)) {
        let response: Response;
        try {
          response = await localFetch(new URL('/v1/chat/completions', base), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false,
              ...(kind === 'ollama' ? { reasoning_effort: 'none' } : {}) }), signal });
          if (!response.ok) { await response.body?.cancel(); throw failed(); }
          await response.text();
        } catch { signal.throwIfAborted(); throw failed(); }
      }
      // Another process may already be loading it. Zero is a loading state, not an unknown allocation.
      for (;;) {
        await read(signal, true);
        signal.throwIfAborted();
        const size = contexts.get(id);
        if (size) return size;
        if (disconnected) throw failed();
        if (known && loaded.has(id) && !loading.has(id)) throw new Error(contextGuidance(`${kind}/${id}`));
        await delay(limits.pollMs, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted && !cancelled.aborted) throw new Error(`${kind}/${id} did not finish loading within ${Math.round(limits.loadMs / 1000)} s. Check ${server} on this Mac, then try again.`);
      throw error;
    }
  };
  return {
    read,
    get: (id: string) => contexts.get(id),
    async require(id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      let work = warming.get(id);
      if (!work) {
        const controller = new AbortController();
        work = { controller, users: 0, promise: requireContext(id, controller.signal).finally(() => { if (warming.get(id) === work) warming.delete(id); }) };
        warming.set(id, work);
      }
      work.users++;
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      try { return await Promise.race([work.promise, cancelled]); }
      finally {
        signal.removeEventListener('abort', abort);
        if (--work.users === 0) { work.controller.abort(); if (warming.get(id) === work) warming.delete(id); }
      }
    },
  };
}
