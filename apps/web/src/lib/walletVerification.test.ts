import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_CHAIN_ID } from './chain';
import { WALLET_COPY } from '../copy/wallet';
import { ApiError } from './api';

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(), siweSignIn: vi.fn(), refreshSession: vi.fn(), toast: vi.fn(),
  account: { walletAddress: null as string | null },
}));
vi.mock('wagmi/actions', () => ({ getConnection: mocks.getConnection }));
vi.mock('./wallet', () => ({ wagmiConfig: {} }));
vi.mock('./trade', async () => ({ siweSignIn: mocks.siweSignIn, ...(await import('./tradeKeys')) }));
vi.mock('../store/app', () => ({
  useApp: {
    getState: () => mocks,
    setState: () => { mocks.account.walletAddress = null; },
  },
}));

import { verifyWallet, useWalletVerification } from './walletVerification';

const address = '0x1111111111111111111111111111111111111111';
const otherWallet = '0x2222222222222222222222222222222222222222';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getConnection.mockReturnValue({ address });
  mocks.account.walletAddress = null;
  mocks.refreshSession.mockResolvedValue(undefined);
  mocks.siweSignIn.mockImplementation(async () => { mocks.account.walletAddress = address; });
  useWalletVerification.setState({ pending: null, failure: null });
});

describe('verification after an explicit wallet connection', () => {
  it('checks the site session and starts SIWE once for the connected address', async () => {
    const auto = verifyWallet(address, true);
    expect(useWalletVerification.getState().pending).toBe(address);
    await verifyWallet(address);
    await auto;
    expect(mocks.siweSignIn).toHaveBeenCalledExactlyOnceWith(BUILD_CHAIN_ID, address);
    expect(mocks.refreshSession).toHaveBeenCalledBefore(mocks.siweSignIn);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it('skips signing if the site session already verifies this wallet', async () => {
    mocks.refreshSession.mockImplementation(async () => { mocks.account.walletAddress = address; });
    await verifyWallet(address, true);
    expect(mocks.siweSignIn).not.toHaveBeenCalled();
    expect(useWalletVerification.getState().pending).toBeNull();
  });

  it('starts SIWE when the edge returns 401 for a missing or expired session', async () => {
    mocks.account.walletAddress = address;
    mocks.refreshSession.mockRejectedValueOnce(new ApiError(401, 'wallet_auth_required', 'Sign in with your wallet to continue.'));
    await verifyWallet(address, true);
    expect(mocks.siweSignIn).toHaveBeenCalledExactlyOnceWith(BUILD_CHAIN_ID, address);
  });

  it('leaves rejection visible and retries only when the user asks', async () => {
    mocks.siweSignIn.mockRejectedValueOnce(Object.assign(new Error(), { code: 4001 }));
    await verifyWallet(address, true);
    expect(mocks.siweSignIn).toHaveBeenCalledTimes(1);
    expect(useWalletVerification.getState()).toMatchObject({
      pending: null, failure: { address, message: WALLET_COPY.rejected },
    });
    expect(mocks.toast).not.toHaveBeenCalled();

    await verifyWallet(address);
    expect(mocks.siweSignIn).toHaveBeenCalledTimes(2);
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(useWalletVerification.getState().failure).toBeNull();
  });

  it('does not sign for a wallet that changed during the session lookup', async () => {
    mocks.refreshSession.mockImplementation(async () => {
      mocks.getConnection.mockReturnValue({ address: otherWallet });
    });
    await verifyWallet(address, true);
    expect(mocks.siweSignIn).not.toHaveBeenCalled();
  });
});
