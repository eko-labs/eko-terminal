import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useConnection } from 'wagmi';
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
export default function WalletRuntime({ children }: { children: ReactNode }) {
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><ConnectionBridge /><WalletTradeProvider>{children}</WalletTradeProvider></QueryClientProvider></WagmiProvider>;
}

/** Header controls share the same config/query cache without restarting the shell. */
export function WalletControls() {
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><WalletButton /></QueryClientProvider></WagmiProvider>;
}
