// Only launcher/server lifecycle messages, not a global console wrapper.
export function lifecycleLines(message: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
  return message.split(/\r\n|\r|\n/).map(line => `${time} ${line}`).join('\n');
}

export type IdleReason = 'no-page' | 'last-page-closed';
export function idleStopMessage(reason: IdleReason): string {
  return reason === 'no-page'
    ? 'No page ever connected within 60 s and nothing is running: stopping.'
    : 'The last page closed and nothing is running: stopping.';
}
