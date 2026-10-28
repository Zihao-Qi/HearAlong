/** A title-based attachment name with an ASCII fallback and RFC 5987 UTF-8 name. */
export function downloadDisposition(title: string, suffix: string): string {
  const safe = Array.from(title.replace(/[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim())
    .slice(0, 100).join('').trim() || 'Meeting';
  const name = `${safe} ${suffix}`;
  const fallback = Array.from(name, c => c.codePointAt(0)! > 127 ? '_' : c).join('');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
