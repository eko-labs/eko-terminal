/** Pinned BigInt interval arithmetic: 60 working / 36 output fractional digits, half-even.
 * All transcendentals enclose their exact value; no binary floating-point price math. */
const S = 10n ** 60n;
type Interval = { lo: bigint; hi: bigint };
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const add = (a: Interval, b: Interval): Interval => ({ lo: a.lo + b.lo, hi: a.hi + b.hi });
const mul = (a: Interval, b: Interval): Interval => ({ lo: a.lo * b.lo / S, hi: ceil(a.hi * b.hi, S) });
const div = (a: Interval, d: bigint): Interval => ({ lo: a.lo / d, hi: ceil(a.hi, d) });
const ratio = (n: bigint, d: bigint): Interval => ({ lo: n * S / d, hi: ceil(n * S, d) });
// ln(r) = 2 sum z^(2k+1)/(2k+1), z=(r-1)/(r+1), 0<=z<=1/3.
function logSmall(n: bigint, d: bigint): Interval {
  const z = ratio(n - d, n + d), z2 = mul(z, z);
  let power = z, sum: Interval = { lo: 0n, hi: 0n }, k = 0n;
  for (;;) {
    sum = add(sum, div(power, 2n * k + 1n));
    power = mul(power, z2); k++;
    // Tail <= next/(2k+1)/(1-z²); 9/8 is a conservative bound.
    const tail = ceil(power.hi * 9n, (2n * k + 1n) * 8n);
    if (tail <= 4n) return { lo: sum.lo * 2n, hi: (sum.hi + tail) * 2n };
  }
}
const LN2 = logSmall(2n, 1n);
function logRatio(n: bigint, d: bigint): Interval {
  let k = 0n;
  while (n > d * 2n) { d *= 2n; k++; }
  const small = logSmall(n, d);
  return { lo: small.lo + k * LN2.lo, hi: small.hi + k * LN2.hi };
}
function negativeExp(x: Interval): Interval {
  // exp(-100) < 4e-44, enclosed without a huge Taylor sum.
  if (x.lo >= 100n * S) return { lo: 0n, hi: 4n * 10n ** 16n };
  let halves = 0;
  while (x.hi > S) { x = div(x, 2n); halves++; }
  let term: Interval = { lo: S, hi: S }, sum = term, n = 0n;
  for (;;) {
    n++; term = div(mul(term, x), n); sum = add(sum, term);
    const next = div(mul(term, x), n + 1n);
    if (n >= 2n && next.hi <= 4n) { sum = { lo: sum.lo, hi: sum.hi + 2n * next.hi }; break; }
  }
  let inverse: Interval = { lo: S * S / sum.hi, hi: ceil(S * S, sum.lo) };
  for (let i = 0; i < halves; i++) inverse = mul(inverse, inverse);
  return inverse;
}
function display(n: bigint): string {
  const drop = 10n ** 24n, q = n / drop, r = n % drop;
  const rounded = q + (r * 2n > drop || r * 2n === drop && q % 2n === 1n ? 1n : 0n);
  const scale = 10n ** 36n, tail = (rounded % scale).toString().padStart(36, '0').replace(/0+$/, '');
  return `${rounded / scale}${tail ? `.${tail}` : ''}`;
}
export interface PressureLeg { before: { n: bigint; d: bigint }; after: { n: bigint; d: bigint }; fraction: { n: bigint; d: bigint } }
export function campaignPressure(legs: PressureLeg[]) {
  let sum: Interval = { lo: 0n, hi: 0n };
  for (const { before: b, after: a, fraction: f } of legs) {
    if (b.n <= 0n || b.d <= 0n || a.n <= 0n || a.d <= 0n || f.d <= 0n || f.n < 0n || f.n > f.d) throw new Error('Invalid pressure ratio');
    const n = b.n * a.d, d = b.d * a.n;
    if (n > d) { const l = logRatio(n, d); sum = add(sum, { lo: l.lo * f.n / f.d, hi: ceil(l.hi * f.n, f.d) }); }
  }
  const e = negativeExp(sum), lower = S - (e.hi > S ? S : e.hi), upper = S - e.lo;
  return { method: 'bigint-interval-ln-exp-1' as const, fractionalDigits: 36, workingDigits: 60, rounding: 'half_even' as const,
    fraction: display((lower + upper) / 2n), pct: display((lower + upper) * 50n),
    errorBounds: { lower: { numerator: (lower / 10n**24n).toString(), denominator: (10n**36n).toString() }, upper: { numerator: ceil(upper,10n**24n).toString(), denominator: (10n**36n).toString() } } };
}
/** Inclusive comparison stays unknown when the threshold lies in the numerical enclosure. */
export function pressureAtLeast(p: ReturnType<typeof campaignPressure>, n: bigint, d: bigint): boolean | null {
  const lo = BigInt(p.errorBounds.lower.numerator), hi = BigInt(p.errorBounds.upper.numerator);
  const denominator=BigInt(p.errorBounds.lower.denominator);
  if (lo * d > n * denominator || lo === hi && lo * d === n * denominator) return true;
  if (hi * d < n * denominator) return false;
  return null;
}
