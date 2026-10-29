// Shared by local material search and the AI read boundary.
const EXCLUDED = new Set(['node_modules', '.git', '.ssh', '.aws', '.cache', '__pycache__', 'project-memory']);
/** Seatbelt regex equivalent, applied only BELOW an explicit material root, never to its ancestors. */
export function excludedDescendants(root: string): string {
  const insensitive = (text: string) => text.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
  const names = insensitive('node_modules|__pycache__|project-memory');
  const credentials = insensitive('secret|credential|password|token');
  const extensions = insensitive('pem|key|p12|pfx');
  const prefix = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${prefix}/([^/]+/)*([.][^/]*|${names}|[^/]*(${credentials})[^/]*|[^/]*[.](${extensions}))(/|$)`;
}
export function excluded(name: string) {
  return name.startsWith('.') || EXCLUDED.has(name.toLowerCase()) || /(?:secret|credential|password|token)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
}
