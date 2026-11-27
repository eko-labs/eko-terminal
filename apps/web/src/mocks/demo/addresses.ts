/**
 * Addresses for offline data: 40 hex digits hashed from a seed (FNV-1a, repeated), so they look like any other
 * address and stay the same every run.
 */
/** Runs a reader would take for a placeholder (six of one digit, or a repeating start): drawn again. */
const PATTERNED = /(.)\1{5}|^0x(..)\2{3}/;
function fnv(seed: string): string {
  let out = '', h = 0x811c9dc5;
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return `0x${out.slice(0, 40)}`;
}
export function hashedAddress(seed: string): string {
  let a = fnv(seed);
  for (let k = 1; PATTERNED.test(a) && k < 16; k++) a = fnv(`${seed}~${k}`);
  return a;
}
/** A transaction hash, likewise. */
export const hashedTx = (seed: string) => {
  const make = (s: string) => `0x${[0, 1].map(n => hashedAddress(`${s}:${n}`).slice(2)).join('').slice(0, 64)}`;
  let t = make(seed);
  for (let k = 1; PATTERNED.test(t) && k < 16; k++) t = make(`${seed}~${k}`);
  return t;
};
