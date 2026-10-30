// Shared by local material search and the AI read boundary.
const EXCLUDED = new Set(['node_modules', '.git', '.ssh', '.aws', '.cache', '__pycache__', 'project-memory']);
// Shared pattern fragments keep the JS gate and Seatbelt descendant denies in agreement (POSIX-compatible groups).
const PRIVATE_KEYS = '([^/]*_)?(rsa|dsa|ecdsa|ed25519)(_sk)?';
const PRIVATE_EXTENSIONS = 'pem|key|p12|pfx|keystore|jks|kdbx|ovpn';
const ENV_FILES = '[^/]*[.]env([.][^/]*)?';
const privateKey = new RegExp(`^${PRIVATE_KEYS}$`, 'i');
const privateExtension = new RegExp(`[.](${PRIVATE_EXTENSIONS})$`, 'i');
const envFile = new RegExp(`^${ENV_FILES}$`, 'i');
/** Seatbelt regex equivalent, applied only BELOW an explicit material root, never to its ancestors. */
export function excludedDescendants(root: string): string {
  const insensitive = (text: string) => text.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
  const names = insensitive('node_modules|__pycache__|project-memory');
  const credentials = insensitive('secret|credential|password|token');
  const extensions = insensitive(PRIVATE_EXTENSIONS), keys = insensitive(PRIVATE_KEYS), env = insensitive(ENV_FILES);
  const prefix = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${prefix}/([^/]+/)*([.][^/]*|${names}|[^/]*(${credentials})[^/]*|${keys}|${env}|[^/]*[.](${extensions}))(/|$)`;
}
export function excluded(name: string) {
  return name.startsWith('.') || EXCLUDED.has(name.toLowerCase()) || /(?:secret|credential|password|token)/i.test(name)
    || privateKey.test(name) || privateExtension.test(name) || envFile.test(name);
}
