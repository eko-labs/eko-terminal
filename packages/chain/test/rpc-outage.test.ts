import { afterEach, expect, it, vi } from 'vitest';
import { RpcGuardError, RpcMeter, isTransientRpcUnavailable, rpcStopReason } from '../src/rpc/metered.js';
import { providerErrorClass } from '../src/rpc/outage.js';
import { withRpcOrigin } from '../src/rpc/origin.js';
import { ProgressWatchdog } from '../src/watchdog.js';
import type { RpcRequest } from '../src/rpc/routes.js';
afterEach(() => vi.useRealTimers());
const store = () => ({ reserve: vi.fn(async () => ({ allowed: true, total: 1 })), today: async () => [] });

it.each([
  [new Error('An unknown RPC error occurred. | RPC Request failed. | User balance exceeded'), 'provider_balance_exceeded'],
  [Object.assign(new Error('payment'), { status: 402 }), 'provider_balance_exceeded'],
  [new Error('monthly quota exceeded'), 'provider_quota_exceeded'],
  [Object.assign(new Error('limit'), { status: 429 }), 'provider_quota_exceeded'],
] as const)('exposes provider refusal separately from local budgets: %s', async (failure, reason) => {
  const meter = new RpcMeter({ RPC_HTTP_URL: 'https://paid.invalid' }, { store: store(), log: vi.fn() });
  const fail = async () => { throw failure; };
  const error = await meter.request({ method: 'eth_call' }, { paid: fail, public: fail }, 'archive').catch(e => e);
  const wrapped = new Error('wrapped', { cause: error });
  expect(providerErrorClass(wrapped)).toBe(reason);
  expect(isTransientRpcUnavailable(wrapped)).toBe(true);
  expect(rpcStopReason(wrapped)).toBeUndefined();
  expect(rpcStopReason(new RpcGuardError('rpc_budget_exhausted'))).toBe('rpc_budget_exhausted');
  await meter.close();
});

it('holds concurrent work and warm state, probes once with capped exponential backoff, logs each minute, then resumes', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let available = false;
  const log = vi.fn(), changed = vi.fn(), state = new Map([['warm', 42]]), saved = store();
  const meter = new RpcMeter({ RPC_HTTP_URL: 'https://paid.invalid', RPC_OUTAGE_MAX_BACKOFF_SEC: '40' }, { store: saved, pauseOnOutage: true, onPauseChange: changed, log });
  const calls: { method: string; at: number }[] = [];
  const paid = vi.fn(async (r: RpcRequest) => { calls.push({ method: r.method, at: Date.now() }); if (!available) throw new Error('User balance exceeded'); return r.method === 'eth_blockNumber' ? '0x20' : 'result'; });
  const send = { paid, public: vi.fn(paid) };
  let completed = false;
  const work = meter.request({ method: 'eth_getCode' }, send, 'archive').then(() => { state.set('completed', state.get('warm')!); completed = true; });
  await vi.advanceTimersByTimeAsync(1);
  const others = Array.from({ length: 8 }, () => meter.request({ method: 'eth_call' }, send, 'archive'));
  expect(meter.pause).toMatchObject({ state: 'PAUSED', reason: 'provider_balance_exceeded', nextRetryAt: 10_000 });
  await vi.advanceTimersByTimeAsync(129_999);
  expect(completed).toBe(false); expect(state.size).toBe(1);
  expect(calls).toEqual([{ method: 'eth_getCode', at: 0 }, ...[10_000, 30_000, 70_000, 110_000].map(at => ({ method: 'eth_blockNumber', at }))]);
  expect(log.mock.calls.filter(([event]) => event === 'rpc_paused').map(([, fields]) => fields.nextRetryAt)).toEqual([10_000, 70_000, 150_000]);
  available = true;
  await vi.advanceTimersByTimeAsync(21_000); await work; await Promise.all(others);
  expect(state.get('completed')).toBe(42); expect(meter.pause).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null); expect(log.mock.calls.filter(([event]) => event === 'rpc_resumed')).toHaveLength(1);
  expect(saved.reserve).toHaveBeenCalledTimes(calls.length);
  await meter.close();
});

it.each([new RpcGuardError('rpc_unavailable', 'RPC usage persistence unavailable'), Object.assign(new Error('invalid credentials'), { status: 401 })])('does not pause configuration or database failures', async failure => {
  const meter = new RpcMeter({ RPC_HTTP_URL: 'https://paid.invalid' }, { store: store(), pauseOnOutage: true, log: vi.fn() });
  const fail = async () => { throw failure; };
  await expect(meter.request({ method: 'eth_call' }, { paid: fail, public: fail }, 'archive')).rejects.toBeDefined();
  expect(meter.pause).toBeNull(); await meter.close();
});

