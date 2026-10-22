// Shared first-run and Settings UI. Setup state belongs to the server; microphone permission belongs to this browser.
import { pageRequest } from '/page-session.js';
export function setupRequest(path, method = 'GET', value) {
  return pageRequest(path, { method, cache: 'no-store', ...(value === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  }) });
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action, quiet = false, primary = false) {
  const b = node('button', text, quiet ? 'su-link' : `su-button${primary ? ' primary' : ''}`);
  b.type = 'button'; b.onclick = action; return b;
}
function link(text, href) { const a = node('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; }
const licence = () => link('Licence', 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/');
const short = id => id?.split('/').pop() ?? '';
const mb = bytes => Math.round(bytes / 1_000_000);
function samePath(a, b) {
  // macOS reports temporary files through both /var and its /private/var alias.
  const normalize = path => path.replace(/^\/private\/(var|tmp)(?=\/)/, '/$1');
  return typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b);
}
const fileName = path => path?.split('/').filter(Boolean).at(-1) ?? 'the selected model';
function shortSource(source = '') {
  if (source === 'Hugging Face cache') return 'Hugging Face';
  return source.startsWith('~') || !source.includes('/') ? source : fileName(source);
}
function displayPath(path, source = '') {
  if (!path) return '';
  const cache = path.match(/(?:^|\/)models--([^/]+)\/(?:blobs\/[^/]+|snapshots\/[^/]+\/(.+))$/);
  if (cache) {
    const name = cache[1].split('--').slice(1).join('--');
    if (name) return `~/.cache/huggingface/…/${name}${cache[2] ? `/${cache[2]}` : ''}`;
  }
  let display = source.startsWith('~') ? `${source}/${fileName(path)}` : path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  if (display.length > 60) {
    const parts = display.split('/');
    const head = display.startsWith('~') ? parts.slice(0, 3).join('/') : `/${parts.filter(Boolean).slice(0, 2).join('/')}`;
    display = `${head}/…/${fileName(display)}`;
  }
  return display;
}
const prose = text => String(text).replace(/'/g, '’');
function errorLine(error) {
  return prose(error).split(/\r?\n/)[0].split(/\s+(?:file:\/\/\/|at\s|Node\.js\b)/)[0].trim().slice(0, 120);
}
function pickerMessage(error) {
  const message = String(error.message);
  if (/\b(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)\b|missing|unreadable|permission denied/i.test(message)) return 'Couldn’t open this file.';
  if (/not a speech model|invalid.*(?:GGUF|model)|(?:GGUF|model).*invalid/i.test(message)) return 'This file isn’t a speech model.';
  const line = errorLine(message);
  return /\bE[A-Z0-9_]+\b|(?:^|\s)[’“"']?\/|file:\/\//.test(line) ? 'Couldn’t open this file.' : line;
}
function icon(kind) {
  const span = node('span', undefined, 'su-icon');
  // All SVG markup is constant, never server content.
  const shapes = {
    ok: '<circle cx="10" cy="10" r="9" fill="#23693F"/><path d="M6 10.2l2.7 2.7L14.2 7.4" fill="none" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    todo: '<circle cx="10" cy="10" r="8.25" fill="none" stroke="#6B7586" stroke-width="1.5"/>',
    busy: '<circle cx="10" cy="10" r="8.25" fill="none" stroke="#DDE2EA" stroke-width="1.8"/><path class="su-spin" d="M10 1.75a8.25 8.25 0 0 1 8.25 8.25" fill="none" stroke="#2F56C6" stroke-width="1.8" stroke-linecap="round"/>',
    warn: '<circle cx="10" cy="10" r="9" fill="#B45309"/><path d="M10 5.6v5.2" stroke="#FFF" stroke-width="1.9" stroke-linecap="round"/><circle cx="10" cy="14.1" r="1.1" fill="#FFF"/>',
  };
  span.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">${shapes[kind]}</svg>`;
  return span;
}
const copiedUntil = new Map();
export function copyCommand(command) {
  const wrap = node('div', undefined, 'su-code');
  const label = b => {
    const copied = (copiedUntil.get(command) ?? 0) > Date.now();
    b.textContent = copied ? 'Copied' : 'Copy'; b.setAttribute('aria-label', copied ? 'Copied' : `Copy ${command}`);
  };
  const update = () => { for (const b of document.querySelectorAll('[data-copy-command]')) if (b.dataset.copyCommand === command) label(b); };
  const b = button('Copy', async () => {
    try {
      await navigator.clipboard.writeText(command);
      // Keep the announcement even if a setup poll replaced this particular button during the clipboard request.
      copiedUntil.set(command, Date.now() + 1500); update(); setTimeout(update, 1550);
    } catch { b.textContent = 'Could not copy'; b.setAttribute('aria-label', 'Could not copy'); }
  }, true);
  b.dataset.copyCommand = command; label(b); wrap.append(node('code', command), b); return wrap;
}
function row(title, detail, kind, actions = [], extra = []) {
  const r = node('div', undefined, 'su-row'), info = node('div', undefined, 'su-info'), copy = node('div', undefined, 'su-copy');
  const text = node('span', undefined, 'su-detail');
  text.append(detail); copy.append(node('span', title, 'su-title'), text, ...extra);
  info.append(icon(kind), copy); r.append(info);
  if (actions.length) { const a = node('div', undefined, 'su-actions'); a.append(...actions); r.append(a); }
  return r;
}
function bar(percent, paused = false) {
  const b = node('div', undefined, `su-bar${paused ? ' paused' : ''}`), fill = node('span');
  b.setAttribute('role', 'progressbar'); b.setAttribute('aria-label', 'Speech model download');
  b.setAttribute('aria-valuemin', '0'); b.setAttribute('aria-valuemax', '100');
  b.setAttribute('aria-valuenow', String(Math.round(percent))); fill.style.width = `${percent}%`; b.append(fill); return b;
}
function modal(title, id) {
  const opener = document.activeElement, d = node('dialog', undefined, 'setup-ui');
  const openerRow = opener?.closest('[data-setup-row]')?.dataset.setupRow;
  const openerContainer = opener?.closest('#setup-rows, #setup-settings')?.id;
  const openerLabel = opener?.textContent;
  d.setAttribute('aria-labelledby', id);
  const head = node('div', undefined, 'su-head'), h = node('h2', title); h.id = id;
  const close = button('Close', () => d.close()); close.classList.add('su-close');
  head.append(h, close); const body = node('div', undefined, 'su-body'); d.append(head, body);
  const error = node('p', undefined, 'su-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const showError = e => { error.textContent = prose(e.message); error.hidden = false; };
  d.addEventListener('close', () => {
    d.remove();
    if (opener?.isConnected) opener.focus();
    else if (openerRow && openerContainer) {
      // Polling may have replaced the opener while this modal trapped focus.
      const buttons = [...document.getElementById(openerContainer).querySelectorAll(`[data-setup-row="${openerRow}"] button, [data-setup-row="${openerRow}"] a.su-button`)];
      (buttons.find(b => b.textContent === openerLabel) ?? buttons[0])?.focus();
    }
  });
  d.addEventListener('click', event => { if (event.target === d) d.close(); });
  d.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...d.querySelectorAll('button, input, a[href], [tabindex]')]
      .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  });
  document.body.append(d); d.showModal();
  return { d, body, error, showError };
}

export async function speechDialog(changed, speech, selected = () => {}) {
  const { d, body, error, showError } = modal('Speech model', 'su-speech-title');
  body.append(node('p', 'Looking on this Mac…', 'su-muted'), error);
  try {
    const data = await setupRequest('/api/setup/speech-models');
    if (!d.open) return;
    const rank = m => m.inUse ? 0 : m.streaming ? 1 : 2;
    const target = speech?.downloadTargetPath;
    const localDownload = data.models.find(m => m.files.some(file => samePath(file.path, target)));
    const models = data.models.filter(m => m !== localDownload).map((m, i) => ({ ...m, index: i }))
      .sort((a, b) => rank(a) - rank(b) || a.index - b.index);
    let expanded = false;
    const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Filter by name'; filter.setAttribute('aria-label', 'Filter speech models'); filter.hidden = true;
    const list = node('div', undefined, 'su-card su-model-list');
    const use = async (action, value, name) => {
      const buttons = [...d.querySelectorAll('button:not(.su-close)')]; buttons.forEach(b => b.disabled = true);
      try {
        const result = await setupRequest(`/api/setup/speech/${action}`, 'POST', value);
        if (!result.cancelled) {
          selected(name ?? result.rows?.find(row => row.id === 'speech')?.label ?? 'the selected model');
          d.close(); await changed({ background: true });
        }
      } catch (e) { showError(action === 'choose-file' ? new Error(pickerMessage(e)) : e); }
      finally { buttons.forEach(b => b.disabled = false); }
    };
    const renderList = () => {
      list.replaceChildren();
      const q = filter.value.trim().toLowerCase();
      const shown = expanded ? models.filter(m => m.name.toLowerCase().includes(q)) : models.slice(0, 3);
      for (const m of shown) {
        const r = node('div', undefined, 'su-row'), info = node('div', undefined, 'su-info'), copy = node('div', undefined, 'su-copy');
        const sources = [...new Set(m.sources.map(source => samePath(m.chosenFile.path, target) ? 'downloaded' : shortSource(source)))].join(', ')
          + (m.files.length > 1 ? ` · ${m.files.length} files` : '');
        copy.append(node('span', m.name, 'su-title'), node('span', sources + (m.streaming ? '' : ' · no live preview'), 'su-detail')); info.append(copy);
        const actions = node('div', undefined, 'su-actions');
        if (m.inUse) { const current = node('span', undefined, 'su-in-use'); current.append(icon('ok'), 'In use'); actions.append(current); }
        else { const b = button('Use', () => use('use', { id: m.id }, m.name)); b.setAttribute('aria-label', `Use ${m.name}`); actions.append(b); }
        r.append(info, actions); list.append(r);
      }
      if (!models.length) {
        const empty = row('None found', 'Looked in Pi Voice, the Hugging Face cache and MEETING_MODEL_PATH', 'todo');
        empty.querySelector('.su-icon').remove(); list.append(empty);
      } else if (!shown.length) list.append(node('p', `No model matches “${filter.value}”`, 'su-none'));
    };
    const toggle = button(`Show all ${models.length}`, () => {
      expanded = !expanded; filter.hidden = !expanded; filter.value = '';
      list.classList.toggle('expanded', expanded); toggle.textContent = expanded ? 'Show fewer' : `Show all ${models.length}`; renderList();
      if (expanded) filter.focus();
    }, true); toggle.classList.add('su-toggle'); toggle.hidden = models.length <= 3;
    filter.oninput = renderList;
    const file = row('A file on this Mac', 'GGUF: Parakeet, Whisper, Moonshine or Voxtral', 'todo', [button('Choose…', () => use('choose-file'))]);
    file.querySelector('.su-icon').remove(); file.classList.add('su-card', 'su-choice');
    const desc = node('span'); desc.append('731 MB · recommended · ', licence());
    const downloaded = Boolean(localDownload?.inUse);
    const download = row('Parakeet 0.6B', desc, 'todo', downloaded ? [] : [localDownload
      ? button('Use', () => use('use', { id: localDownload.id }, localDownload.name))
      : button('Download', () => use('download', { use: true }, 'Parakeet 0.6B'), false, !models.length)]);
    download.querySelector('.su-icon').remove(); download.classList.add('su-card', 'su-choice');
    if (downloaded) {
      const actions = node('div', undefined, 'su-actions'), current = node('span', undefined, 'su-in-use');
      current.append(icon('ok'), 'In use'); actions.append(current); download.append(actions);
    }
    body.replaceChildren(node('h3', 'On this Mac'), filter, list, toggle, file, node('h3', 'Download'), download, error);
    if (data.truncated) body.append(node('p', 'The scan reached its limit. Choose a file to use another model.', 'su-muted'));
    renderList();
  } catch (e) { showError(e); }
}

export async function aiDialog(ai, changed) {
  const { d, body, error, showError } = modal('AI models', 'su-ai-title'); body.classList.add('su-ai-body');
  body.append(node('span', 'Reading Pi’s models…', 'su-count'), error);
  try {
    const data = await setupRequest('/api/setup/ai/models?refresh=1');
    const snapshot = await changed();
    ai = snapshot?.rows.find(row => row.id === 'ai') ?? ai;
    if (!d.open) return;
    const known = new Set(data.models.map(m => m.id));
    const datalist = node('datalist'); datalist.id = 'su-pi-models';
    for (const m of data.models) { const option = node('option'); option.value = m.id; datalist.append(option); }
    const save = button('Save', async () => {
      save.disabled = true; error.hidden = true;
      try {
        await setupRequest('/api/setup/ai', 'PUT', { main: fields.main.input.value.trim(), quick: fields.quick.input.value.trim() });
        d.close(); await changed({ background: true });
      } catch (e) { showError(e); validate(); }
    }, false, true);
    const fields = {};
    const validate = () => {
      let valid = true;
      for (const f of Object.values(fields)) {
        const value = f.input.value.trim(), bad = data.state === 'ok' && !!value && !known.has(value);
        f.input.setAttribute('aria-invalid', String(bad)); f.hint.hidden = !bad;
        const descriptions = [bad ? f.hint.id : '', f.environment?.id].filter(Boolean);
        if (descriptions.length) f.input.setAttribute('aria-describedby', descriptions.join(' '));
        else f.input.removeAttribute('aria-describedby');
        valid &&= known.has(value);
      }
      // The API makes an environment override authoritative for the pair, not just its individual input.
      save.disabled = !valid || ['main', 'quick'].some(role => ai[role]?.source === 'env');
    };
    const field = (role, title, use) => {
      const wrap = node('div', undefined, 'su-field'), label = node('label'); label.htmlFor = `su-ai-${role}`;
      label.append(node('strong', title), node('span', ` · ${use}`, 'su-muted'));
      const input = node('input'); input.id = label.htmlFor; input.type = 'text'; input.setAttribute('list', datalist.id);
      input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'Type to search'; input.value = ai[role]?.id ?? '';
      input.readOnly = ai[role]?.source === 'env';
      const hint = node('span', 'Pi doesn’t list this model', 'su-error'); hint.id = `${input.id}-error`;
      fields[role] = { input, hint }; input.oninput = validate;
      wrap.append(label, input, hint);
      if (input.readOnly) {
        const environment = node('span', 'Set by the environment.', 'su-muted'); environment.id = `${input.id}-environment`;
        fields[role].environment = environment; wrap.append(environment);
        save.setAttribute('aria-describedby', [save.getAttribute('aria-describedby'), environment.id].filter(Boolean).join(' '));
        save.title = environment.textContent;
      }
      return wrap;
    };
    const footer = node('div', undefined, 'su-save'); footer.append(save);
    body.replaceChildren(node('span', `From Pi · ${data.count} ${data.count === 1 ? 'model' : 'models'} from ${data.providers.length} ${data.providers.length === 1 ? 'provider' : 'providers'}`, 'su-count'), datalist,
      field('main', 'Main model', 'notes, plans, Explain'), field('quick', 'Quick model', 'the live board'),
      node('span', 'Tuned on gpt-6.1-sol and gpt-6-luna.', 'su-tuned'), error, footer);
    validate();
    if (data.state !== 'ok') showError(new Error(ai.detail ?? (data.state === 'off' ? 'AI is off for this start.' : 'Couldn’t read Pi’s models.')));
  } catch (e) { showError(e); }
}

export class SetupUI {
  constructor(container, { details = false, onStatus = () => {}, onError = () => {} } = {}) {
    this.container = container; this.details = details; this.onStatus = onStatus; this.onError = onError;
    this.active = false; this.mic = 'prompt'; this.device = ''; this.level = 0; this.generation = 0;
    this.requestSequence = 0; this.failures = 0; this.micVersion = 0; this.pendingActions = new Set(); this.watchBusy = false;
    this.permissionChanged = () => {
      if (this.permission.state === 'denied') { this.mic = 'denied'; this.stopMic?.(); }
      else if (this.mic !== 'testing') this.mic = this.permission.state;
      if (this.active) this.render();
      if (this.permission.state === 'granted') void this.devices().then(() => { if (this.active) this.render(); });
    };
    this.permissions();
  }
  async permissions() {
    try { this.permission = await navigator.permissions.query({ name: 'microphone' }); this.permission.addEventListener('change', this.permissionChanged); this.permissionChanged(); }
    catch { /* Safari and older Chrome may not expose microphone permissions. */ }
    await this.devices();
  }
  async devices() {
    try { this.device = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && d.label)?.label ?? ''; } catch { /* Optional until permission. */ }
  }
  async start(snapshot = this.status) {
    this.active = true; ++this.generation; this.failures = 0;
    if (snapshot) { this.status = snapshot; this.render(); }
    else this.container.replaceChildren(node('p', 'Checking setup…', 'su-muted'));
    await this.refresh();
  }
  stop({ dispose = false } = {}) {
    this.active = false; clearTimeout(this.timer); ++this.generation; this.stopMic?.();
    if (dispose) { this.watchBusy = false; ++this.requestSequence; }
    else if (this.watchBusy && this.busy()) this.timer = setTimeout(() => this.refresh({ background: true }), 1000);
  }
  busy() { return this.status?.rows.some(r => ['scanning', 'downloading', 'checking', 'reading'].includes(r.state) || r.pending) || Boolean(this.checkingRow); }
  async refresh({ background = false } = {}) {
    clearTimeout(this.timer);
    const generation = this.generation, sequence = ++this.requestSequence;
    this.watchBusy = (background || this.watchBusy) && this.busy();
    try {
      const status = await setupRequest('/api/setup');
      if (sequence !== this.requestSequence || (!background && (!this.active || generation !== this.generation))) return;
      this.failures = 0; this.status = status; this.onError(null);
      if (this.active) this.render();
      this.onStatus(status); // Action completion must update the owner even after Settings closes.
      this.watchBusy = (background || this.watchBusy) && this.busy();
      clearTimeout(this.timer);
      if ((this.active || this.watchBusy) && this.busy()) this.timer = setTimeout(() => this.refresh({ background: this.watchBusy }), 1000);
      return status;
    } catch (e) {
      if (sequence !== this.requestSequence || (!background && (!this.active || generation !== this.generation))) return;
      ++this.failures;
      if (!this.busy() || this.failures >= 2) this.onError(e);
      clearTimeout(this.timer);
      if ((this.active || this.watchBusy) && this.busy()) this.timer = setTimeout(() => this.refresh({ background: this.watchBusy }), Math.min(1000 * 2 ** Math.min(this.failures - 1, 4), 10000));
    }
  }
  recordChoice(name) {
    const current = this.status.rows.find(row => row.id === 'speech');
    this.choice = { name, current: current.pending ? this.choice?.current : current.label };
  }
  action(action, value, checkingRow) {
    return async () => {
      const owner = checkingRow ?? 'speech';
      if (this.pendingActions.has(owner)) return;
      this.pendingActions.add(owner);
      if (checkingRow) this.checkingRow = checkingRow;
      this.render();
      try {
        const request = setupRequest(`/api/setup/${action}`, 'POST', value);
        if (action === 'recheck') await Promise.all([request, this.refresh()]);
        else await request;
        if (action === 'speech/download') this.recordChoice('Parakeet 0.6B');
        await this.refresh({ background: true });
      } catch (e) { this.onError(e); }
      finally {
        this.pendingActions.delete(owner);
        if (checkingRow) this.checkingRow = null;
        if (!this.busy()) { this.watchBusy = false; clearTimeout(this.timer); }
        if (this.active) this.render();
      }
    };
  }
  changeSpeech = () => speechDialog(options => this.refresh(options), this.status.rows.find(row => row.id === 'speech'), name => this.recordChoice(name));
  changeAi = () => aiDialog(this.status.rows.find(r => r.id === 'ai'), options => this.refresh(options));
  speech(r) {
    let kind = 'todo', detail = '', actions = [], extra = [];
    const download = text => button(text, this.action('speech/download', { use: true }), false, true);
    const change = text => button(text, this.changeSpeech, true);
    const d = r.download, total = d.total ?? 731_357_568;
    const source = samePath(r.path, r.downloadTargetPath) ? 'downloaded' : shortSource(r.source);
    switch (r.state) {
      case 'scanning': kind = 'busy'; detail = 'Looking on this Mac…'; break;
      case 'ready':
        kind = 'ok'; detail = `${r.label} · ${this.details ? `${displayPath(r.path, r.source)} (${source})` : source}${r.streaming === false ? ' · no live preview' : ''}`; actions = [change('Change')]; break;
      case 'downloading': {
        kind = 'busy'; detail = `${mb(d.bytes)} of ${mb(total)} MB`;
        if (d.etaSeconds !== null) detail += ` · about ${d.etaSeconds >= 60 ? `${Math.round(d.etaSeconds / 60)} min` : `${Math.max(1, d.etaSeconds)} s`} left`;
        extra = [bar(d.bytes / total * 100)]; actions = [button('Pause', this.action('speech/pause'))]; break;
      }
      case 'paused': case 'interrupted':
        kind = r.state === 'interrupted' ? 'warn' : 'todo'; detail = `${r.state === 'paused' ? 'Paused at' : 'Connection lost at'} ${mb(d.bytes)} of ${mb(total)} MB`;
        if (this.details && d.reason) detail += ` · ${d.reason}`;
        extra = [bar(d.bytes / total * 100, true)]; actions = [download('Resume')]; break;
      case 'checking': kind = 'busy'; detail = 'Checking the file…'; extra = [bar(100)]; break;
      case 'damaged': kind = 'warn'; detail = 'The file is damaged.'; actions = [change('Other options'), download('Download again')]; break;
      case 'noSpace': kind = 'warn'; detail = `Not enough space. ${mb(d.neededBytes)} MB needed.`; actions = [change('Other options'), download('Try again')]; break;
      case 'missing': kind = 'warn'; detail = `${r.source === 'MEETING_MODEL_PATH' ? 'The speech model set by MEETING_MODEL_PATH' : 'The saved speech model'} is missing: ${this.details ? displayPath(r.missingPath, r.source) : fileName(r.missingPath)}`; actions = [change('Change'), download('Download')]; break;
      default: {
        const desc = node('span'); desc.append('None found. Parakeet: 731 MB · ', licence()); detail = desc; actions = [change('Other options'), download('Download')];
      }
    }
    if (r.pending) {
      kind = 'busy'; detail = r.pending.applies === 'after recording' ? `Change applies after recording · ${this.choice?.name ?? fileName(r.pending.path)}` : 'Loading the speech model…'; actions = [change('Change')];
    }
    if (r.switchError) {
      kind = 'warn';
      const name = this.choice?.name ?? 'the selected model';
      const current = r.label !== name ? r.label : this.choice?.current;
      detail = current ? `Couldn’t switch to ${name}. Still using ${current}.` : `Couldn’t load ${name}.`;
      if (this.details) extra.push(node('span', errorLine(r.switchError), 'su-detail su-switch-error'));
    }
    return row('Speech model', detail, kind, actions, extra);
  }
  ffmpeg(r) {
    if (r.state === 'found') return row('FFmpeg', `Found${this.details && r.path ? ` · ${r.path}` : ''}`, 'ok');
    const detail = node('span'); detail.append('Install it in Terminal, or from ', link('ffmpeg.org', 'https://ffmpeg.org/download.html'));
    return row('FFmpeg', detail, 'todo', [button(this.checkingRow === 'ffmpeg' ? 'Checking…' : 'Check again', this.action('recheck', undefined, 'ffmpeg'))], [copyCommand('brew install ffmpeg')]);
  }
  ai(r) {
    const recheck = () => [button(this.checkingRow === 'ai' ? 'Checking…' : 'Check again', this.action('recheck', undefined, 'ai'))], change = () => [button('Change', this.changeAi, true)];
    const pair = [r.main?.id, r.quick?.id].filter(Boolean).map(id => this.details ? id : short(id)).join(', ');
    switch (r.state) {
      case 'ready': return row('AI models', pair, 'ok', change());
      case 'reading': return row('AI models', 'Reading Pi’s models…', 'busy');
      case 'checking': return row('AI models', 'Checking access…', 'busy');
      case 'choose': return row('AI models', 'Pi is signed in. Choose two models.', 'todo', [button('Choose models', this.changeAi)]);
      case 'missing': return row('AI models', r.detail ? prose(r.detail) : 'A chosen model is no longer available.', 'warn', change());
      case 'no-access': return row('AI models', `No access · ${prose(r.detail ?? pair)}`, 'warn', change());
      case 'off': return row('AI models', 'Off for this start (MEETING_CLOUD=0).', 'todo');
      case 'not-installed': return row('AI models', 'Pi is not installed. Run npm ci.', 'todo', recheck());
      case 'unreadable': return row('AI models', 'Couldn’t read Pi’s models.', 'warn', recheck());
      default: return row('AI models', 'Sign in with Pi in Terminal, then type /login', 'todo', recheck(), [copyCommand(r.signInCommand)]);
    }
  }
  async allowMic() {
    if (this.pendingActions.has('microphone') || this.stopMic) return;
    const version = ++this.micVersion;
    let stream, context, timer, frame;
    const finish = () => {
      if (version !== this.micVersion) return;
      ++this.micVersion;
      clearTimeout(timer); cancelAnimationFrame(frame); stream?.getTracks().forEach(t => t.stop()); void context?.close();
      this.stopMic = undefined; this.pendingActions.delete('microphone');
      if (this.mic === 'testing') this.mic = this.permission?.state === 'denied' ? 'denied' : 'granted';
      if (this.active) this.render();
    };
    this.stopMic = finish; this.pendingActions.add('microphone'); this.render();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== this.micVersion || !this.active) { stream.getTracks().forEach(t => t.stop()); return; }
      this.pendingActions.delete('microphone');
      this.device = stream.getAudioTracks()[0]?.label ?? ''; this.mic = 'testing'; this.render();
      context = new AudioContext(); const analyser = context.createAnalyser(); analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser); const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        this.level = Math.min(100, Math.round(Math.sqrt(samples.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) / samples.length) * 300));
        const meter = this.container.querySelector('.su-meter');
        if (meter) { meter.setAttribute('aria-valuenow', String(this.level)); meter.firstChild.style.width = `${this.level}%`; }
        frame = requestAnimationFrame(tick);
      };
      tick(); timer = setTimeout(finish, 4000);
    } catch (e) {
      if (version !== this.micVersion) return;
      this.mic = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'denied' : 'prompt';
      finish(); if (this.mic !== 'denied') this.onError(e);
    }
  }
  microphone() {
    if (this.mic === 'testing') {
      const meter = node('div', undefined, 'su-meter'); meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', 'Microphone level');
      meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', String(this.level)); meter.append(node('span'));
      return row('Microphone', 'Say something', 'busy', [], [meter]);
    }
    if (this.mic === 'granted') return row('Microphone', `Allowed${this.details && this.device ? ` · ${this.device}` : ''}`, 'ok');
    if (this.mic === 'denied') return row('Microphone', 'Blocked. In Chrome, click the site controls beside the address, then allow Microphone.', 'warn');
    return row('Microphone', 'So Chrome won’t ask in your first meeting', 'todo', [button('Allow', () => this.allowMic())]);
  }
  render() {
    if (!this.status) return;
    const focused = this.container.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = focused?.closest('[data-setup-row]')?.dataset.setupRow, focusText = focused?.textContent;
    const rows = this.status.rows;
    const speech = this.speech(rows.find(r => r.id === 'speech')), ff = this.ffmpeg(rows.find(r => r.id === 'ffmpeg')),
      ai = this.ai(rows.find(r => r.id === 'ai')), mic = this.microphone();
    [speech, ff, ai, mic].forEach((r, i) => {
      const id = ['speech', 'ffmpeg', 'ai', 'microphone'][i]; r.dataset.setupRow = id;
      if (this.pendingActions.has(id)) for (const action of r.querySelectorAll('button')) action.disabled = true;
    });
    const optional = [ai, mic];
    const chrome = /Chrome\//.test(navigator.userAgent) && !/(Edg|OPR)\//.test(navigator.userAgent);
    if (!chrome) {
      const open = link('Open in Chrome', `google-chrome://${location.host}/setup`);
      open.className = 'su-button'; open.removeAttribute('target');
      const chromeRow = row('Chrome', 'Recording needs Google Chrome', 'todo', [open]); chromeRow.dataset.setupRow = 'chrome'; optional.push(chromeRow);
    }
    if (this.details) { const card = node('div', undefined, 'su-card'); card.append(speech, ff, ...optional); this.container.replaceChildren(card); }
    else {
      const group = (label, children) => { const g = node('section', undefined, 'su-group'), card = node('div', undefined, 'su-card'); card.append(...children); g.append(node('h2', label), card); return g; };
      this.container.replaceChildren(group('Needed', [speech, ff]), group('Optional', optional));
    }
    if (focusRow) {
      const buttons = [...this.container.querySelectorAll(`[data-setup-row="${focusRow}"] button:not(:disabled), [data-setup-row="${focusRow}"] a.su-button`)];
      (buttons.find(b => b.textContent === focusText) ?? buttons[0])?.focus();
    }
  }
}
