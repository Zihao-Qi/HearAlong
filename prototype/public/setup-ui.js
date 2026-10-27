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
  // `holding`: work in the dialog must finish before it closes (every close goes through d.close, Escape through cancel).
  const nativeClose = d.close.bind(d);
  d.close = value => { if (!d.holding) nativeClose(value); };
  d.addEventListener('cancel', event => { if (d.holding) event.preventDefault(); });
  head.append(h, close); const body = node('div', undefined, 'su-body'); d.append(head, body);
  const error = node('p', undefined, 'su-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const showError = e => { error.textContent = prose(e.message); error.hidden = false; };
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  d.addEventListener('close', () => {
    d.remove();
    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    else if (openerRow && openerContainer) {
      // Polling may have replaced the opener while this modal trapped focus.
      const buttons = [...document.getElementById(openerContainer).querySelectorAll(`[data-setup-row="${openerRow}"] button, [data-setup-row="${openerRow}"] a.su-button`)];
      (buttons.find(b => b.textContent === openerLabel) ?? buttons[0])?.focus();
    } else document.getElementById('open-system')?.focus();
    resolveClosed(d.returnValue);
  });
  d.addEventListener('click', event => { if (event.target === d) d.close(); });
  d.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...d.querySelectorAll('button, input, select, a[href], [tabindex]')]
      .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  });
  document.body.append(d); d.showModal();
  return { d, body, error, showError, closed };
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

