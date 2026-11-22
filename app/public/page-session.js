// Shared dashboard/setup page identity and installed-app lifetime. API traffic and a five-second
// heartbeat keep the page registered; pagehide removes exactly this page, not another open window.
export const pageId = crypto.randomUUID();
// Each request is numbered, and goodbye names the last number sent: a request already on its way when the page closed
// (it can overtake the goodbye beacon) cannot register the closed page again, while a page restored from the back/forward
// cache counts again with its next request.
let sequence = 0;
export const pageHeaders = () => ({ 'X-Page': pageId, 'X-Page-Seq': String(++sequence) });
const goodbye = () => `/api/bye?page=${pageId}&seq=${sequence}`;
export async function pageRequest(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.headers, ...pageHeaders() } });
  const json = response.headers.get('content-type')?.includes('json');
  if (response.ok) return json ? response.json() : {};
  let data;
  try { data = json ? await response.json() : {}; } catch { /* A refusal keeps its status even if its body is unreadable. */ }
  throw Object.assign(new Error(data?.error ?? `HTTP ${response.status}`), { status: response.status });
}
let heartbeat, timer;
export function startPageSession(pulse = () => pageRequest('/api/status')) {
  heartbeat = pulse;
  if (!timer) timer = setInterval(() => { void Promise.resolve(heartbeat()).catch(() => {}); }, 5000);
}
// A known same-window handoff can await goodbye rather than depend on browser unload delivery.
export async function endPageSession() {
  clearInterval(timer); timer = undefined;
  await pageRequest(goodbye(), { method: 'POST', keepalive: true });
}
window.addEventListener('pagehide', () => {
  clearInterval(timer); timer = undefined;
  navigator.sendBeacon(goodbye());
});
window.addEventListener('pageshow', event => {
  if (heartbeat && event.persisted) {
    startPageSession(heartbeat);
    void Promise.resolve(heartbeat()).catch(() => {});
  }
});
