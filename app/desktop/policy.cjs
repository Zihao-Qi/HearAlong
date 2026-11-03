'use strict';
function backgroundLabel(status) { return status.label?.trim() || 'Finishing work in the background'; }
function backgroundVisible(status, owned) { return Boolean(owned && status && !status.pageOpen && status.working); }
function backgroundQuitText(status) {
  const name = status.title?.trim() || 'this meeting';
  const title = Array.from(name).length > 40 ? Array.from(name).slice(0, 39).join('') + '…' : name;
  const kinds = {
    notes: ['notes are being written', `The notes for ${title} stop now. You can write them again from the Notes tab.`],
    plans: ['plans are being made', `The plans for ${title} stop now. You can make them again from the Plans tab.`],
    actions: ['answers are being written'], transcription: ['audio is being transcribed'], import: ['audio is being imported'],
    download: ['the speech model is being downloaded'], memory: ['memory is being updated'], board: ['the Board is being scanned'],
    corrections: ['the transcript is being corrected'], glossary: ['the glossary is being built'],
    recording: ['audio is being recorded'], replay: ['audio is being replayed'],
  };
  const [work, text] = kinds[status.kind] || ['work is running'];
  return { title: `Quit while ${work}?`, text: text || 'This work stops now.' };
}
function miniVisible(live, frontmost) { return Boolean(live?.session != null && live.show && !frontmost); }
function serverExit(code, quitting) { return quitting ? 'stopping' : code === 0 ? 'quit' : 'error'; }
function permissionAllowed(origin, permission, requestingOrigin, details = {}) {
  return permission === 'media' && requestingOrigin === origin && details.isMainFrame === true
    && (details.mediaTypes ? details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio' : details.mediaType === 'audio');
}
function navigation(origin, target) {
  try {
    const url = new URL(target);
    if (url.origin === origin) return 'allow';
    return ['http:', 'https:'].includes(url.protocol) ? 'external' : 'deny';
  } catch { return 'deny'; }
}
function launcherLogLines(message, date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const pad = n => String(n).padStart(2, '0');
  const zone = offset === 0 ? 'Z' : `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
  return String(message).replace(/\r\n?/g, '\n').split('\n').map(line => `${time} ${line}\n`).join('');
}
module.exports = { backgroundLabel, backgroundVisible, backgroundQuitText, miniVisible, serverExit, permissionAllowed, navigation, launcherLogLines };
