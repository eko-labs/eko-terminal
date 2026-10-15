import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createPublicClient, custom } from 'viem';
import { robinhood, robinhoodTestnet } from 'viem/chains';
import { RpcMeter, defaultPublicRpc, type RpcRequest, type UsageRow, type UsageStore } from '@eko/chain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { READ_RPC_METHODS, RPC_BODY_LIMIT, rpcRoutes } from '../src/http/v1/rpc.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDemoToken } from '../src/http/v1/demo.js';

const address = `0x${'11'.repeat(20)}`;
const hash = `0x${'22'.repeat(32)}`;
const tx = { to: address, data: '0x1234' };
const examples: Record<(typeof READ_RPC_METHODS)[number], unknown[]> = {
  eth_chainId: [], eth_blockNumber: [], eth_gasPrice: [],
  eth_getBlockByNumber: ['latest', false], eth_feeHistory: ['0x4', 'latest', [10, 50, 90]],
  eth_call: [tx, 'latest'], eth_getBalance: [address, 'latest'], eth_getCode: [address, 'latest'],
  eth_estimateGas: [tx], eth_getTransactionByHash: [hash], eth_getTransactionReceipt: [hash],
};
const body = (method = 'eth_blockNumber', params: unknown[] = [], id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

async function fixture() {
  let time = Date.UTC(2026, 9, 2);
  const rows = new Map<string, UsageRow>();
  const store: UsageStore = {
    async reserve(_day, provider, method, units, limit) {
      const total = [...rows.values()].filter(r => r.provider === provider).reduce((sum, r) => sum + r.units, 0);
      if (total + units > limit) return { allowed: false, total };
      const key = `${provider}:${method}`, row = rows.get(key) ?? { provider, method, calls: 0, units: 0 };
      row.calls++; row.units += units; rows.set(key, row);
      return { allowed: true, total: total + units };
    },
    async today() { return [...rows.values()]; },
  };
  const logs: string[] = [];
  const meter = new RpcMeter({ RPC_HTTP_URL: defaultPublicRpc }, { store, now: () => time,
    sleep: async ms => { time += ms; }, log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) });
  const send = vi.fn(async (request: RpcRequest): Promise<unknown> => request.method === 'eth_chainId' ? '0x1237' : '0x1');
  const client = createPublicClient({ chain: robinhood, transport: custom({
    request: request => meter.request(request, { paid: send, public: send }),
  }, { retryCount: 0 }) });
  const app = Fastify();
  await app.register(rateLimit, { global: true, max: 600, keyGenerator: req => req.headers.cookie ?? req.ip });
  await app.register(async area => rpcRoutes(area, client), { prefix: '/v1' });
  await app.ready();
  const call = (payload: unknown, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') => app.inject({
    method: 'POST', url: '/v1/rpc', payload: payload as object, headers, remoteAddress,
  });
  return { app, meter, send, logs, call, close: async () => { await app.close(); await meter.close(); } };
}

