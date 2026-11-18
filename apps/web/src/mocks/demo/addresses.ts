/**
 * Addresses for offline data: 40 hex digits hashed from a seed (FNV-1a, repeated), so they look like any other
 * address and stay the same every run.
 */
export function hashedAddress(seed: string): string {
  let out = '', h = 0x811c9dc5;
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return `0x${out.slice(0, 40)}`;
}
/** A transaction hash, likewise. */
export const hashedTx = (seed: string) => `0x${[0, 1].map(n => hashedAddress(`${seed}:${n}`).slice(2)).join('').slice(0, 64)}`;
