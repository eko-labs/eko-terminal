import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RpcRequest } from '../src/rpc/routes.js';
import { createSqlUsageStore, type UsageStore } from '../src/rpc/usage.js';
import { openDb } from '@eko/db';
const fake = vi.hoisted(() => ({ http: vi.fn(), ws: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), close: vi.fn() }));
vi.mock('viem', async importOriginal => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual,
    http: (...args: unknown[]) => { fake.http(...args); return () => ({ request: fake.send }); },
    webSocket: (...args: unknown[]) => { fake.ws(...args); return () => ({ request: fake.send, value: {
      getRpcClient: async () => ({ close: fake.close }),
      subscribe: fake.subscribe,
    } }); },
  };
});
import { RpcMeter, defaultPublicRpc, rpcStopReason, type RpcEnv } from '../src/rpc/metered.js';
import { providerErrorClass } from '../src/rpc/outage.js';
import { createMeteredClients } from '../src/rpc/clients.js';
function setup(budget = '10', env: RpcEnv = {}) {
  const rows = new Map<string, { provider: 'paid' | 'public'; method: string; calls: number; units: number }>();
  const store: UsageStore = {
    async reserve(_day, provider, method, units, limit) {
      const total = [...rows.values()].filter(r => r.provider === provider).reduce((s, r) => s + r.units, 0);
      if (total + units > limit) return { allowed: false, total };
      const key = `${provider}:${method}`, row = rows.get(key) ?? { provider, method, calls: 0, units: 0 };
      row.calls++; row.units += units; rows.set(key, row); return { allowed: true, total: total + units };
    }, today: async () => [...rows.values()],
  };
  let now = Date.UTC(2026, 9, 1);
  const exit = vi.fn();
  const meter = new RpcMeter({ RPC_HTTP_URL: `${defaultPublicRpc}?key=sample-query-secret`, RPC_WS_URL: defaultPublicRpc.replace('https:', 'wss:'), RPC_PAID_DAILY_BUDGET: budget, ...env }, {
    store, now: () => now, sleep: async ms => { now += ms; }, log: () => {}, onSessionBudget: exit,
  });
  return { meter, exit, clients: createMeteredClients(meter.env, { meter }) };
}
beforeEach(() => {
  vi.clearAllMocks(); fake.send.mockResolvedValue('0x1'); fake.unsubscribe.mockResolvedValue({ result: true });
  fake.subscribe.mockResolvedValue({ subscriptionId: '0x1', unsubscribe: fake.unsubscribe });
});
describe('viem transport boundary', () => {
  it('accounts each item before HTTP batching and disables hidden retry/deduplication', async () => {
    const { clients, meter } = setup();
    await Promise.all([clients.paid.request({ method: 'eth_blockNumber' }), clients.reads.request({ method: 'eth_blockNumber' }), clients.archive.request({ method: 'eth_blockNumber' })]);
    expect(fake.send).toHaveBeenCalledTimes(3);
    for (const [, config] of fake.http.mock.calls) expect(config).toMatchObject({ retryCount: 0, batch: { batchSize: 100 } });
    for (const [, options] of fake.send.mock.calls) expect(options).toMatchObject({ dedupe: false });
    expect((await meter.usage()).today).toEqual([{ provider: 'paid', method: 'eth_blockNumber', calls: 3, units: 3 }]);
  });
  it('tracks direct socket RPC calls so shutdown closes their connection too', async () => {
    const { clients, meter } = setup();
    await clients.headWs!.request({ method: 'eth_blockNumber' });
    expect((await meter.usage()).sessionUnits).toBe(1);
    await meter.close(); expect(fake.close).toHaveBeenCalled();
  });
  it('meters subscriptions/unsubscriptions and disables hidden reconnect/replay and keepalive', async () => {
    const { clients, meter } = setup();
    const subscription = await clients.headWs!.transport.subscribe({ params: ['newHeads'], onData: () => {} });
    await subscription.unsubscribe();
    expect(fake.ws).toHaveBeenCalledWith(meter.env.RPC_WS_URL, { retryCount: 0, reconnect: false, keepAlive: false });
    expect((await meter.usage()).today).toEqual([
      { provider: 'paid', method: 'eth_subscribe', calls: 1, units: 1 },
      { provider: 'paid', method: 'eth_unsubscribe', calls: 1, units: 1 },
    ]);
    expect(fake.close).toHaveBeenCalled();
  });
  it('closes an existing paid socket at the daily ceiling and can still poll the public head', async () => {
    const { clients, meter } = setup('2');
    const subscription = await clients.headWs!.transport.subscribe({ params: ['newHeads'], onData: () => {} });
    await clients.paid.request({ method: 'eth_blockNumber' });
    expect(fake.close).toHaveBeenCalled();
    await expect(clients.headWs!.transport.subscribe({ params: ['newHeads'], onData: () => {} })).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
    await subscription.unsubscribe(); expect(fake.unsubscribe).not.toHaveBeenCalled();
    await clients.paid.request({ method: 'eth_blockNumber' });
    expect((await meter.usage()).today.find(r => r.provider === 'public')).toMatchObject({ method: 'eth_blockNumber', calls: 1 });
  });
  it('counts every push immediately, applies its weight and closes on the session ceiling', async () => {
    const { clients, meter, exit } = setup('100', { RPC_SESSION_BUDGET: '7', RPC_WEIGHTS: '{"eth_subscription":3}' });
    const onData = vi.fn();
    await clients.headWs!.transport.subscribe({ params: ['newHeads'], onData });
    const push = fake.subscribe.mock.calls[0][0].onData;
    push({ result: { number: '0x1' } }); push({ result: { number: '0x2' } });
    expect(onData).toHaveBeenCalledTimes(2); expect(meter.isStopped).toBe(true);
    expect(meter.stopReason).toBe('rpc_session_budget_reached'); expect(exit).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalled();
    const usage = await meter.usage(); expect(usage.sessionUnits).toBe(7);
    expect(usage.today.find(r => r.method === 'eth_subscription')).toEqual({ provider: 'paid', method: 'eth_subscription', calls: 2, units: 6 });
    expect(rpcStopReason(await clients.paid.request({ method: 'eth_blockNumber' }).catch((error: unknown) => error))).toBe('rpc_session_budget_reached');
    await meter.close();
  });
  it('records already billed pushes that cross the daily limit, without suppressing delivery', async () => {
    const { clients, meter } = setup('4', { RPC_WEIGHTS: '{"eth_subscription":2}' });
    const onData = vi.fn();
    await clients.headWs!.transport.subscribe({ params: ['newHeads'], onData });
    const push = fake.subscribe.mock.calls[0][0].onData;
    push({ result: { number: '0x1' } }); push({ result: { number: '0x2' } });
    expect(onData).toHaveBeenCalledTimes(2); expect(fake.close).toHaveBeenCalled();
    const usage = await meter.usage(); expect(usage.paidOpen).toBe(false); expect(usage.budgetLeft).toBe(0);
    expect(usage.today.find(r => r.method === 'eth_subscription')).toMatchObject({ calls: 2, units: 4 });
    expect(usage.sessionUnits).toBe(5);
    expect(rpcStopReason(await clients.archive.request({ method: 'eth_call', params: [{}, '0x1'] } as never).catch((error: unknown) => error))).toBe('rpc_budget_exhausted');
    await meter.close();
  });
  it('delivers pushes while accounting is pending, and flushes their default weight on shutdown', async () => {
    const { clients, meter } = setup();
    const onData = vi.fn();
    await clients.headWs!.transport.subscribe({ params: ['newHeads'], onData });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reserve = meter.store.reserve.bind(meter.store);
    vi.spyOn(meter.store, 'reserve').mockImplementation(async (...args) => { await gate; return reserve(...args); });
    fake.subscribe.mock.calls[0][0].onData({ result: { number: '0x1' } });
    expect(onData).toHaveBeenCalledOnce();
    let closed = false; const close = meter.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await close;
    expect((await meter.usage()).today.find(r => r.method === 'eth_subscription')).toMatchObject({ calls: 1, units: 1 });
  });
  it('leases SQL push units ahead of exhaustion and flushes all delivered pushes on exit',async()=>{
    const db=await openDb({pgliteDir:':memory:'}),store=createSqlUsageStore(db),lease=vi.spyOn(store,'lease'),tx=vi.spyOn(db,'tx');
    let now=0;
    const meter=new RpcMeter({RPC_HTTP_URL:'https://paid.invalid',RPC_WS_URL:'wss://paid.invalid',RPC_PAID_DAILY_BUDGET:'1000'},{store,now:()=>now,sleep:async ms=>{now+=ms;},log:()=>{}});
    try{
      const clients=createMeteredClients(meter.env,{meter}),onData=vi.fn();
      await clients.headWs!.transport.subscribe({params:['newHeads'],onData});
      const push=fake.subscribe.mock.calls[0][0].onData;
      for(let batch=0;batch<4;batch++){for(let n=0;n<50;n++)push({result:{number:'0x1'}});await meter.usage();}
      expect(onData).toHaveBeenCalledTimes(200);expect(fake.close).not.toHaveBeenCalled();
      expect(tx).not.toHaveBeenCalled();expect(lease.mock.calls.length).toBeLessThan(8);
      await meter.close();
      expect((await store.today('1970-01-01')).find(r=>r.method==='eth_subscription')).toMatchObject({calls:200,units:200});
      expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:201}]);
    }finally{await meter.close();await db.close();}
  });
  it('sanitizes websocket callback and rejection errors without preserving viem causes', async () => {
    const { clients, meter } = setup();
    const onError = vi.fn();
    fake.subscribe.mockImplementationOnce(async (input: { onError: (e: unknown) => void }) => {
      const error = new Error(`failed ${meter.env.RPC_HTTP_URL}\nRequest body: sample-body-secret`);
      input.onError(error); throw error;
    });
    let caught: unknown;
    try { await clients.headWs!.transport.subscribe({ params: ['newHeads'], onData: () => {}, onError }); } catch (e) { caught = e; }
    expect(onError).toHaveBeenCalledOnce();
    for (const e of [caught, onError.mock.calls[0][0]]) {
      expect(String(e)).not.toContain(defaultPublicRpc); expect(String(e)).not.toContain('sample-query-secret'); expect(String(e)).not.toContain('sample-body-secret');
      expect((e as Error).cause).toBeUndefined();
    }
    await meter.close();
  });
});


it('publishes asynchronous socket balance refusals without refunding an accepted subscription',async()=>{
  const db=await openDb({pgliteDir:':memory:'});
  const meter=new RpcMeter({APP_ROLE:'worker',RPC_HTTP_URL:'https://paid.invalid',RPC_WS_URL:'wss://paid.invalid'},
    {store:createSqlUsageStore(db),log:vi.fn()});
  try {
    const clients=createMeteredClients(meter.env,{meter}),onError=vi.fn();
    await clients.headWs!.transport.subscribe({params:['newHeads'],onData:vi.fn(),onError});
    fake.subscribe.mock.calls[0][0].onError(Object.assign(new Error('payment required'),{status:402}));
    const usage=await meter.usage();
    expect(usage).toMatchObject({paidCalls:1,refusedToday:1});
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({code:'provider_balance_exceeded'}));
    expect(meter.pause?.reason).toBe('provider_balance_exceeded');expect(fake.close).toHaveBeenCalled();
    const error=await clients.paid.request({method:'eth_call',params:[{}]} as never).catch(error=>error);
    expect(providerErrorClass(error)).toBe('provider_balance_exceeded');
    expect(fake.send).not.toHaveBeenCalled();
  }finally{await meter.close();await db.close();}
});
