import { describe, expect, it, vi } from 'vitest';
import { RpcMeter, rpcConfig, type MeterOptions, type RpcEnv } from '../src/rpc/metered.js';
import { isTransientRpcError } from '../src/rpc/transient.js';
import type { RpcRequest } from '../src/rpc/routes.js';
const failures = [
  ['GOAWAY', new Error('HTTP request failed', { cause: new Error('HTTP/2: GOAWAY frame received with code 0') })],
  ['reset', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })],
  ['timeout', Object.assign(new Error('request timed out'), { name: 'TimeoutError' })],
  ['5xx', Object.assign(new Error('service unavailable'), { status: 503 })],
  ['non-JSON', new SyntaxError('Unexpected token < in JSON at position 0')],
] as const;
function harness(options: MeterOptions = {}, env: RpcEnv = {}) {
  let now = 0, paidUnits = 0;
  const rows: { provider: string; method: string; units: number }[] = [];
  const log = vi.fn(), sleeps: number[] = [], onSessionBudget = vi.fn();
  const meter = new RpcMeter({ RPC_HTTP_URL: 'https://paid.invalid', ...env }, {
    transientRetrySec: 300, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, random: () => .25, log, onSessionBudget,
    store: { reserve: async (_day,provider,method,units,limit) => {
      if (provider === 'paid' && paidUnits+units > limit) return {allowed:false,total:paidUnits};
      if (provider === 'paid') paidUnits += units;
      rows.push({provider,method,units});return {allowed:true,total:paidUnits};
    }, today: async () => [] }, ...options,
  });
  const send = { public: vi.fn(async (_r: RpcRequest): Promise<unknown> => 'public'), paid: vi.fn(async (_r: RpcRequest): Promise<unknown> => 'paid') };
  return {meter,send,log,sleeps,rows,onSessionBudget,time:()=>now,advance:(ms:number)=>{now+=ms;}};
}
describe('bounded indexer transport retries', () => {
  it.each(failures)('retries %s on the other provider, preserves the exact request, and counts every attempt', async (_kind,error) => {
    const h=harness(),request={method:'eth_getBlockReceipts',params:['0x123']} as const;
    h.send.public.mockRejectedValueOnce(error);h.send.paid.mockRejectedValueOnce(error);
    expect(await h.meter.request(request,h.send,'head')).toBe('public');
    expect(h.send.public).toHaveBeenCalledTimes(2);expect(h.send.paid).toHaveBeenCalledExactlyOnceWith(request);
    expect(h.send.public.mock.calls.every(([r])=>r===request)).toBe(true);
    expect(h.rows).toHaveLength(3);expect(h.sleeps).toContain(312.5);
    await h.meter.close();
  });
  it('reads parent headers on public and goes to paid only when public fails, never waiting out a public rate limit',async()=>{
    const h=harness(),request={method:'eth_getBlockByNumber',params:['0x123',false]} as const;
    expect(await h.meter.request(request,h.send,'parent')).toBe('public');expect(h.send.paid).not.toHaveBeenCalled();
    h.send.public.mockRejectedValueOnce(failures[0][1]);
    expect(await h.meter.request(request,h.send,'parent')).toBe('paid');
    h.send.public.mockRejectedValueOnce(new Error('rate limit hit, reset in 60 seconds'));
    expect(await h.meter.request(request,h.send,'parent')).toBe('paid');
    expect(h.sleeps.filter(ms=>ms>=60_000)).toHaveLength(0);expect(h.send.paid).toHaveBeenCalledTimes(2);
    // The public-only lane keeps retrying public instead.
    h.send.public.mockRejectedValueOnce(failures[0][1]);
    expect(await h.meter.request(request,h.send,'public')).toBe('public');expect(h.send.paid).toHaveBeenCalledTimes(2);
    await h.meter.close();
  });
  it('tries paid after a slow public failure even if the public token has replenished',async()=>{
    const h=harness();h.send.public.mockImplementationOnce(async()=>{h.advance(500);throw failures[0][1];});
    expect(await h.meter.request({method:'eth_getBlockReceipts'},h.send,'head')).toBe('paid');
    expect(h.send.public).toHaveBeenCalledOnce();expect(h.send.paid).toHaveBeenCalledOnce();await h.meter.close();
  });
  it('backs off exponentially with jitter and stops at the configured window', async () => {
    const h=harness();h.send.public.mockRejectedValue(failures[0][1]);h.send.paid.mockRejectedValue(failures[0][1]);
    await expect(h.meter.request({method:'eth_getBlockReceipts',params:['0x123']},h.send,'head')).rejects.toMatchObject({code:'rpc_unavailable'});
    expect(h.time()).toBe(300000);
    const backoffs=h.log.mock.calls.filter(([event])=>event==='rpc_transient_retry').map(([,fields])=>fields.backoff_ms);
    expect(backoffs.slice(0,4)).toEqual([312.5,625,1250,2500]);expect(Math.max(...backoffs)).toBe(18750);
    expect(h.onSessionBudget).not.toHaveBeenCalled();await h.meter.close();
  });
  it('uses a shorter configured window for archive-only reads without touching public', async () => {
    const h=harness({transientRetrySec:1});h.send.paid.mockRejectedValue(failures[3][1]);
    await expect(h.meter.request({method:'eth_call',params:[{},'0x123']},h.send,'archive')).rejects.toMatchObject({code:'rpc_unavailable'});
    expect(h.time()).toBe(1000);expect(h.send.public).not.toHaveBeenCalled();await h.meter.close();
  });
  it.each([400,401,403])('does not retry permanent HTTP %s errors after the existing single fallback', async status => {
    const h=harness(),error=Object.assign(new Error('HTTP request failed'),{status});
    expect(isTransientRpcError(error)).toBe(false);h.send.public.mockRejectedValue(error);h.send.paid.mockRejectedValue(error);
    await expect(h.meter.request({method:'eth_getLogs'},h.send,'head')).rejects.toMatchObject({code:'rpc_unavailable'});
    expect(h.rows).toHaveLength(2);expect(h.log).not.toHaveBeenCalledWith('rpc_transient_retry',expect.anything());await h.meter.close();
  });
  it('leaves result-size and invalid-parameter errors to the existing caller', () => {
    expect(isTransientRpcError(new Error('query returned more than 10000 results'))).toBe(false);
    expect(isTransientRpcError(new Error('invalid params'))).toBe(false);
    // viem wraps an oversized reply as "HTTP request failed"; retrying the same range only repeats it, so the caller narrows it.
    const tooLarge = Object.assign(new Error('HTTP response body exceeded the size limit.'), { name: 'ResponseBodyTooLargeError' });
    expect(isTransientRpcError(new Error('HTTP request failed.', { cause: tooLarge }))).toBe(false);
  });
  it('preserves session and daily budget stops during retries', async () => {
    const session=harness({}, {RPC_SESSION_BUDGET:'2'});session.send.public.mockRejectedValue(failures[0][1]);session.send.paid.mockRejectedValue(failures[0][1]);
    await expect(session.meter.request({method:'eth_getLogs'},session.send,'head')).rejects.toMatchObject({code:'rpc_session_budget_reached'});
    expect(session.rows).toHaveLength(2);expect(session.onSessionBudget).toHaveBeenCalledOnce();await session.meter.close();
    const daily=harness({}, {RPC_PAID_DAILY_BUDGET:'0'});daily.send.public.mockRejectedValue(failures[0][1]);
    await expect(daily.meter.request({method:'eth_getLogs'},daily.send,'head')).rejects.toMatchObject({code:'rpc_budget_exhausted'});
    expect(daily.send.paid).not.toHaveBeenCalled();await daily.meter.close();
  });
  it('interrupts backoff on shutdown without another attempt', async () => {
    let started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;});
    const h=harness({sleep:async()=>{started();await new Promise(()=>{});}});h.send.paid.mockRejectedValue(failures[0][1]);
    const pending=h.meter.request({method:'eth_call',params:[{},'0x123']},h.send,'archive');
    const rejected=expect(pending).rejects.toMatchObject({code:'shutdown_requested'});
    await waiting;await h.meter.close();await rejected;expect(h.send.paid).toHaveBeenCalledTimes(1);
  });
});
describe('live public capacity spill-over', () => {
  it('defaults to the measured public cap and the increased paid cap', () => {
    expect(rpcConfig({})).toMatchObject({paidRpm:1200,publicRpm:300,dailyBudget:800000,softLimit:500000,indexerReserve:300000});
  });
  it.each(['eth_getBlockReceipts','eth_getLogs','eth_blockNumber'])('reserves nearby public slots for %s before spilling overflow', async method => {
    const h=harness();
    const result=await Promise.all(Array.from({length:4},()=>h.meter.request({method},h.send,'head')));
    expect(result).toEqual(['public','public','public','paid']);expect(h.sleeps).toEqual([200,200]);
    h.advance(200);expect(await h.meter.request({method},h.send,'head')).toBe('public');await h.meter.close();
  });
  it('rechecks queued paid spills when a public token replenishes, without charging the paid lane',async()=>{
    const h=harness();
    await Promise.all(Array.from({length:12},()=>h.meter.request({method:'eth_getBlockReceipts'},h.send,'head')));
    expect(h.send.public.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.rows.filter(r=>r.provider==='public').length).toBe(h.send.public.mock.calls.length);
    expect(h.rows.filter(r=>r.provider==='paid').length).toBe(h.send.paid.mock.calls.length);
    expect(h.rows).toHaveLength(12);await h.meter.close();
  });
  it('fills five public slots per second while eligible work is queued alongside paid-only reads',async()=>{
    vi.useFakeTimers();
    const trace:{provider:string;at:number}[]=[];
    const h=harness({now:Date.now,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
    const send={public:async()=>{trace.push({provider:'public',at:Date.now()});return 'public';},paid:async()=>{trace.push({provider:'paid',at:Date.now()});return 'paid';}};
    try {
      const work=Promise.all([...Array.from({length:40},()=>h.meter.request({method:'eth_getCode',params:['0x0','0x1']},send,'archive')), ...Array.from({length:200},()=>h.meter.request({method:'eth_getBlockReceipts'},send,'head'))]);
      await vi.runAllTimersAsync();await work;
      const publicCalls=trace.filter(r=>r.provider==='public');
      expect(publicCalls.length).toBeGreaterThanOrEqual(40);
      for(let i=1;i<publicCalls.length;i++)expect(publicCalls[i].at-publicCalls[i-1].at).toBe(200);
      const paidCalls=trace.filter(r=>r.provider==='paid');for(let i=1;i<paidCalls.length;i++)expect(paidCalls[i].at-paidCalls[i-1].at).toBeGreaterThanOrEqual(50);
      await h.meter.close();
    } finally {vi.useRealTimers();}
  });
  it('queues within public capacity when the paid budget is closed', async () => {
    const h=harness({}, {RPC_PAID_DAILY_BUDGET:'0'});
    expect(await Promise.all(Array.from({length:3},()=>h.meter.request({method:'eth_getBlockReceipts'},h.send,'head')))).toEqual(['public','public','public']);
    expect(h.sleeps).toEqual([200,200]);expect(h.send.paid).not.toHaveBeenCalled();await h.meter.close();
  });
});
