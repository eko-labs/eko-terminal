import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import { CHAIN_IDS, CHAIN_KEYS, CHAIN_NETWORK, NETWORKS, type ChainKey, type Order, type PublicChain } from '@eko/shared';

// Both builds, one process: each case re-imports the wallet modules with VITE_EKO_CHAIN stubbed. Wallet actions are
// spies (no provider, RPC, keys or funds); the wagmi config itself is real, so the chain list is the shipped one.
const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(), switchChain: vi.fn(), signMessage: vi.fn(), sendTransaction: vi.fn(), writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(), fetchParsed: vi.fn(), api: vi.fn(), refreshSession: vi.fn(),
}));
vi.mock('wagmi/actions', async (original) => {
  const { fetchParsed: _f, api: _a, refreshSession: _r, ...actions } = mocks;
  return { ...await original<typeof import('wagmi/actions')>(), ...actions };
});
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), api: mocks.api, fetchParsed: mocks.fetchParsed }));
vi.mock('../store/app', () => ({ useApp: { getState: () => ({ refreshSession: mocks.refreshSession }) } }));

const address = '0x1111111111111111111111111111111111111111', router = '0x00000000000000000000000000000000000000bb';
const hash = `0x${'ab'.repeat(32)}`;
const challenge = { nonce: 'sampleNonce123', domain: 'app.eko.example', uri: 'https://app.eko.example', issuedAt: '2026-10-13T12:00:00.000Z', expirationTime: '2026-10-13T12:10:00.000Z' };
const other = (key: ChainKey): ChainKey => key === 'robinhood' ? 'elysium' : 'robinhood';
const served = (key: ChainKey): PublicChain => {
  const net = NETWORKS[CHAIN_NETWORK[key]];
  return { key, id: CHAIN_IDS[key], name: net.name, native: key === 'robinhood' ? 'ETH' : 'HYPE', explorerUrl: net.explorerUrl, publicRpcUrl: net.publicRpcUrl };
};
async function build(key: ChainKey) {
  vi.resetModules(); vi.stubEnv('VITE_EKO_CHAIN', key);
  const [trade, wallet, shell] = await Promise.all([import('./trade'), import('./wallet'), import('../store/shell')]);
  return { trade, wallet, shell, id: CHAIN_IDS[key] };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { href: 'https://app.eko.example/' }, history: { state: null, replaceState: vi.fn() } }));
  mocks.switchChain.mockResolvedValue(undefined); mocks.signMessage.mockResolvedValue('0xabcd');
  mocks.sendTransaction.mockResolvedValue(hash); mocks.writeContract.mockResolvedValue(hash);
  mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
  mocks.fetchParsed.mockImplementation(async (path: string) => path === '/auth/siwe/nonce' ? challenge : { account: { wallet: address } });
  mocks.api.mockResolvedValue({ order: { id: 'sample-order' } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe.each(CHAIN_KEYS)('%s build: wallet signing targets the build chain', (key) => {
  it('defines one wallet chain from the network registry', async () => {
    const { wallet, id } = await build(key), net = NETWORKS[CHAIN_NETWORK[key]];
    expect(wallet.chains.map(c => c.id)).toEqual([id]);
    expect(wallet.wagmiConfig.chains.map(c => c.id)).toEqual([id]);
    expect(wallet.buildChain).toMatchObject({ name: net.name, nativeCurrency: { symbol: key === 'robinhood' ? 'ETH' : 'HYPE', decimals: 18 },
      rpcUrls: { default: { http: [net.publicRpcUrl] } }, blockExplorers: { default: { url: net.explorerUrl } }, contracts: { multicall3: { address: net.contracts.multicall3 } } });
    if (key === 'robinhood') expect(wallet.buildChain.blockExplorers.default).toEqual({ name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' });
  });
  it('SIWE switches the wallet to the build chain and signs a message for it, whatever chain the wallet was on', async () => {
    const { trade, id } = await build(key);
    mocks.getConnection.mockReturnValueOnce({ address, chainId: CHAIN_IDS[other(key)] }).mockReturnValue({ address, chainId: id });
    await trade.siweSignIn(CHAIN_IDS[other(key)]);
    expect(mocks.switchChain).toHaveBeenCalledWith(expect.anything(), { chainId: id });
    const { message } = mocks.fetchParsed.mock.calls[1][2].body;
    expect(parseSiweMessage(message).chainId).toBe(id);
  });
  it('approvals and swaps go to the build chain; a transaction built for the other chain is refused unsigned', async () => {
    const { trade, id } = await build(key);
    await trade.approveExactToken({ token: router, spender: router, amount: '1' });
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chainId: id }));
    const order = { id: 'sample-order' } as Order, swap = { to: router, data: '0xabcd', value: '0' };
    await trade.signAndSubmit(order, { chainId: id, swap } as never);
    expect(mocks.sendTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chainId: id, to: router }));
    mocks.sendTransaction.mockClear(); mocks.writeContract.mockClear();
    await expect(trade.signAndSubmit(order, { chainId: CHAIN_IDS[other(key)], swap } as never)).rejects.toThrow(`EKO signs on ${NETWORKS[CHAIN_NETWORK[key]].name} (${id}) only`);
    await expect(trade.approveExactToken({ token: router, spender: router, amount: '1' }, CHAIN_IDS[other(key)])).rejects.toThrow(/only/);
    expect(mocks.sendTransaction).not.toHaveBeenCalled(); expect(mocks.writeContract).not.toHaveBeenCalled();
  });
  it('a server on another chain is a deployment error: nothing is signed', async () => {
    const { trade, wallet, shell, id } = await build(key);
    shell.useShell.setState({ config: { chain: served(key) } as never });
    expect(wallet.walletChainId(id)).toBe(id);
    shell.useShell.setState({ config: { chain: served(other(key)) } as never });
    mocks.getConnection.mockReturnValue({ address, chainId: id });
    await expect(trade.siweSignIn()).rejects.toThrow(/Deployment error/);
    await expect(trade.approveExactToken({ token: router, spender: router, amount: '1' })).rejects.toThrow(/Deployment error/);
    expect(() => wallet.walletChainId(id)).toThrow(/Deployment error/);
    for (const spy of [mocks.switchChain, mocks.signMessage, mocks.fetchParsed, mocks.writeContract, mocks.sendTransaction]) expect(spy).not.toHaveBeenCalled();
  });
});
