import { localFetch } from './local-transport.ts';
import { contextGuidance } from '../src/local-ai.ts';

export type LocalKind = 'ollama' | 'lmstudio';
const valid = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 2048;
const CACHE_MS = 5000;
/** Trained maxima and /v1/models hints do not describe the server's loaded context. */
export function loadedContexts(kind: LocalKind, base: URL) {
  let at = -Infinity;
  let contexts = new Map<string, number>();
  let known = false;
  let loaded = new Set<string>();
  let pending: Promise<void> | undefined;
  const json = async (path: string, signal: AbortSignal) => {
    const response = await localFetch(new URL(path, base), { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
    return response.ok ? response.json() : null;
  };
  const read = async (signal: AbortSignal, force = false) => {
    if (pending) { await pending; if (!force) return; }
    if (!force && Date.now() - at < CACHE_MS) return;
    pending = (async () => {
      const next = new Map<string, number>(), instances = new Set<string>();
      let available = false;
      try {
        if (kind === 'ollama') {
          const data = await json('/api/ps', signal) as any;
          if (Array.isArray(data?.models)) {
            available = true;
            for (const item of data.models) for (const id of [item?.name, item?.model]) if (typeof id === 'string') {
              instances.add(id); if (valid(item.context_length)) next.set(id, item.context_length);
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
      } catch { /* Missing metadata is never a guessed default. */ }
      contexts = next; loaded = instances; known = available; at = Date.now();
    })().finally(() => { pending = undefined; });
    await pending;
  };
  const warming = new Map<string, Promise<void>>();
  return {
    read,
    get: (id: string) => contexts.get(id),
    async require(id: string, signal: AbortSignal) {
      // Always re-measure before sending meeting text; a cached catalog is not authority for a changed server load.
      await read(signal, true);
      if (!contexts.has(id) && known && !loaded.has(id)) {
        if (!warming.has(id)) warming.set(id, (async () => {
          const response = await localFetch(new URL('/v1/chat/completions', base), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
          await response.body?.cancel();
        })().finally(() => { warming.delete(id); }));
        await warming.get(id);
        await read(signal, true);
      }
      const size = contexts.get(id);
      if (!size) throw new Error(contextGuidance(`${kind}/${id}`));
      return size;
    },
  };
}
