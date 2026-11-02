import type { UsageRow, UsageStore } from '@eko/chain';

/**
 * RPC usage kept in memory for the stateless edge. The metered RPC layer still enforces its per-day budgets and
 * timeouts; only persistence across restarts (and the cross-process provider pause, which needs a database) is
 * dropped. A restart starts the day's count from zero, which the provider's own quota still bounds.
 */
export function memoryUsageStore(): UsageStore {
  const rows = new Map<string, UsageRow & { day: string }>();
  const totals = new Map<string, number>();
  return {
    async reserve(day, provider, method, units, limit) {
      const key = `${day}:${provider}`, total = totals.get(key) ?? 0;
      if (total + units > limit) return { allowed: false, total };
      totals.set(key, total + units);
      const rowKey = `${day}:${provider}:${method}`, row = rows.get(rowKey) ?? { day, provider, method, calls: 0, units: 0 };
      row.calls++; row.units += units; rows.set(rowKey, row);
      return { allowed: true, total: total + units };
    },
    async today(day) {
      for (const k of [...rows.keys()]) if (!k.startsWith(`${day}:`)) rows.delete(k);
      return [...rows.values()].filter(r => r.day === day).map(({ provider, method, calls, units }) => ({ provider, method, calls, units }));
    },
  };
}