const KEY_PROVIDERS = {
  google: { name: 'Gemini', company: 'Google', url: 'https://aistudio.google.com/apikey', placeholder: 'AIza…', extra: ' On Google’s free tier, Google may use what you send to improve its products.' },
  openai: { name: 'OpenAI', company: 'OpenAI', url: 'https://platform.openai.com/api-keys', placeholder: 'sk-…', extra: '' },
  anthropic: { name: 'Anthropic', company: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…', extra: '' },
};
const countText = data => `From Pi · ${data.count} ${data.count === 1 ? 'model' : 'models'} from ${data.providers.length} ${data.providers.length === 1 ? 'provider' : 'providers'}`;
/**
 * Own API keys, under the model count: one button per provider Pi has no credential for, the inline form, and one line per
 * saved key (or per provider Pi already signs in to). `applied` takes the server's new model list and any reset roles.
 */
function keySection(d, initial, applied) {
  const section = node('div', undefined, 'su-keys'), list = node('div', undefined, 'su-keys-list');
  // One steady live region, empty until a notice: its text is set and cleared, so it is announced once and nothing re-renders.
  const status = node('span', '', 'su-key-note su-key-other su-key-status'); status.setAttribute('role', 'status');
  section.append(list, status);
  let keys = initial, editing = null, checking = false, problem = '', noticeTimer;
  d.addEventListener('close', () => clearTimeout(noticeTimer));
  // While a key is being checked the dialog stays open (Close, Escape and the backdrop wait), so no key is saved unseen.
  const hold = value => { checking = value; d.holding = value; const close = d.querySelector('.su-close'); if (close) close.disabled = value; };
  const small = (text, action) => { const b = node('button', text, 'su-small'); b.type = 'button'; b.onclick = action; return b; };
  const focusLater = selector => queueMicrotask(() => list.querySelector(selector)?.focus());
  const request = async (provider, method, value) => {
    const result = await setupRequest(`/api/setup/ai/keys/${provider}`, method, value);
    keys = result.keys; await applied(result, provider);
  };
  const save = async (provider, input) => {
    if (checking || !input.value.trim()) return;
    hold(true); problem = ''; render(); focusLater('#su-key-input');
    try { await request(provider, 'PUT', { key: input.value }); editing = null; hold(false); render(); applied.focusModels(); }
    catch (e) { hold(false); problem = prose(e.message); render(); focusLater('#su-key-input'); }
  };
  const remove = async provider => {
    try {
      await request(provider, 'DELETE');
      render(); focusLater(`[data-key-add="${provider}"]`);
      if (!list.querySelector(`[data-key-add="${provider}"]`)) applied.focusModels();
    } catch (e) { applied.showError(e); }
  };
  const form = (provider, typed) => {
    const p = KEY_PROVIDERS[provider], box = node('div', undefined, 'su-key-form'), label = node('label');
    label.htmlFor = 'su-key-input'; label.append(node('strong', `${p.name} API key`));
    const from = node('span', ' · from ', 'su-muted'); from.append(link(p.url.replace(/^https:\/\//, ''), p.url)); label.append(from);
    const input = node('input'); input.id = 'su-key-input'; input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = p.placeholder; input.readOnly = checking; input.value = typed; // read-only, not disabled, keeps focus while checking
    const submit = node('button', checking ? 'Checking…' : 'Save key', 'su-button primary'); submit.type = 'button';
    const enable = () => { submit.disabled = checking || !input.value.trim(); };
    const alert = node('span', problem, 'su-error'); alert.setAttribute('role', 'alert'); alert.id = 'su-key-error'; alert.hidden = !problem;
    submit.onclick = () => save(provider, input);
    input.oninput = () => { if (problem) { problem = ''; alert.hidden = true; input.setAttribute('aria-invalid', 'false'); } enable(); };
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void save(provider, input); } };
    input.setAttribute('aria-invalid', String(Boolean(problem))); if (problem) input.setAttribute('aria-describedby', alert.id);
    const cancel = button('Cancel', () => { editing = null; problem = ''; render(); focusLater(`[data-key-add="${provider}"]`); }, true);
    cancel.disabled = checking;
    const fields = node('div', undefined, 'su-key-fields'); fields.append(input, submit); enable();
    box.append(label, fields, alert, node('span', `${p.company} bills you per use. The key stays in this Mac’s Keychain.${p.extra}`, 'su-key-note'), cancel);
    // Escape leaves the form, not the dialog; while checking it does nothing.
    box.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (!checking) cancel.click();
    });
    return box;
  };
  const render = () => {
    const parts = [], typed = list.querySelector('#su-key-input')?.value ?? '';
    for (const k of keys) {
      const p = KEY_PROVIDERS[k.provider];
      if (k.state === 'saved' || k.state === 'shadowed' || k.state === 'unconfirmed') {
        const line = node('div', undefined, 'su-key-line'), text = k.state === 'saved'
          ? `${p.name} · ${k.models} ${k.models === 1 ? 'model' : 'models'} · key ending ${k.last4}`
          : k.state === 'unconfirmed' ? `${p.name} · this key may have changed; remove it and add it again`
          : `${p.name} · ${k.by === 'env' ? 'the environment’s key is used' : 'Pi’s own sign-in is used'}, not this key`;
        const mark = icon(k.state === 'saved' ? 'ok' : k.state === 'unconfirmed' ? 'warn' : 'todo'); mark.classList.add('su-key-icon');
        const b = button('Remove', () => remove(k.provider), true); b.setAttribute('aria-label', `Remove the ${p.name} key`);
        line.append(mark, node('span', text, 'su-key-text'), b); parts.push(line);
      } else if (k.state === 'pi' || k.state === 'env') parts.push(node('span', `${p.name} · ${k.state === 'pi' ? 'signed in through Pi' : 'key set in HearAlong’s environment'}`, 'su-key-note su-key-other'));
    }
    const open = keys.filter(k => k.state === 'none');
    if (open.length && !editing) {
      const line = node('div', undefined, 'su-key-line'), buttons = node('div', undefined, 'su-key-buttons');
      for (const k of open) {
        const b = small(KEY_PROVIDERS[k.provider].name, () => { editing = k.provider; problem = ''; render(); focusLater('#su-key-input'); });
        const name = KEY_PROVIDERS[k.provider].name;
        b.dataset.keyAdd = k.provider; b.setAttribute('aria-label', `Add ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} API key`); buttons.append(b);
      }
      // With no models at all, a key is the other way in, not "more".
      line.append(node('span', applied.signedOut() ? 'Or use your own API key:' : 'More models with your own API key:', 'su-key-text'), buttons); parts.push(line);
    }
    if (editing) parts.push(form(editing, typed));
    list.replaceChildren(...parts);
    list.hidden = !parts.length;
  };
  section.notify = text => {
    clearTimeout(noticeTimer); status.textContent = text;
    noticeTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  };
  section.render = render;
  render();
  return section;
}

