// Installed only by mini-check. Keep references/plain values; inspect/serialize them only after a failure.
type BrowserFlight = {
  events: { ms: number; event: string; status: number }[];
  lastLive?: { ms: number; url: string; body: unknown };
  lastUpload?: { ms: number; url: string; status: number; body: unknown };
  contexts: AudioContext[];
  streams: MediaStream[];
};
declare global { interface Window { __miniCheckFlight: BrowserFlight } }

export function installMiniFlightRecorder() {
  const state: BrowserFlight = window.__miniCheckFlight = { events: [], contexts: [], streams: [] };
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    const live = location.pathname.endsWith('/mini.html') && /\/api\/live(?:\?|$)/.test(this.url);
    const upload = this.url.endsWith('/pcm');
    if (!live && !upload) return json.call(this);
    // Observe the JSON the app actually consumes: no clone, extra parse, request, or network listener.
    return json.call(this).then(body => {
      const ms = performance.now();
      if (live) state.lastLive = { ms, url: this.url, body };
      if (upload) state.lastUpload = { ms, url: this.url, status: this.status, body };
      state.events.push({ ms, event: live ? 'live.json' : 'pcm.json', status: this.status });
      return body;
    });
  };
  window.AudioContext = new Proxy(window.AudioContext, {
    construct(target, args, newTarget) {
      const context = Reflect.construct(target, args, newTarget) as AudioContext;
      state.contexts.push(context);
      return context;
    },
  });
  if (navigator.mediaDevices) {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => getUserMedia(constraints).then(stream => {
      state.streams.push(stream);
      return stream;
    });
  }
}

export function miniBrowserSnapshot() {
  const state = window.__miniCheckFlight;
  const scroll = document.getElementById('m-scroll');
  const rows = [...document.querySelectorAll('#m-scroll .ln')].map(row => ({
    key: (row as HTMLElement).dataset.key, signature: (row as HTMLElement).dataset.signature, text: row.textContent,
  }));
  const paragraphs = rows.length >= 3;
  const overflow = Boolean(scroll && scroll.scrollHeight > scroll.clientHeight + 200);
  return {
    ms: performance.now(), timeOrigin: performance.timeOrigin, url: location.origin + location.pathname,
    visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight },
    dom: { rowCount: rows.length, rows, scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
      clientHeight: scroll?.clientHeight, condition: { paragraphs, overflow, falseHalves: [
        ...(!paragraphs ? ['fewer than three paragraphs'] : []), ...(!overflow ? ['overflow not greater than 200 px'] : []),
      ] }, notices: [...document.querySelectorAll('.notice')].filter(e => (e as HTMLElement).getClientRects().length > 0).map(e => e.textContent) },
    lastReceived: state?.lastLive, lastParsedUploadAcknowledgement: state?.lastUpload, events: state?.events,
    audio: { contexts: state?.contexts.map(context => ({ state: context.state, currentTime: context.currentTime, sampleRate: context.sampleRate })),
      tracks: state?.streams.flatMap(stream => stream.getAudioTracks().map(track => ({ kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState }))) },
  };
}
