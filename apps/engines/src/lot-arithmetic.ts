import type { Rational } from '@eko/shared';
export interface Fraction { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; };
export function fraction(n: bigint, d = 1n): Fraction {
  if (d <= 0n) throw new Error('Positive denominator required');
  const g = gcd(n, d); return { n: n / g, d: d / g };
}
export const plus = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const times = (a: Fraction, n: bigint, d = 1n) => fraction(a.n * n, a.d * d);
export const rational = (a: Fraction): Rational => ({ numerator: a.n.toString(), denominator: a.d.toString() });
export function decimal(a: Fraction, digits = 36): string {
  const sign = a.n < 0n ? '-' : '', scale = 10n ** BigInt(digits), magnitude = a.n < 0n ? -a.n : a.n;
  const scaled = magnitude * scale / a.d;
  const tail = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${scaled === 0n ? '' : sign}${scaled / scale}${tail ? `.${tail}` : ''}`;
}
export function tokenDecimal(n: bigint, decimals: number): string { return decimal(fraction(n, 10n ** BigInt(decimals)), decimals || 1); }
