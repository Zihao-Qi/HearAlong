/** Echo comparison tokens: keep numbers/signs intact; hyphens split ordinary words. */
export const echoWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, (char, at: number, raw: string) => {
  const before = raw[at - 1] ?? '', after = raw[at + 1] ?? '';
  if ((char === '.' || char === ',') && /\d/.test(before) && /\d/.test(after)) return char;
  if ((char === '-' || char === '−') && /\d/.test(after) && !/[\p{L}\p{M}\p{N}]/u.test(before)) return '-';
  return /\p{Pd}/u.test(char) ? ' ' : '';
}).split(/\s+/).filter(Boolean);

export type EchoWord = { text: string; startMs: number; endMs: number };

/** Small one-row LCS, shared by the <=20-word preview check. */
export function commonWords(own: string[], reference: string[]): number {
  const row = new Uint32Array(own.length + 1);
  for (const word of reference) {
    let diagonal = 0;
    for (let j = 1; j <= own.length; j++) {
      const previous = row[j];
      row[j] = word === own[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  return row[own.length];
}