it('interrupts a paused role promptly on shutdown', async () => {
  vi.useFakeTimers();
  const meter = new RpcMeter({ RPC_HTTP_URL: 'https://paid.invalid' }, { store: store(), pauseOnOutage: true, log: vi.fn() });
  const fail = async () => { throw new Error('fetch failed'); };
  const pending = meter.request({ method: 'eth_call' }, { paid: fail, public: fail }, 'archive');
  const check = expect(pending).rejects.toMatchObject({ code: 'shutdown_requested' });
  await vi.advanceTimersByTimeAsync(1); await meter.close(); await check;
  expect(meter.pause).toBeNull();
});

it('suppresses watchdog exits and independent probes while paused, then gives resumed work a fresh stall window', () => {
  let now = 0, paused = true;
  const exit = vi.fn(), probe = vi.fn(async () => 1n);
  const watchdog = new ProgressWatchdog({ role: 'indexer', stallMs: 1000, trackHead: true, paused: () => paused, now: () => now, exit, probe, log: vi.fn() });
  watchdog.progress(0n); watchdog.observeHead(1n);
  now = 1_000_000; watchdog.check(); expect(exit).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  paused = false; watchdog.check(); expect(exit).not.toHaveBeenCalled();
  now += 1000; watchdog.check(); expect(exit).toHaveBeenCalledWith(1);
});

it('does not dispatch an admitted request if another in-flight call pauses the provider during ledger admission', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let admitSecond!: () => void, failFirst!: (error: Error) => void, reservations = 0, available = false;
  const saved = store();
  saved.reserve.mockImplementation(async () => {
    if (++reservations === 2) await new Promise<void>(resolve => { admitSecond = resolve; });
    return {allowed:true,total:reservations};
  });
  const meter = new RpcMeter({RPC_HTTP_URL:'https://paid.invalid'}, {store:saved,pauseOnOutage:true,log:vi.fn()});
  const paid = vi.fn(async (r: RpcRequest): Promise<string> => {
    if (!available) return new Promise((_resolve,reject) => { failFirst = reject; });
    return r.method === 'eth_blockNumber' ? '0x2' : 'result';
  });
  const send = {paid,public:paid};
  const first = meter.request({method:'eth_getCode'},send,'archive');
  const second = meter.request({method:'eth_call'},send,'archive');
  await vi.advanceTimersByTimeAsync(50);
  expect(reservations).toBe(2);expect(paid).toHaveBeenCalledTimes(1);
  failFirst(new Error('User balance exceeded'));await vi.advanceTimersByTimeAsync(0);
  expect(meter.pause?.state).toBe('PAUSED');
  admitSecond();await vi.advanceTimersByTimeAsync(0);
  expect(paid).toHaveBeenCalledTimes(1);
  available=true;await vi.advanceTimersByTimeAsync(11_000);
  await expect(Promise.all([first,second])).resolves.toEqual(['result','result']);
  await meter.close();
});

it('keeps urgent work and origin accounting available when the ceiling defers an outage recovery probe', async () => {
  let now=0, total=0, available=false, releaseRecovery!:()=>void;
  const log=vi.fn(), changed=vi.fn();
  const saved={...store(),paidPolicy:vi.fn(async (_day:string,policy:{urgent:boolean},consume:boolean)=>{
    const allowed=total<1 || policy.urgent;
    if(allowed && consume)total++;
    return {allowed,degraded:total>=1,total,nonIndexer:total};
  })};
  const meter=new RpcMeter({APP_ROLE:'engines',RPC_HTTP_URL:'https://paid.invalid',RPC_PAID_DAILY_SOFT_LIMIT:'1'},
    {store:saved,pauseOnOutage:true,onPauseChange:changed,log,now:()=>now,sleep:async ms=>{
      now+=ms;if(ms>=10_000)await new Promise<void>(resolve=>{releaseRecovery=resolve;});
    }});
  const paid=vi.fn(async()=>{if(!available)throw new Error('User balance exceeded');return 'result';});
  const send={paid,public:paid};
  try {
    await expect(withRpcOrigin('test.routine',()=>meter.request({method:'eth_call'},send,'archive',false)))
      .rejects.toMatchObject({code:'provider_balance_exceeded'});
    expect(meter.pause?.reason).toBe('provider_balance_exceeded');
    releaseRecovery();await vi.waitFor(()=>expect(meter.pause).toBeNull());
    expect(changed).toHaveBeenLastCalledWith(null);
    available=true;
    await expect(withRpcOrigin('test.first_rating',()=>meter.request({method:'eth_call'},send,'archive'),'first_rating')).resolves.toBe('result');
    await expect(withRpcOrigin('test.routine',()=>meter.request({method:'eth_call'},send,'archive'))).rejects.toMatchObject({code:'rpc_paid_deferred'});
    expect(meter.pause).toBeNull();expect(paid).toHaveBeenCalledTimes(2);expect(total).toBe(2);
    await meter.summary();
    expect(log.mock.calls.find(([event])=>event==='rpc_usage')?.[1].lastMinute).toEqual([
      {provider:'paid',method:'eth_call',origin:'test.routine',calls:1,units:1},
      {provider:'paid',method:'eth_call',origin:'test.first_rating',calls:1,units:1},
    ]);
  } finally {await meter.close();}
});
