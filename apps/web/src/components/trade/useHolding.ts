import { useEffect, useState } from 'react';
import { erc20Abi, type Address } from 'viem';
import { MOCKS } from '../../lib/api';
import { receiptReadClient } from '../../lib/wallet';

/**
 * How much of a coin the connected wallet holds, read from the chain (balanceOf and decimals through the read-only
 * client), for selling a share of it. Mock mode (demos, films) stands in a bag worth about $850 at the shown price.
 */
export interface Holding { tokens: number | null; loading: boolean; noWallet: boolean }
const MOCK_BAG_USD = 850;

export function useHolding(coin: string, wallet: string | undefined, priceUsd: number | undefined, refresh = 0): Holding {
  const [h, setH] = useState<Holding>({ tokens: null, loading: !!wallet, noWallet: !wallet });
  useEffect(() => {
    if (MOCKS && !wallet) { setH({ tokens: priceUsd ? MOCK_BAG_USD / priceUsd : null, loading: false, noWallet: false }); return; }
    if (!wallet) { setH({ tokens: null, loading: false, noWallet: true }); return; }
    let live = true;
    setH(p => ({ ...p, loading: true, noWallet: false }));
    const token = coin as Address, owner = wallet as Address;
    void Promise.all([
      receiptReadClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      receiptReadClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]).then(([raw, decimals]) => { if (live) setH({ tokens: Number(raw) / 10 ** Number(decimals), loading: false, noWallet: false }); })
      .catch(() => { if (live) setH({ tokens: null, loading: false, noWallet: false }); });
    return () => { live = false; };
    // The price only matters in mock mode; a new price never re-reads the chain.
  }, [coin, wallet, refresh, MOCKS ? priceUsd : 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return h;
}

/** Whole tokens, short: 1.25M, 840K, 12.5. */
export function shortTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
