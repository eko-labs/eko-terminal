import { useEffect, useState } from 'react';
import { erc20Abi, type Address } from 'viem';
import { MOCKS } from '../../lib/api';
import { receiptReadClient } from '../../lib/wallet';

/**
 * How much of a coin the connected wallet holds, read from the chain (balanceOf and decimals through the read-only
 * client), for selling a share of it. Mock mode (demos, films) stands in a bag worth about $850 at the shown price.
 * `decimals` turns a quote's raw amounts into tokens ("You get ≈ 1.24M FROG"); 18 until the chain says otherwise.
 */
export interface Holding { tokens: number | null; loading: boolean; noWallet: boolean; decimals?: number }
const MOCK_BAG_USD = 850;

export function useHolding(coin: string, wallet: string | undefined, priceUsd: number | undefined, refresh = 0): Holding {
  const [h, setH] = useState<Holding>({ tokens: null, loading: !!wallet, noWallet: !wallet });
  useEffect(() => {
    if (MOCKS && !wallet) { setH({ tokens: priceUsd ? MOCK_BAG_USD / priceUsd : null, loading: false, noWallet: false, decimals: 18 }); return; }
    if (!wallet) {
      setH({ tokens: null, loading: false, noWallet: true });
      // Decimals do not need a wallet: read them so a buy can say what it gets.
      let live = true;
      void receiptReadClient.readContract({ address: coin as Address, abi: erc20Abi, functionName: 'decimals' })
        .then(d => { if (live) setH(p => ({ ...p, decimals: Number(d) })); }).catch(() => {});
      return () => { live = false; };
    }
    let live = true;
    setH(p => ({ ...p, loading: true, noWallet: false }));
    const token = coin as Address, owner = wallet as Address;
    void Promise.all([
      receiptReadClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      receiptReadClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]).then(([raw, decimals]) => { if (live) setH({ tokens: Number(raw) / 10 ** Number(decimals), loading: false, noWallet: false, decimals: Number(decimals) }); })
      .catch(() => { if (live) setH({ tokens: null, loading: false, noWallet: false }); });
    return () => { live = false; };
    // The price only matters in mock mode; a new price never re-reads the chain.
  }, [coin, wallet, refresh, MOCKS ? priceUsd : 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return h;
}

/**
 * The wallet's native balance (ETH on Robinhood Chain), read through the same read-only client, for "Balance 0.42 ETH"
 * and MAX. Mock mode stands in 0.42 so the demo shows the line; null while unknown or without a wallet.
 */
export const MOCK_NATIVE_BALANCE = 0.42;
export function useNativeBalance(wallet: string | undefined, refresh = 0): number | null {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (MOCKS && !wallet) { setBalance(MOCK_NATIVE_BALANCE); return; }
    if (!wallet) { setBalance(null); return; }
    let live = true;
    void receiptReadClient.getBalance({ address: wallet as Address })
      .then(wei => { if (live) setBalance(Number(wei) / 1e18); })
      .catch(() => { if (live) setBalance(null); });
    return () => { live = false; };
  }, [wallet, refresh]);
  return balance;
}

/** Whole tokens, short: 1.25M, 840K, 12.5. */
export function shortTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
