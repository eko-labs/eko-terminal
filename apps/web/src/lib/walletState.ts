import { create } from 'zustand';

/** Public pages do not initialize wallet discovery or RPC clients. */
export const useWalletState = create<{
  requested: boolean; open: boolean; ready: boolean; address?: string; chainId?: number;
}>(() => ({ requested: false, open: false, ready: false }));
export function requestWallet() { useWalletState.setState({ requested: true, open: true }); }
