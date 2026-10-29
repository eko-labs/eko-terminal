import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('keyless wallet and receipt reads (mock fetch only)', () => {
  it('uses the API proxy for wallet reads and direct keyless RPC for historical receipt checks, without credentials', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.eko.example/v1');
    // Legacy provider overrides must never select a browser transport.
    vi.stubEnv('VITE_RH_MAINNET_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com');
    const calls: { url: string; credentials: string; headers: [string, string][]; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json() as Record<string, unknown>;
      calls.push({ url: request.url, credentials: request.credentials, headers: [...request.headers], body });
      const result = body.method === 'eth_chainId' ? '0x1237'
        : body.method === 'eth_getTransactionReceipt' ? null : `0x${'0'.repeat(63)}1`;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
    }));
    const { wagmiConfig, receiptReadClient, READ_RPC_URL } = await import('./wallet');
    expect(READ_RPC_URL).toBe('https://api.eko.example/v1/rpc');
    expect(await wagmiConfig.getClient({ chainId: 99901 }).request({ method: 'eth_chainId' })).toBe('0x1237');
    expect(await receiptReadClient.readContract({ address: `0x${'11'.repeat(20)}`, functionName: 'lastBatchId',
      blockNumber: 100n,
      abi: [{ type: 'function', name: 'lastBatchId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] }],
    })).toBe(1n);
    expect(await receiptReadClient.request({ method: 'eth_getTransactionReceipt', params: [`0x${'22'.repeat(32)}`] })).toBeNull();
    expect(calls.map(call => call.body.method)).toEqual(['eth_chainId', 'eth_call', 'eth_getTransactionReceipt']);
    expect((calls[1]!.body.params as unknown[])[1]).toBe('0x64');
    expect(calls.map(call => call.url)).toEqual([READ_RPC_URL, 'https://rpc.elysium.kinetiq.xyz/', 'https://rpc.elysium.kinetiq.xyz/']);
    for (const call of calls) {
      expect(call.credentials).toBe('omit');
      expect(call.headers.map(([name]) => name)).not.toContain('authorization');
      expect(call.headers.map(([name]) => name)).not.toContain('cookie');
      expect(Array.isArray(call.body)).toBe(false);
    }
  });
  it('defaults to same-origin /v1/rpc and excludes testnet from production chains', async () => {
    vi.stubEnv('VITE_API_URL', ''); vi.stubEnv('VITE_API_BASE', ''); vi.stubEnv('DEV', false);
    const { READ_RPC_URL, chains } = await import('./wallet');
    expect(READ_RPC_URL).toBe('/v1/rpc');
    expect(chains.map(chain => chain.id)).toEqual([99901]);
  });
});