async function cloudAiControls(ai, changed, { d, body, error, showError }) {
  body.classList.add('su-ai-body');
  body.append(node('span', 'Reading Pi’s models…', 'su-count'), error);
  try {
    // Keys are optional: with AI off (or an older server) the dialog shows only the models.
    const [first, keyData] = await Promise.all([setupRequest('/api/setup/ai/models?refresh=1&mode=cloud'), setupRequest('/api/setup/ai/keys?fresh=1').catch(() => null)]);
    let data = first;
    const snapshot = await changed();
    ai = snapshot?.rows.find(row => row.id === 'ai') ?? ai;
    if (!d.open) return;
    let known = new Set(data.models.map(m => m.id));
    const datalist = node('datalist'); datalist.id = 'su-pi-models';
    const fillList = () => datalist.replaceChildren(...data.models.map(m => { const option = node('option'); option.value = m.id; return option; }));
    fillList();
    const consentBox = node('div', undefined, 'su-consent'), consentTitle = node('strong'), consentLabel = node('label'), consentText = node('span');
    const consent = node('input'); consent.type = 'checkbox'; consent.id = 'su-cloud-consent';
    consentLabel.append(consent, consentText);
    consentBox.append(consentTitle, node('p', 'Transcript text, for corrections, the live Board and notes. Lines you select and excerpts of your materials, for Explain and plans. Project memory. Search terms, for web lookups. Audio never leaves this Mac.'), consentLabel);
    let consentKey;
    const save = button('Save', async () => {
      save.disabled = true; error.hidden = true;
      try {
        await setupRequest('/api/setup/ai', 'PUT', { mode: 'cloud', main: fields.main.input.value.trim(), quick: fields.quick.input.value.trim(), consent: consent.checked });
        await changed({ background: true }); d.close('saved');
      } catch (e) { showError(e); validate(); }
    }, false, true);
    const fields = {};
    const validate = () => {
      let valid = true;
      for (const f of Object.values(fields)) {
        const value = f.input.value.trim(), bad = data.state === 'ok' && !known.has(value);
        f.hint.textContent = value ? 'Pi doesn’t list this model' : 'Choose a model listed by Pi.';
        f.input.setAttribute('aria-invalid', String(bad)); f.hint.hidden = !bad;
        const descriptions = [bad ? f.hint.id : '', f.environment?.id].filter(Boolean);
        if (descriptions.length) f.input.setAttribute('aria-describedby', descriptions.join(' '));
        else f.input.removeAttribute('aria-describedby');
        valid &&= known.has(value);
      }
      const providers = [...new Set(Object.values(fields).map(f => f.input.value.trim().split('/')[0]).filter(Boolean))].sort();
      const key = providers.join(', '), stored = ai.cloudConsent;
      if (consentKey !== key) {
        consent.checked = !!stored && (stored.legacy ? providers.every(p => stored.providers.includes(p)) : JSON.stringify([...stored.providers].sort()) === JSON.stringify(providers));
        consentKey = key;
      }
      consentTitle.textContent = `What goes to ${key || 'the provider'}`; consentText.textContent = `Send this to ${key || 'the provider'}`;
      // The API makes an environment override authoritative for the pair, not just its individual input.
      save.disabled = !valid || !consent.checked || ['main', 'quick'].some(role => ai[role]?.source === 'env');
    };
    consent.onchange = validate;
    const field = (role, title, use) => {
      const wrap = node('div', undefined, 'su-field'), label = node('label'); label.htmlFor = `su-ai-${role}`;
      label.append(node('strong', title), node('span', ` · ${use}`, 'su-muted'));
      const input = node('input'); input.id = label.htmlFor; input.type = 'text'; input.setAttribute('list', datalist.id);
      input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'Type to search'; input.value = ai[role]?.source === 'env' ? ai[role].id : data.settings?.[role === 'main' ? 'cloudMainModel' : 'cloudQuickModel'] ?? (ai.mode === 'local' || ai.mode === 'off' ? data.defaults?.[role] ?? '' : ai[role]?.id ?? data.defaults?.[role] ?? '');
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
    const count = node('span', countText(data), 'su-count');
    // A saved or removed key changes Pi's list at once; a removed provider's chosen models went back to the defaults.
    const applied = async (result, provider) => {
      data = result.models; known = new Set(data.models.map(m => m.id)); fillList(); count.textContent = countText(data);
      if (data.state === 'ok') error.hidden = true;
      const status = await changed();
      ai = status?.rows.find(row => row.id === 'ai') ?? ai;
      const reset = new Set(result.reset ?? []);
      if (result.reset) for (const role of ['main', 'quick']) {
        if (fields[role].input.readOnly || !fields[role].input.value.trim().startsWith(`${provider}/`)) continue;
        const candidate = ai.mode === 'local' || ai.mode === 'off' ? data.defaults?.[role] : ai[role]?.id;
        fields[role].input.value = candidate && known.has(candidate) ? candidate : data.defaults?.[role] ?? ''; reset.add(role);
      }
      validate();
      if (reset.size) keys.notify(`${reset.size === 2 ? 'Main and Quick models are' : reset.has('main') ? 'Main model is' : 'Quick model is'} back to the default${reset.size === 2 ? 's' : ''}.`);
    };
    applied.focusModels = () => fields.main.input.focus();
    applied.signedOut = () => data.count === 0;
    applied.showError = showError;
    const keys = keyData ? keySection(d, keyData.keys, applied) : node('div');
    body.replaceChildren(count, datalist, keys,
      field('main', 'Main model', 'notes, plans, Explain'), field('quick', 'Quick model', 'the Board, corrections'),
      node('span', 'Tuned on gpt-6.1-sol and gpt-6-luna.', 'su-tuned'), consentBox, error, footer);
    validate();
    const detail = ai.detail ?? (data.state === 'off' ? 'AI is off for this start.' : 'Couldn’t read Pi’s models.');
    if (!data.count && ['ok', 'signed-out'].includes(data.state)) showError(new Error('Pi isn’t signed in. Run pi, then /login — or add a key above.'));
    else if (data.state !== 'ok') showError(new Error(data.state === 'signed-out' && keyData ? detail.replace(/\.$/, ' — or add a key above.') : detail));
  } catch (e) { showError(e); }
}

export async function aiDialog(ai, changed) {
  const context = modal('AI', 'su-ai-title'), { d, body } = context;
  body.classList.add('su-ai-body');
  let mode = ai.mode ?? 'cloud';
  const group = node('div', undefined, 'su-ai-modes'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Where AI runs');
  const blurb = node('p', undefined, 'su-muted');
  const modes = [['local', 'On this Mac'], ['cloud', 'Cloud'], ['off', 'Off']];
  let content;
  const show = async (next, focus = false, retry = false) => {
    mode = next;
    for (const radio of group.children) { const selected = radio.dataset.mode === mode; radio.setAttribute('aria-checked', String(selected)); radio.tabIndex = selected ? 0 : -1; if (focus && selected) radio.focus(); }
    blurb.textContent = { local: 'Models run on this Mac. Nothing leaves it.', cloud: 'Models run at the provider you choose. Transcript text is sent there.', off: 'Transcription only.' }[mode];
    content?.remove(); content = node('div', undefined, 'su-ai-body'); body.append(content);
    const target = content;
    const error = node('p', undefined, 'su-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const showError = e => { error.hidden = false; error.textContent = prose(e.message); };
    if (mode === 'cloud') { await cloudAiControls(ai, changed, { d, body: target, error, showError }); return; }
    const save = button('Save', async () => {
      save.disabled = true;
      try {
        await setupRequest('/api/setup/ai', 'PUT', { mode: next, ...(next === 'local' ? { main: target.querySelector('#su-ai-main').value, quick: target.querySelector('#su-ai-quick').value } : {}) });
        await changed({ background: true }); d.close('saved');
      } catch (e) { showError(e); save.disabled = false; }
    }, false, true);
    const footer = node('div', undefined, 'su-save'); footer.append(save);
    if (mode === 'off' || ai.forcedOff) {
      target.append(node('p', ai.forcedOff ? 'Off for this start (MEETING_CLOUD=0).' : 'No AI. Recording, transcription, listening and exports work as usual; notes, the Board, Explain and plans are unavailable.', 'su-ai-grey'), error, footer);
      save.disabled = !!ai.forcedOff; return;
    }
    target.append(node('p', 'Looking on this Mac…', 'su-muted'));
    try {
      const data = await setupRequest('/api/setup/ai/models?mode=local&refresh=1');
      if (!d.open || !target.isConnected) return;
      const items = data.models;
      target.replaceChildren();
      if (!items.length) {
        const box = node('div', undefined, 'su-consent'), install = node('p');
        install.append('Install Ollama from ', link('ollama.com', 'https://ollama.com'), ', then download a model in Terminal:');
        box.append(node('strong', 'No model server found on this Mac'), install, copyCommand(`ollama pull ${data.recommended}`), node('span', 'About 5 GB. LM Studio works too.', 'su-muted'), button('Check again', () => show('local', false, true)));
        target.append(box); save.disabled = true;
      } else {
        const servers = [...new Set(items.map(m => m.provider === 'ollama' ? 'Ollama' : 'LM Studio'))].join(' · ');
        target.append(node('p', `✓ ${servers} · ${items.length} ${items.length === 1 ? 'model' : 'models'} on this Mac`, 'su-ai-grey'));
        for (const role of ['main', 'quick']) {
          const wrap = node('div', undefined, 'su-field'), label = node('label');
          label.append(node('strong', role === 'main' ? 'Main model' : 'Quick model'), node('span', role === 'main' ? ' · notes, plans, Explain' : ' · the Board, corrections', 'su-muted'));
          const select = node('select'); select.id = `su-ai-${role}`; label.htmlFor = select.id;
          for (const item of items) { const option = node('option', item.id); option.value = item.id; select.append(option); }
          select.value = data.settings?.[role === 'main' ? 'localMainModel' : 'localQuickModel'] ?? items[0].id;
          if (!select.value) select.value = items[0].id;
          wrap.append(label, select); target.append(wrap);
        }
        target.append(node('p', 'Nothing leaves this Mac. While you record, the live Board and corrections wait until you stop, so the Mac stays free for transcription.', 'su-muted'));
      }
      target.append(error, footer);
      if (retry) (target.querySelector('select') ?? target.querySelector('.su-consent > button'))?.focus();
    } catch (e) { target.replaceChildren(error); showError(e); }
  };
  for (const [id, label] of modes) {
    const radio = button(label, () => show(id)); radio.dataset.mode = id; radio.setAttribute('role', 'radio');
    radio.disabled = !!ai.forcedOff;
    radio.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const index = modes.findIndex(m => m[0] === mode);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 2 : 1)) % 3;
      void show(modes[next][0], true);
    };
    group.append(radio);
  }
  body.append(group, blurb);
  void show(ai.forcedOff ? 'off' : mode);
  return await context.closed === 'saved';
}

