const recordingText = 'You can listen once the recording stops, so the microphone doesn’t record the playback.';
const emptyText = 'There is no audio for this meeting.';
const deletedText = after => after
  ? `This meeting’s audio was deleted ${after} after the meeting. To keep it longer: Settings › Keep audio for.`
  : 'This meeting’s audio is no longer available.';
const stamp = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** One player owned by the selected meeting, never shared with capture or the mini view. */
export function createListenPlayer(pane, { owner, recording, request, hear }) {
  let bar, audio, toggle, position, clock, speed, resize, generation = 0, controller, targetMs = 0;
  const button = (id, label, text) => {
    const b = document.createElement('button'); b.id = id; b.type = 'button'; b.setAttribute('aria-label', label); b.textContent = text; return b;
  };
  function toggleIcon(paused) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); svg.setAttribute('viewBox', '0 0 14 14'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paused ? 'M3.5 2l9 5-9 5z' : 'M3 2h3v10H3zM8 2h3v10H8z'); path.setAttribute('fill', 'currentColor');
    svg.append(path); return svg;
  }
  function stop() {
    if (!audio) return;
    const old = audio; audio = null; old.pause(); old.removeAttribute('src'); old.load(); old.remove(); hear(null);
  }
  function close() {
    generation++; controller?.abort(); stop(); resize?.disconnect(); bar?.remove(); bar = null; pane.classList.remove('listening'); pane.style.removeProperty('--listen-height'); hear(null);
  }
  function shell() {
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'listen-player'; bar.className = 'listen-player'; pane.append(bar); pane.classList.add('listening');
      resize = new ResizeObserver(() => { if (bar) pane.style.setProperty('--listen-height', `${bar.offsetHeight}px`); }); resize.observe(bar);
    }
    const closeButton = button('listen-close', 'Close the player', '×'); closeButton.onclick = close;
    bar.replaceChildren(closeButton); return closeButton;
  }
  function message(text) {
    if (!audio && bar?.querySelector('.listen-message')?.textContent === text) return;
    generation++; controller?.abort(); stop(); const end = shell();
    const line = document.createElement('span'); line.className = 'listen-message'; line.setAttribute('role', 'status'); line.textContent = text; bar.insertBefore(line, end); hear(null);
  }
  function unavailable(data) {
    message(data.code === 'audio_recording' ? recordingText : data.code === 'audio_empty' ? emptyText
      : data.code === 'audio_gone' ? deletedText(data.after) : 'Couldn’t play this meeting’s audio. Try again.');
  }
  async function metadata(id, signal) {
    const response = await fetch(`/api/meetings/${id}/audio?metadata=1`, { signal, cache: 'no-store' });
    return { ok: response.ok, data: await response.json() };
  }
  async function recheck(id, token) {
    try {
      const fresh = await request('/api/status');
      if (token !== generation || id !== owner()) return;
      if (fresh.recordingAnywhere) { message(recordingText); return; }
      const result = await metadata(id);
      if (token !== generation || id !== owner()) return;
      if (!result.ok) unavailable(result.data); else message('Couldn’t play this meeting’s audio. Try again.');
    } catch { if (token === generation) message('Couldn’t play this meeting’s audio. Try again.'); }
  }
  function sync() {
    if (!audio) return;
    const label = audio.paused ? 'Play' : 'Pause';
    if (toggle.getAttribute('aria-label') !== label || !toggle.firstChild) toggle.replaceChildren(toggleIcon(audio.paused));
    toggle.setAttribute('aria-label', label);
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number(position.max);
    position.max = String(duration); position.value = String(audio.currentTime);
    clock.textContent = `${stamp(audio.currentTime)} / ${stamp(duration)}`; hear(audio.currentTime * 1000);
  }
  const play = () => { if (audio) void audio.play().catch(() => { if (audio) sync(); }); };
  async function open(ms) {
    targetMs = ms;
    if (recording()) { message(recordingText); return; }
    if (audio) { audio.currentTime = Math.min(ms / 1000, Number(position.max)); play(); sync(); return; }
    controller?.abort();
    message('Loading audio…'); const token = ++generation, id = owner(); controller = new AbortController();
    try {
      // A fresh global check catches recording in another dashboard before any audio request.
      const fresh = await request('/api/status');
      if (token !== generation || owner() !== id) return;
      if (recording() || fresh.recordingAnywhere) { message(recordingText); return; }
      const result = await metadata(id, controller.signal);
      if (token !== generation || owner() !== id) return;
      if (!result.ok) { unavailable(result.data); return; }
      const end = shell();
      toggle = button('listen-toggle', 'Play', ''); toggle.onclick = () => {
        if (!audio.paused) audio.pause(); else { if (audio.ended || audio.currentTime >= audio.duration) audio.currentTime = 0; play(); } sync();
      };
      clock = document.createElement('span'); clock.className = 'listen-clock';
      position = document.createElement('input'); position.id = 'listen-position'; position.type = 'range'; position.min = '0'; position.max = String(result.data.seconds); position.step = '.01';
      position.setAttribute('aria-label', 'Position in the meeting'); position.oninput = () => { audio.currentTime = Number(position.value); sync(); };
      speed = button('listen-speed', 'Speed 1×. Change speed', '1×'); speed.onclick = () => {
        const rates = [1, 1.25, 1.5, 2]; audio.playbackRate = rates[(rates.indexOf(audio.playbackRate) + 1) % rates.length];
        speed.textContent = `${audio.playbackRate}×`; speed.setAttribute('aria-label', `Speed ${audio.playbackRate}×. Change speed`);
      };
      audio = document.createElement('audio'); audio.preload = 'metadata'; audio.hidden = true; audio.preservesPitch = true;
      const current = audio;
      current.onloadedmetadata = () => { if (audio !== current) return; current.currentTime = Math.min(targetMs / 1000, current.duration); play(); sync(); };
      for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'ended']) current.addEventListener(event, sync);
      current.onerror = () => { if (audio === current) void recheck(id, token); };
      bar.insertBefore(toggle, end); bar.insertBefore(clock, end); bar.insertBefore(position, end); bar.insertBefore(speed, end); bar.append(current);
      current.src = `/api/meetings/${id}/audio`; sync();
    } catch (error) { if (token === generation && error.name !== 'AbortError') message('Couldn’t play this meeting’s audio. Try again.'); }
  }
  return { open, close, get opened() { return Boolean(bar); }, recording: active => { if (active && bar) message(recordingText); },
    meeting: meeting => { if (bar && meeting?.id === owner() && meeting.audioRemovedAt != null) message(recording() ? recordingText : deletedText(meeting.audioRemovedAfter)); } };
}
