import { Suspense, useEffect, useMemo, useState } from 'react';
import type { Flags } from '@eko/shared';
import { FEATURES, type TradeSlots } from '../../features';
import { useShell } from '../../store/shell';

/**
 * Places in the trade panel that post-launch features (features.ts `trade`) can fill: a line under the amount of a
 * buy, and another way to trade beside real trading. A place shows only while its feature's flag is on; with none on,
 * these render nothing and the panel is unchanged. Places may be lazy components: each waits for them quietly.
 */
export function activeTradeSlots(features: readonly ({ flag: keyof Flags } & { trade?: TradeSlots })[], flags: Partial<Flags> | undefined): TradeSlots[] {
  return features.flatMap(f => f.trade && flags?.[f.flag] ? [f.trade] : []);
}
export function useTradeSlots(): TradeSlots[] {
  const flags = useShell(s => s.config?.flags);
  return useMemo(() => activeTradeSlots(FEATURES, flags), [flags]);
}

/**
 * Under a buy's amount. Returns the lines and the smallest limit any of them named (null for none), so the panel can
 * mark the amount buttons above it.
 */
export function useAmountSlots(coin: string, amountUsd: number) {
  const slots = useTradeSlots().filter(s => s.amount);
  const [limits, setLimits] = useState<Record<number, number | null>>({});
  useEffect(() => setLimits({}), [coin]);
  const named = Object.values(limits).filter((v): v is number => v !== null);
  const limit = named.length ? Math.min(...named) : null;
  const lines = slots.length ? <Suspense fallback={null}>{slots.map((s, i) => {
    const Line = s.amount!;
    return <Line key={i} coin={coin} amountUsd={amountUsd} onLimit={usd => setLimits(p => (p[i] === usd ? p : { ...p, [i]: usd }))} />;
  })}</Suspense> : null;
  return { lines, limit };
}

/** The other ways to trade beside real trading, by label. */
export function useTradeModes() {
  return useTradeSlots().flatMap(s => s.mode ? [s.mode] : []);
}