export class SetupUI {
  constructor(container, { details = false, onStatus = () => {}, onError = () => {}, onSaved = () => {} } = {}) {
    this.container = container; this.details = details; this.onStatus = onStatus; this.onError = onError; this.onSaved = onSaved;
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
  changeAi = async () => {
    if (await aiDialog(this.status.rows.find(r => r.id === 'ai'), options => this.refresh(options))) await this.onSaved();
  };
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
    if (r.mode === 'local' || r.mode === 'off') {
      const warning = r.mode === 'local' && ['missing', 'no-access', 'unreadable', 'not-installed'].includes(r.state);
      return row('AI', r.forcedOff ? 'Off for this start (MEETING_CLOUD=0).' : r.mode === 'off' ? 'Off · transcription only' : warning && r.detail ? prose(r.detail) : `On this Mac${pair ? ` · ${pair}` : ''}`, warning ? 'warn' : r.state === 'ready' ? 'ok' : 'todo', r.forcedOff ? [] : change());
    }
    switch (r.state) {
      case 'ready': return row('AI', pair, 'ok', change());
      case 'reading': return row('AI', 'Reading Pi’s models…', 'busy');
      case 'checking': return row('AI', 'Checking access…', 'busy');
      case 'choose': return row('AI', 'Pi is signed in. Choose two models.', 'todo', [button('Choose models', this.changeAi)]);
      case 'missing': return row('AI', r.detail ? prose(r.detail) : 'A chosen model is no longer available.', 'warn', change());
      case 'no-access': return row('AI', `No access · ${prose(r.detail ?? pair)}`, 'warn', change());
      case 'off': return row('AI', 'Off for this start (MEETING_CLOUD=0).', 'todo');
      case 'not-installed': return row('AI', 'Pi is not installed. Run npm ci.', 'todo', recheck());
      case 'unreadable': return row('AI', 'Couldn’t read Pi’s models.', 'warn', recheck());
      default: return row('AI', 'Sign in with Pi in Terminal, then type /login — or add an API key with Choose models', 'todo', [...recheck(), button('Choose models', this.changeAi, true)], [copyCommand(r.signInCommand)]);
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
