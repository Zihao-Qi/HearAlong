// Syntactic URL boundary only: WHATWG normalizes integer/hex/octal/short IPv4 and IPv6 spelling; never resolve DNS here.
import { isIP } from 'node:net';
const privateV4 = (a: number, b: number) => a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
  || (a === 192 && b === 168) || (a === 169 && b === 254);

export function safeWebUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    return !privateV4(a, b);
  }
  if (kind === 6) {
    // URL's IPv6 serializer emits hex words, including for embedded dotted IPv4.
    const halves = host.split('::'), words = (part: string) => part ? part.split(':').map(word => Number.parseInt(word, 16)) : [];
    const head = words(halves[0]), tail = words(halves[1] ?? '');
    const address = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
    if ((address[0] & 0xfe00) === 0xfc00 || (address[0] & 0xffc0) === 0xfe80) return false;
    const compatible = address.slice(0, 6).every(word => word === 0);
    const mapped = address.slice(0, 5).every(word => word === 0) && address[5] === 0xffff;
    if (compatible || mapped) return !privateV4(address[6] >>> 8, address[6] & 255);
  }
  // Public-looking DNS names can still resolve to private addresses: that is a documented residual.
  return true;
}
