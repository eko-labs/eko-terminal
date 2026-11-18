import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiContext, WagmiProvider, useConnection } from 'wagmi';
import { WalletTradeProvider } from './components/trade/WalletTradeProvider';
import { wagmiConfig } from './lib/wallet';
import { useWalletState } from './lib/walletState';
import { WalletButton } from './components/WalletButton';
const queryClient = new QueryClient();
function ConnectionBridge() {
  const { address, chainId } = useConnection();
  useEffect(() => { useWalletState.setState({ ready: true, address, chainId }); }, [address, chainId]);
  useEffect(() => () => { useWalletState.setState({ ready: false, address: undefined, chainId: undefined }); }, []);
  return null;
}
export default function WalletRuntime() {
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><ConnectionBridge /><WalletTradeProvider /></QueryClientProvider></WagmiProvider>;
}

/** Pages and controls share the hydrated config and query cache. */
export function WalletScope({ children }: { children: ReactNode }) {
  return <WagmiContext.Provider value={wagmiConfig}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiContext.Provider>;
}

export function WalletControls({ trade }: { trade?: boolean }) {
  return <WalletScope><WalletButton trade={trade} /></WalletScope>;
}
