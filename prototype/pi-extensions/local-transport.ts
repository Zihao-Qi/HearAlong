import { Agent, fetch as directFetch } from 'undici';

const dispatcher = new Agent({ connect: { timeout: 1500 }, headersTimeout: 30_000, bodyTimeout: 30_000 });
export function loopbackBase(base: string): URL {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Local models require an HTTP loopback endpoint.');
  return url;
}
export const localFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  loopbackBase(request.url); // Validate every request, not just the provider's initial base URL.
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const response = await directFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body,
    signal: request.signal, redirect: 'manual', dispatcher });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    // Preserve a useful error through the OpenAI SDK, which otherwise wraps thrown fetch errors as "Connection error".
    return new Response(JSON.stringify({ error: { message: 'Local model request refused: redirects are not allowed.' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(response.body as unknown as BodyInit, { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers) });
};