describe('bounded read RPC (injection and metered fake provider, no network)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); });
  afterAll(async () => { await f.close(); });
  it.each(READ_RPC_METHODS)('meters and returns %s', async method => {
    const before = (await f.meter.usage()).sessionUnits;
    const response = await f.call(body(method, examples[method], 'sample-request'));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jsonrpc: '2.0', id: 'sample-request', result: method === 'eth_chainId' ? '0x1237' : '0x1' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await f.meter.usage()).sessionUnits).toBe(before + 1);
    expect(f.send.mock.lastCall?.[0].method).toBe(method);
  });
  it('strips state overrides and sends only validated method/params', async () => {
    const overrides = { [address]: { balance: '0x100', code: '0x1234', stateDiff: { [hash]: hash } } };
    const response = await f.call(body('eth_call', [tx, 'latest', overrides]), {
      authorization: 'Bearer sample-bearer', cookie: 'eko_sid=sample-session', 'x-api-key': 'sample-key',
    });
    expect(response.statusCode).toBe(200);
    expect(f.send.mock.lastCall?.[0]).toEqual({ method: 'eth_call', params: [{ ...tx, gas: '0x4c4b40' }, 'latest'] });
    expect(response.body + f.logs.join('')).not.toMatch(/sample-bearer|sample-session|sample-key/);
    expect((await f.call(body('eth_estimateGas', [tx, 'latest']))).statusCode).toBe(200);
  });
  it.each(['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_getLogs', 'eth_getStorageAt', 'debug_traceCall', 'unknown', '__proto__', 'constructor'])('rejects %s before metering', async method => {
    const before = f.send.mock.calls.length;
    expect((await f.call(body(method))).json().error.code).toBe(-32601);
    expect(f.send.mock.calls.length).toBe(before);
  });
  it('rejects mixed/allowed batches and notifications without executing any item', async () => {
    const before = f.send.mock.calls.length;
    for (const payload of [[], [body()], [body(), body('eth_sendRawTransaction', ['0x1234'])], { jsonrpc: '2.0', method: 'eth_blockNumber' }]) {
      expect((await f.call(payload)).json().error.code).toBe(-32600);
    }
    expect(f.send.mock.calls.length).toBe(before);
  });
  it.each(['0x0', '0x1234', 'pending', 'earliest', 'safe', 'finalized', { blockHash: hash }, { blockNumber: '0x1' }])('rejects non-latest tags %j everywhere', async tag => {
    const before = f.send.mock.calls.length;
    for (const [method, params] of [
      ['eth_getBlockByNumber', [tag, false]], ['eth_feeHistory', ['0x4', tag, []]],
      ['eth_call', [tx, tag]], ['eth_getBalance', [address, tag]], ['eth_getCode', [address, tag]], ['eth_estimateGas', [tx, tag]],
    ] as const) {
      expect((await f.call(body(method, [...params]))).json().error.code).toBe(-32602);
    }
    expect(f.send.mock.calls.length).toBe(before);
  });
  it('rejects malformed parameters/envelopes, overrides on estimates, and resource excesses', async () => {
    const before = f.send.mock.calls.length;
    const invalid = [null, 1, 'invalid-json', { ...body(), jsonrpc: '1.0' }, { ...body(), id: null },
      { ...body(), authorization: 'sample-bearer' }, body('eth_getBalance', ['bad-address', 'latest']),
      body('eth_getTransactionReceipt', ['0x1']), body('eth_blockNumber', ['latest']),
      body('eth_call', [tx]), body('eth_call', [{ ...tx, stateOverride: {} }, 'latest']),
      body('eth_call', [tx, 'latest', {}, {}]), body('eth_call', [{ ...tx, gas: '0x4c4b41' }, 'latest']),
      body('eth_call', [{ ...tx, data: `0x${'00'.repeat(4097)}` }, 'latest']),
      body('eth_estimateGas', [tx, 'latest', {}]), body('eth_feeHistory', ['0x401', 'latest', []]),
      body('eth_feeHistory', ['0x4', 'latest', [90, 10]]), body('eth_feeHistory', ['0x4', 'latest', [101]]),
    ];
    for (const payload of invalid) {
      const response = await f.call(payload, { 'content-type': 'application/json' }, '127.0.0.2');
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('sample-bearer');
    }
    const oversized = await f.call(body('eth_call', [{ ...tx, data: '0'.repeat(RPC_BODY_LIMIT) }, 'latest']), {}, '127.0.0.2');
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.message).toBe('Invalid request');
    expect(f.send.mock.calls.length).toBe(before);
  });
  it('returns only a fixed error when both providers fail, including secret-bearing causes', async () => {
    f.send.mockRejectedValueOnce(new Error('sample-provider-secret Authorization: Bearer sample-bearer'))
      .mockRejectedValueOnce(new Error('sample-provider-secret Cookie: eko_sid=sample-session'));
    const response = await f.call(body());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Read RPC unavailable' } });
    expect(response.body + f.logs.join('')).not.toMatch(/sample-provider-secret|sample-bearer|sample-session/);
  });
  it('refuses a mismatched provider chain', async () => {
    f.send.mockResolvedValueOnce('0x1');
    expect((await f.call(body('eth_chainId'))).statusCode).toBe(503);
  });
  it('caps at 120/min per IP regardless of cookies, across all methods and malformed batches', async () => {
    const limited = await fixture();
    try {
      for (let i = 0; i < 120; i++) {
        const method = READ_RPC_METHODS[i % READ_RPC_METHODS.length]!;
        const response = await limited.call(i % 2 ? body(method, examples[method]) : [body()], { cookie: `eko_sid=sample-session-${i}` });
        expect(response.statusCode).toBe(i % 2 ? 200 : 400);
      }
      const before = limited.send.mock.calls.length;
      const response = await limited.call(body(), { cookie: 'eko_sid=sample-new-session' });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.message).toBe('Rate limit exceeded');
      expect(limited.send.mock.calls.length).toBe(before);
      expect((await limited.call(body(), {}, '127.0.0.2')).statusCode).toBe(200);
    } finally { await limited.close(); }
  });
  it('refuses a testnet client at registration', async () => {
    const app = Fastify();
    try {
      const client = createPublicClient({ chain: robinhoodTestnet, transport: custom({ request: vi.fn() }) });
      await expect(rpcRoutes(app, client)).rejects.toThrow('Read RPC requires chain 4663');
    } finally { await app.close(); }
  });
});

it('registers the mainnet route in buildApp and permits demo read POSTs (offline stub)', async () => {
  const secret = 'sample-demo-placeholder'.repeat(2);
  const built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', DEMO_SECRET: secret }), { startBackground: false });
  const request = vi.spyOn(built.ctx.chains.get('robinhood-mainnet'), 'request').mockResolvedValue('0x1');
  try {
    const response = await built.app.inject({ method: 'POST', url: '/v1/rpc', payload: body(),
      headers: { cookie: `eko_demo=${createDemoToken([], secret)}`, authorization: 'Bearer sample-bearer' } });
    expect(response.statusCode).toBe(200);
    expect(request.mock.lastCall?.[0]).toEqual({ method: 'eth_blockNumber', params: [] });
    expect((await built.ctx.chains.meter.usage()).sessionUnits).toBe(0);
  } finally { request.mockRestore(); await built.close(); }
});
