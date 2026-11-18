import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import { SIWE_STATEMENT } from '@eko/shared';
import { BUILD_CHAIN_ID } from './chain';

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(), switchChain: vi.fn(), signMessage: vi.fn(), fetchParsed: vi.fn(),
  refreshSession: vi.fn(), reconnect: vi.fn(), storage: new Map<string, string>(),
}));
vi.mock('wagmi/actions', () => ({ ...mocks, getPublicClient: vi.fn(() => ({})), sendTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(), writeContract: vi.fn() }));
vi.mock('./wallet', async (original) => ({ ...await original<typeof import('./wallet')>(), wagmiConfig: {} }));
vi.mock('./api', () => ({ API_BASE: '/v1', api: vi.fn(), fetchParsed: mocks.fetchParsed }));
vi.mock('../store/app', () => ({ useApp: { getState: () => ({ refreshSession: mocks.refreshSession }) } }));
vi.mock('../store/shell', () => ({ useShell: { getState: () => ({ realtime: { reconnect: mocks.reconnect }, me: { account: { id: 'sample-wallet' } } }) } }));
import { siweSignIn } from './trade';
import { captureReferral, capturedReferral } from './referral';

const address = '0x1111111111111111111111111111111111111111';
const challenge = { nonce: 'sampleNonce123', domain: 'app.eko.example', uri: 'https://app.eko.example', issuedAt: '2026-10-13T12:00:00.000Z', expirationTime: '2026-10-13T12:10:00.000Z' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.storage.clear();
  vi.stubGlobal('window', { location: { href: 'https://app.eko.example/?ref=sample-ref' }, history: { state: null, replaceState: vi.fn((_state, _title, url) => { window.location.href = String(url); }) } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.storage.get(k) ?? null, setItem: (k: string, v: string) => mocks.storage.set(k, v), removeItem: (k: string) => mocks.storage.delete(k) });
  mocks.getConnection.mockReturnValue({ address, chainId: BUILD_CHAIN_ID });
  mocks.switchChain.mockResolvedValue(undefined); mocks.signMessage.mockResolvedValue('0xabcd');
  mocks.fetchParsed.mockImplementation(async (path: string) => path === '/auth/siwe/nonce' ? challenge : { account: { wallet: address } });
  mocks.refreshSession.mockResolvedValue(undefined);
});

describe('wallet v1 account flow (mock transports, no wallet or RPC)', () => {
  it('uses server challenge times, v1 POSTs and attribution, then reloads /me before reconnecting', async () => {
    await siweSignIn(BUILD_CHAIN_ID);
    expect(mocks.fetchParsed.mock.calls.map(c => c[0])).toEqual(['/auth/siwe/nonce', '/auth/siwe/verify']);
    expect(mocks.fetchParsed.mock.calls[0][2]).toEqual({ method: 'POST' });
    const body = mocks.fetchParsed.mock.calls[1][2].body;
    const fields = parseSiweMessage(body.message);
    expect(fields).toMatchObject({ chainId: BUILD_CHAIN_ID, domain: challenge.domain, uri: challenge.uri, statement: SIWE_STATEMENT });
    expect(fields.issuedAt?.toISOString()).toBe(challenge.issuedAt);
    expect(fields.expirationTime?.toISOString()).toBe(challenge.expirationTime);
    expect(body.ref).toBe('sample-ref');
    expect(mocks.storage.has('eko.ref')).toBe(false);
    expect(mocks.refreshSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.reconnect.mock.invocationCallOrder[0]);
  });
  it('switches to the build chain before asking for a challenge', async () => {
    mocks.getConnection.mockReturnValueOnce({ address, chainId: 1 });
    await siweSignIn(1);
    expect(mocks.switchChain).toHaveBeenCalledWith({}, { chainId: BUILD_CHAIN_ID });
    expect(mocks.switchChain.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetchParsed.mock.invocationCallOrder[0]);
  });
  it('blocks verification if the account changes while signing', async () => {
    mocks.signMessage.mockImplementation(async () => { mocks.getConnection.mockReturnValue({ address: '0x2222222222222222222222222222222222222222', chainId: BUILD_CHAIN_ID }); return '0xabcd'; });
    await expect(siweSignIn()).rejects.toThrow(/Wallet changed/);
    expect(mocks.fetchParsed).toHaveBeenCalledTimes(1); expect(mocks.reconnect).not.toHaveBeenCalled();
  });
  it('does not prompt if the connected address changes while fetching the challenge', async () => {
    mocks.fetchParsed.mockImplementationOnce(async () => {
      mocks.getConnection.mockReturnValue({ address: '0x2222222222222222222222222222222222222222', chainId: BUILD_CHAIN_ID });
      return challenge;
    });
    await expect(siweSignIn(BUILD_CHAIN_ID, address)).rejects.toThrow(/Wallet changed/);
    expect(mocks.signMessage).not.toHaveBeenCalled();
  });
  it('retains attribution after rejection and captures it before query-free navigation', async () => {
    captureReferral();
    window.location.href = 'https://app.eko.example/radar';
    expect(capturedReferral()).toBe('sample-ref');
    mocks.signMessage.mockRejectedValue(new Error('Signature rejected'));
    await expect(siweSignIn()).rejects.toThrow('Signature rejected');
    expect(capturedReferral()).toBe('sample-ref');
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });
  it('uses first touch for 30 days and strips only the referral query parameter', () => {
    captureReferral();
    expect(window.location.href).toBe('https://app.eko.example/');
    window.location.href = 'https://app.eko.example/?ref=later-code&demo=1#scan';
    captureReferral();
    expect(capturedReferral()).toBe('sample-ref');
    expect(window.location.href).toBe('https://app.eko.example/?demo=1#scan');
    mocks.storage.set('eko.ref', JSON.stringify({ code: 'expired-code', expiresAt: Date.now() - 1 }));
    expect(capturedReferral()).toBeUndefined();
    window.location.href = 'https://app.eko.example/?ref=new-code';
    captureReferral();
    expect(capturedReferral()).toBe('new-code');
    expect(JSON.parse(mocks.storage.get('eko.ref')!).expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
  });
});
