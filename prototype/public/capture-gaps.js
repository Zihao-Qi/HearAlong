/** Display-only metadata. Never inserted into speech segments or model input. */
export function mergeCaptureGaps(gaps) {
  const merged = [];
  for (const gap of [...gaps].sort((a, b) => a.fromWallMs - b.fromWallMs || a.toWallMs - b.toWallMs)) {
    const last = merged.at(-1);
    if (last && gap.fromWallMs < last.toWallMs) {
      last.toWallMs = Math.max(last.toWallMs, gap.toWallMs);
      last.atMs = Math.min(last.atMs, gap.atMs);
      if (gap.reason) last.reason = gap.reason;
    } else merged.push({ ...gap });
  }
  return merged.sort((a, b) => a.atMs - b.atMs || a.fromWallMs - b.fromWallMs);
}

export function captureGapText(gap, locale = undefined) {
  const seconds = Math.max(1, Math.floor((gap.toWallMs - gap.fromWallMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const duration = minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;
  const formatter = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true });
  const times = formatter.formatRange(new Date(gap.fromWallMs), new Date(gap.toWallMs)).replace(/\s+/g, ' ').replace(/ ?– ?/g, '–');
  const sameMinute = !minutes && formatter.format(new Date(gap.fromWallMs)) === formatter.format(new Date(gap.toWallMs));
  return `Not recorded for ${duration}${sameMinute ? ' at ' : ', '}${times}${gap.reason === 'sleep' ? ': the Mac was asleep' : ''}.`;
}
