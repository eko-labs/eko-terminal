import { getConnection } from 'wagmi/actions';
import { create } from 'zustand';
import { WALLET_COPY as C } from '../copy/wallet';
import { useApp } from '../store/app';
import { ApiError } from './api';
import { BUILD_CHAIN_ID } from './chain';
import { isUserRejection, siweSignIn } from './trade';
import { wagmiConfig } from './wallet';

export const useWalletVerification = create<{
  pending: string | null;
  failure: { address: string; message: string } | null;
}>(() => ({ pending: null, failure: null }));

export async function verifyWallet(address: string, afterConnect = false) {
  const wallet = address.toLowerCase();
  const connected = () => getConnection(wagmiConfig).address?.toLowerCase() === wallet;
  const verified = () => useApp.getState().account?.walletAddress === wallet;
  if (useWalletVerification.getState().pending || !connected() || (!afterConnect && verified())) return;
  useWalletVerification.setState({ pending: wallet, failure: null });
  try {
    // The initial session lookup can still be in flight when the connector resolves.
    if (afterConnect) {
      try {
        await useApp.getState().refreshSession();
        if (verified()) return;
      } catch (error) {
        // The edge returns 401 for a visitor without a site session.
        if (!(error instanceof ApiError && error.status === 401)) throw error;
        useApp.setState({ account: null });
      }
    }
    if (!connected()) return;
    await siweSignIn(BUILD_CHAIN_ID, wallet);
    if (connected() && verified()) useApp.getState().toast({ kind: 'ok', title: C.verified });
  } catch (error) {
    if (connected()) {
      const message = isUserRejection(error) ? C.rejected : (error as Error).message;
      useWalletVerification.setState({ failure: { address: wallet, message } });
    }
  } finally {
    useWalletVerification.setState({ pending: null });
  }
}
