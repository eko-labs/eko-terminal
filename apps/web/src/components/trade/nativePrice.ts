import { useEffect, useSyncExternalStore } from 'react';
import { TradeQuoteSchema, type TradeQuote } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { CHAIN_KEY } from '../../lib/chain';
import { nativeUsdOfQuote } from './tradePanelModel';

/**
 * The native coin's USD price (ETH on Robinhood Chain), as the trade panel converts an ETH amount to the quote request's
 * dollars. There is no separate price feed for it: every buy quote states it (the edge sizes `amountIn` from its own ETH
 * price), so the panel learns it from each buy quote it gets, keeps the last one in this browser, and asks for one small
 * probe quote only when it has never seen one.
 */
interface Known { usd: number; at: number }
const KEY = `eko.trade.native-usd.${CHAIN_KEY}`;
const listeners = new Set<() => void>();
let known: Known | null = read();
let probing: Promise<void> | null = null;

function read(): Known | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Known | null;
    return v && typeof v.usd === 'number' && v.usd > 0 && Number.isFinite(v.usd) && typeof v.at === 'number' ? v : null;
  } catch { return null; }
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => known?.usd ?? null;
const serverSnapshot = () => null;

/** Keep the price a quote implies (buys only; a sell's proceeds include its impact and taxes). */
export function learnNativeUsd(q: Pick<TradeQuote, 'side' | 'amountUsd' | 'amountIn'>, at = Date.now()) {
  const usd = nativeUsdOfQuote(q);
  if (!usd || usd === known?.usd) return;
  known = { usd, at };
  try { localStorage.setItem(KEY, JSON.stringify(known)); } catch { /* not kept: the next quote states it again */ }
  listeners.forEach(fn => fn());
}

/** The last known native USD price, and one probe buy quote of `coin` when none is known yet. */
export function useNativeUsd(coin: string, enabled: boolean, probeUsd = 25): number | null {
  const usd = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    if (!enabled || known || probing) return;
    probing = fetchParsed('/trade/quote', TradeQuoteSchema, { body: { coin, side: 'buy', amountUsd: probeUsd, slippageBps: 100 }, background: true })
      .then(q => learnNativeUsd(q)).catch(() => {}).finally(() => { probing = null; });
  }, [coin, enabled, probeUsd]);
  return usd;
}

/** Tests: forget the known price. */
export function resetNativeUsd() { known = null; listeners.forEach(fn => fn()); }
