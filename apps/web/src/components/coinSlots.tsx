import { createContext, Suspense, useContext, useMemo, type ReactNode } from 'react';
import type { Flags } from '@eko/shared';
import { FEATURES, type CoinSlots } from '../features';
import { useShell } from '../store/shell';
import type { ChartCore } from './chart/chartCore';

/**
 * Places on the coin page that post-launch features (features.ts) can fill: over the price chart, in the chart's key
 * row, and next to a wallet in the Flow and Trades tabs. A slot shows only while its feature's flag is on; with none
 * on, these render nothing and the page is unchanged. Slots may be lazy components: each place waits for them quietly.
 */
const CoinAddress = createContext<string | null>(null);

/** The coin the slots below belong to (the coin page wraps its content in this). */
export function CoinSlotScope({ coin, children }: { coin: string; children: ReactNode }) {
  return <CoinAddress.Provider value={coin}>{children}</CoinAddress.Provider>;
}

/** The coin slots of the features whose flag is on. */
export function activeCoinSlots(features: readonly ({ flag: keyof Flags } & { coin?: CoinSlots })[], flags: Partial<Flags> | undefined): CoinSlots[] {
  return features.flatMap(f => f.coin && flags?.[f.flag] ? [f.coin] : []);
}
export function useCoinSlots(): CoinSlots[] {
  const flags = useShell(s => s.config?.flags);
  return useMemo(() => activeCoinSlots(FEATURES, flags), [flags]);
}

/** Drawn over the price chart's plot, in the chart core's coordinates. */
export function ChartOverlaySlots({ core }: { core: ChartCore }) {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.chartOverlay);
  if (!coin || !slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Overlay = s.chartOverlay!; return <Overlay key={i} coin={coin} core={core} />; })}</Suspense>;
}
/** Under the chart, beside its own key row. */
export function ChartKeySlots() {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.chartKey);
  if (!coin || !slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Key = s.chartKey!; return <Key key={i} coin={coin} />; })}</Suspense>;
}
/** After a wallet address in the coin page's tables. */
export function WalletSlots({ wallet }: { wallet: string }) {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.wallet);
  if (!coin || !slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Badge = s.wallet!; return <Badge key={i} coin={coin} wallet={wallet} />; })}</Suspense>;
}
