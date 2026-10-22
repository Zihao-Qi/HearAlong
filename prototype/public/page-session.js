// Shared dashboard/setup page identity and installed-app lifetime. API traffic and a five-second
// heartbeat keep the page registered; pagehide removes exactly this page, not another open window.
export const pageId = crypto.randomUUID();
export async function pageRequest(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.headers, 'X-Page': pageId } });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : {};
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
let heartbeat, timer;
export function startPageSession(pulse = () => pageRequest('/api/status')) {
  heartbeat = pulse;
  if (!timer) timer = setInterval(() => { void Promise.resolve(heartbeat()).catch(() => {}); }, 5000);
}
// A known same-window handoff can await goodbye rather than depend on browser unload delivery.
export async function endPageSession() {
  clearInterval(timer); timer = undefined;
  await pageRequest(`/api/bye?page=${pageId}`, { method: 'POST', keepalive: true });
}
window.addEventListener('pagehide', () => {
  clearInterval(timer); timer = undefined;
  navigator.sendBeacon(`/api/bye?page=${pageId}`);
});
window.addEventListener('pageshow', event => {
  if (heartbeat && event.persisted) {
    startPageSession(heartbeat);
    void Promise.resolve(heartbeat()).catch(() => {});
  }
});
