/**
 * React keys for rows that can share a natural key: one transaction can hold two swaps on the same side at the same
 * second (split routing, a multi-hop), so `tx:side:ts` is not unique. Repeats get `#2`, `#3` in list order, which
 * stays stable as newer rows are added because swaps in one transaction always arrive together and in chain order.
 */
export function uniqueKeys<T>(items: readonly T[], base: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map(item => {
    const k = base(item), n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}
