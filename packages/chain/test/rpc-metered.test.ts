import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@eko/db';
import { RpcMeter, defaultPublicRpc, rpcConfig, RpcGuardError, type RpcEnv } from '../src/rpc/metered.js';
import { createSqlUsageStore, type UsageStore } from '../src/rpc/usage.js';
import { archiveOnly, routeRequest, type RpcRequest } from '../src/rpc/routes.js';
import { safeError } from '../src/rpc/safe-error.js';
import { createMeteredClients } from '../src/rpc/clients.js';
function harness(env: RpcEnv = {}, store?: UsageStore) {
  let time = Date.UTC(2026, 9, 1);
  const usage = new Map<string, { provider: 'paid' | 'public'; method: string; calls: number; units: number }>();
  const totals = new Map<string, number>();
  const memory: UsageStore = {
    async reserve(day, provider, method, units, limit) {
      const key = `${day}:${provider}`, total = totals.get(key) ?? 0;
      if (total + units > limit) return { allowed: false, total };
      totals.set(key, total + units);
      const detail = `${key}:${method}`, row = usage.get(detail) ?? { provider, method, calls: 0, units: 0 };
      row.calls++; row.units += units; usage.set(detail, row);
      return { allowed: true, total: total + units };
    },
    async today(day) { return [...usage.entries()].filter(([key]) => key.startsWith(day)).map(([, r]) => ({ ...r })); },
  };
  const lines: string[] = [], exit = vi.fn(), sleeps: number[] = [];
  const meter = new RpcMeter({ RPC_HTTP_URL: defaultPublicRpc, ...env }, {
    store: store ?? memory, now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, random: () => .25,
    log: (event, fields) => lines.push(JSON.stringify({ event, ...fields })), onSessionBudget: exit,
  });
  const send = { paid: vi.fn(async (_r: RpcRequest): Promise<unknown> => 'paid'), public: vi.fn(async (_r: RpcRequest): Promise<unknown> => 'public') };
  return { meter, send, lines, exit, sleeps, now:()=>time, advance: (ms: number) => { time += ms; }, store: store ?? memory };
}
afterEach(() => vi.useRealTimers());
describe('RPC admission and routing', () => {
  it('counts every batch item and applies method weights', async () => {
    const h = harness({ RPC_WEIGHTS: '{"eth_getBlockByNumber":5}' });
    expect(await h.meter.request([{ method: 'eth_blockNumber' }, { method: 'eth_getBlockByNumber' }, { method: 'eth_blockNumber' }], h.send)).toEqual(['paid', 'paid', 'paid']);
    expect((await h.meter.usage()).today).toEqual([{ provider: 'paid', method: 'eth_blockNumber', calls: 2, units: 2 }, { provider: 'paid', method: 'eth_getBlockByNumber', calls: 1, units: 5 }]);
  });
  it('spaces concurrent calls at both provider caps with no initial burst', async () => {
    const h = harness({ RPC_PAID_MAX_RPM: '60', RPC_PUBLIC_MAX_RPM: '30' });
    await h.meter.request([{ method: 'eth_blockNumber' }, { method: 'eth_blockNumber' }, { method: 'eth_blockNumber' }], h.send);
    expect(h.sleeps).toEqual([1000, 1000]);
    await h.meter.request([{ method: 'eth_getLogs' }, { method: 'eth_getLogs' }], h.send, 'backfill');
    expect(h.sleeps).toEqual([1000, 1000, 2000]);
  });
  it.each([['paid','default',50],['public','public',200]] as const)('does not burst %s dispatches after a slow usage reservation',async(provider,context,spacing)=>{
    const h=harness(),reserve=h.store.reserve;let first=true;
    h.store.reserve=async(...args)=>{if(first){first=false;h.advance(500);}return reserve(...args);};
    const meter=new RpcMeter({RPC_HTTP_URL:defaultPublicRpc},{store:h.store,now:h.now,sleep:async ms=>{await new Promise<void>(resolve=>setImmediate(resolve));h.advance(ms);},log:()=>{}});
    const began=h.now(),attempts:number[]=[];
    h.send[provider].mockImplementation(async()=>{attempts.push(h.now()-began);return provider;});
    await Promise.all(Array.from({length:3},()=>meter.request({method:'eth_blockNumber'},h.send,context)));
    expect(attempts).toEqual([500,500+spacing,500+2*spacing]);
    expect((await meter.usage()).today).toEqual([{provider,method:'eth_blockNumber',calls:3,units:3}]);
  });
  it('routes historical scans to public, head blocks to paid and numbered state reads to archive', async () => {
    const h = harness();
    expect(await h.meter.request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x10' }] }, h.send, 'backfill')).toBe('public');
    expect(routeRequest({ method: 'eth_getBlockReceipts' })).toBe('paid');
    expect(routeRequest({ method: 'eth_subscribe', params: ['newHeads'] })).toBe('paid');
    for (const [method, params] of [['eth_call', [{}, '0x1']], ['eth_getCode', ['0x', '0x1']], ['eth_getStorageAt', ['0x', '0x0', '0x1']]] as const) {
      expect(archiveOnly({ method, params })).toBe(true);
    }
    expect(archiveOnly({ method: 'eth_call', params: [{}, 'latest'] })).toBe(false);
  });
  it('routes live head/logs public first, falls back immediately on rate limits, and leaves hash/code paid', async () => {
    const h = harness();
    for (const method of ['eth_blockNumber', 'eth_getLogs', 'eth_getBlockReceipts']) {
      h.advance(200);
      expect(routeRequest({ method }, 'head')).toBe('public');
      h.send.public.mockRejectedValueOnce(new Error('Rate Limit Hit, limit will reset in 60 seconds'));
      expect(await h.meter.request({ method }, h.send, 'head')).toBe('paid');
    }
    expect(h.sleeps).not.toContain(60250);
    for (const method of ['eth_getBlockByNumber', 'eth_getCode']) expect(routeRequest({ method }, 'head')).toBe('paid');
    expect(h.send.public).toHaveBeenCalledTimes(3); expect(h.send.paid).toHaveBeenCalledTimes(3);
    const closed = harness({ RPC_PAID_DAILY_BUDGET: '0' });
    closed.send.public.mockRejectedValue(new Error('public unavailable'));
    await expect(closed.meter.request({ method: 'eth_getLogs' }, closed.send, 'head')).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
    expect(closed.send.paid).not.toHaveBeenCalled();
  });
  it('uses spare public capacity for supplemental timestamps and queues the rest across capped lanes', async () => {
    const h = harness();
    expect(await h.meter.request({method:'eth_getBlockByNumber'},h.send,'head_timestamp')).toBe('public');
    expect(await h.meter.request({method:'eth_getBlockByNumber'},h.send,'head_timestamp')).toBe('public');
    expect(await h.meter.request({method:'eth_getBlockByNumber'},h.send,'head')).toBe('paid');
    expect(h.sleeps).toEqual([200]);
    await Promise.all(Array.from({length:20},()=>h.meter.request({method:'eth_getBlockByNumber'},h.send,'head_timestamp')));
    const rows=(await h.meter.usage()).today;
    expect(rows.reduce((n,r)=>n+r.calls,0)).toBe(23);
    expect(h.send.public.mock.calls.length).toBeGreaterThan(1);
    expect(h.send.paid.mock.calls.length).toBeGreaterThan(2);
  });
  it('warns once at 80%, closes at 100%, reroutes supported calls and fails archive/debug without I/O', async () => {
    const h = harness({ RPC_PAID_DAILY_BUDGET: '5' });
    for (let i = 0; i < 5; i++) await h.meter.request({ method: 'eth_blockNumber' }, h.send);
    expect((await h.meter.usage()).paidOpen).toBe(false);
    expect(await h.meter.request({ method: 'eth_blockNumber' }, h.send)).toBe('public');
    const calls = h.send.paid.mock.calls.length + h.send.public.mock.calls.length;
    for (const r of [{ method: 'debug_traceCall' }, { method: 'trace_call' }, { method: 'eth_call', params: [{}, '0x1'] }, { method: 'eth_getCode', params: ['0x', '0x1'] }, { method: 'eth_getStorageAt', params: ['0x', '0x0', '0x1'] }]) {
      await expect(h.meter.request(r, h.send)).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
    }
    expect(h.send.paid.mock.calls.length + h.send.public.mock.calls.length).toBe(calls);
    expect(h.lines.filter(l => JSON.parse(l).event === 'rpc_budget_warning')).toHaveLength(1);
    expect(h.lines.filter(l => JSON.parse(l).event === 'rpc_budget_exhausted')).toHaveLength(1);
    expect(h.lines.some(l => JSON.parse(l).event === 'alert')).toBe(true);
    h.advance(86400_000);
    expect(await h.meter.request({ method: 'eth_blockNumber' }, h.send)).toBe('paid');
  });
  it('does not overshoot a daily budget with a large weight', async () => {
    const h = harness({ RPC_PAID_DAILY_BUDGET: '4', RPC_WEIGHTS: '{"debug_traceCall":5}' });
    await expect(h.meter.request({ method: 'debug_traceCall' }, h.send)).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
    expect(h.send.paid).not.toHaveBeenCalled();
    expect((await h.meter.usage()).today).toEqual([]);
  });
  it('stops and signals a clean exit at the session budget exactly once, also on an oversize call', async () => {
    const h = harness({ RPC_SESSION_BUDGET: '2' });
    await h.meter.request({ method: 'eth_blockNumber' }, h.send);
    await h.meter.request({ method: 'eth_blockNumber' }, h.send);
    await expect(h.meter.request({ method: 'eth_blockNumber' }, h.send)).rejects.toMatchObject({ code: 'rpc_session_budget_reached' });
    expect(h.exit).toHaveBeenCalledTimes(1); expect(h.send.paid).toHaveBeenCalledTimes(2);
    expect(h.lines.filter(l => JSON.parse(l).event === 'rpc_session_budget_reached')).toHaveLength(1);
    const over = harness({ RPC_SESSION_BUDGET: '1', RPC_WEIGHTS: '{"debug_traceCall":2}' });
    await expect(over.meter.request({ method: 'debug_traceCall' }, over.send)).rejects.toMatchObject({ code: 'rpc_session_budget_reached' });
    expect(over.exit).toHaveBeenCalledTimes(1); expect(over.send.paid).not.toHaveBeenCalled();
  });
  it.each(['rpc_session_budget_reached','shutdown_requested'] as const)('keeps a pending transport failure after %s classified as a guard stop', async reason => {
    const h = harness();
    h.send.paid.mockImplementation(async () => { h.meter.stop(reason); throw new Error('Connection closed'); });
    await expect(h.meter.request({ method: 'eth_blockNumber' }, h.send)).rejects.toMatchObject({ code: reason });
    expect(h.send.public).not.toHaveBeenCalled();
  });
  it('waits 60 seconds plus jitter and retries the identical public request, charging each attempt', async () => {
    const h = harness();
    h.send.public.mockRejectedValueOnce(new Error('Rate Limit Hit, limit will reset in 60 seconds'));
    const request = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x100' }] };
    expect(await h.meter.request(request, h.send, 'backfill')).toBe('public');
    expect(h.sleeps).toContain(60250);
    expect(h.send.public.mock.calls.map(([r]) => r)).toEqual([request, request]);
    expect(h.send.paid).not.toHaveBeenCalled();
    expect((await h.meter.usage()).today).toEqual([{ provider: 'public', method: 'eth_getLogs', calls: 2, units: 2 }]);
  });
  it('fallback from public consumes paid allowance and cannot bypass a closed paid provider', async () => {
    const h = harness({ RPC_PAID_DAILY_BUDGET: '1' });
    h.send.public.mockRejectedValue(new Error('temporary public failure'));
    expect(await h.meter.request({ method: 'eth_getLogs' }, h.send, 'backfill')).toBe('paid');
    await expect(h.meter.request({ method: 'eth_getLogs' }, h.send, 'backfill')).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
    expect(h.send.paid).toHaveBeenCalledTimes(1);
  });
  it('counts failures, does not retry debug or unknown methods, and strips endpoint keys and bodies', async () => {
    const url = `${defaultPublicRpc}?key=sample-provider-key`;
    const h = harness({ RPC_HTTP_URL: url });
    h.send.paid.mockRejectedValue(new Error(`RPC failed ${url}\nRequest body: {"secret":"sample-body-secret"}`));
    let error: unknown;
    try { await h.meter.request({ method: 'debug_traceCall' }, h.send); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(RpcGuardError);
    await h.meter.summary();
    const output = [...h.lines, String(error), safeError(error)].join('\n');
    for (const secret of [url, 'sample-provider-key', 'sample-body-secret']) expect(output).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
    expect(h.send.paid).toHaveBeenCalledTimes(1); expect(h.send.public).not.toHaveBeenCalled();
    expect((await h.meter.usage()).sessionUnits).toBe(1);
  });
  it('refuses invalid weights without including supplied data in errors', () => {
    for (const RPC_WEIGHTS of ['[]', 'null', '{"eth_call":0}', '{"eth_call":-1}', '{"eth_call":"sample-key"}', 'sample-key']) {
      expect(() => rpcConfig({ RPC_WEIGHTS })).toThrow('Invalid RPC_WEIGHTS');
    }
  });
  it('fails closed on persistence errors, without fallback spending or leaking the cause', async () => {
    const h = harness({}, { reserve: async () => { throw new Error(`${defaultPublicRpc}?key=sample-provider-key`); }, today: async () => [] });
    await expect(h.meter.request({ method: 'eth_blockNumber' }, h.send)).rejects.toThrow('RPC usage persistence unavailable');
    expect(h.send.paid).not.toHaveBeenCalled(); expect(h.send.public).not.toHaveBeenCalled();
  });
  it('reports rolling minute and today totals every 60 seconds and summarizes once on close', async () => {
    vi.useFakeTimers();
    const h = harness(); h.meter.start();
    await h.meter.request({ method: 'eth_blockNumber' }, h.send);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.lines.filter(l => JSON.parse(l).event === 'rpc_usage')).toHaveLength(1);
    const summary = JSON.parse(h.lines.at(-1)!);
    expect(summary.lastMinute).toEqual([{ origin: 'unlabelled', provider: 'paid', method: 'eth_blockNumber', calls: 1, units: 1 }]);
    h.advance(60_001); await h.meter.summary();
    expect(JSON.parse(h.lines.at(-1)!).lastMinute).toEqual([]);
    await h.meter.close(); await h.meter.close();
    const count = h.lines.length; await vi.advanceTimersByTimeAsync(60_000); expect(h.lines).toHaveLength(count);
  });
  it('cancels a rate-limit wait on shutdown without sending or spending again', async () => {
    vi.useFakeTimers();
    const h = harness();
    const meter = new RpcMeter(h.meter.env, { store: h.store, log: () => {}, onSessionBudget: () => {} });
    h.send.public.mockRejectedValue(new Error('Rate Limit Hit, limit will reset in 60 seconds'));
    const pending = meter.request({ method: 'eth_getLogs' }, h.send, 'backfill');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'shutdown_requested' });
    await vi.advanceTimersByTimeAsync(10); await meter.close(); await rejected;
    expect(h.send.public).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('exports engines header/Pons reads using the same metered archive clients', () => {
    const h = harness();
    const factory = createMeteredClients(h.meter.env, { meter: h.meter });
    expect(factory.meter).toBe(h.meter); expect(factory.pons).toBe(factory.archive);
    expect(factory.header).toBeTypeOf('function');
    expect(factory.paid.transport.type).toBe('custom'); expect(factory.public.transport.type).toBe('custom');
  });
});
describe('CLI process shutdown', () => {
  it('exits zero and prints a summary on a session cutoff and SIGINT without network access', () => {
    for (const session of [true, false]) {
      const script = `
        import { RpcMeter, defaultPublicRpc } from './src/rpc/metered.ts';
        const rows = [];
        const store = {
          reserve: async (_day, provider, method, units) => {
            rows.push({ provider, method, calls: 1, units }); return { allowed: true, total: units };
          }, today: async () => rows,
        };
        const meter = new RpcMeter({ RPC_HTTP_URL: defaultPublicRpc, ${session ? "RPC_SESSION_BUDGET: '1'" : ''} }, { store });
        meter.start();
        ${session ? '' : "process.once('SIGINT', () => { void meter.close().then(() => process.exit(0)); });"}
        await meter.request({ method: 'eth_blockNumber' }, { paid: async () => '0x1', public: async () => '0x1' });
        ${session ? '' : "process.kill(process.pid, 'SIGINT'); await new Promise(() => {});"}
      `;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000,
      });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
      const events = child.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.some(e => e.event === 'rpc_usage' && e.sessionUnits === 1)).toBe(true);
      expect(events.some(e => e.event === 'rpc_session_budget_reached')).toBe(session);
    }
  }, 15000);
});
describe('application-owned usage database', () => {
  it('requires the application database or explicit standalone mode', () => {
    expect(() => new RpcMeter({})).toThrow('requires an application database/store');
    expect(() => createMeteredClients({})).toThrow('require the application database/store');
  });
  it('uses and reuses the supplied ChainDb, ignores RPC_USAGE_DIR, and leaves ownership with its caller', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-rpc-db-'));
    const unused = join(dir, 'unused-meter-db');
    const db = await openDb({ pgliteDir: ':memory:' });
    const env = { RPC_HTTP_URL: defaultPublicRpc, RPC_USAGE_DIR: unused };
    const clients = createMeteredClients(env, { db, log: () => {}, onSessionBudget: () => {} });
    try {
      expect(createMeteredClients(env, { db }).meter).toBe(clients.meter);
      await clients.meter.request({ method: 'eth_blockNumber' }, { paid: async () => '0x1', public: async () => '0x1' });
      await clients.meter.usage();
      expect((await db.sql.query("SELECT calls,units FROM rpc_usage WHERE method='eth_blockNumber'")).rows).toEqual([{ calls: 1, units: 1 }]);
      await clients.meter.close();
      expect((await db.sql.query('SELECT 1 AS available')).rows).toEqual([{ available: 1 }]);
      await expect(access(unused)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
describe('durable SQL admission', () => {
  it('persists across restart, atomically shares the limit and rolls over UTC days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-rpc-usage-'));
    let db = await openDb({ pgliteDir: dir });
    try {
      let store = createSqlUsageStore(db);
      const first = harness({ RPC_PAID_DAILY_BUDGET: '2' }, store);
      await first.meter.request({ method: 'eth_blockNumber' }, first.send);
      await first.meter.close();
      await db.close(); db = await openDb({ pgliteDir: dir }); store = createSqlUsageStore(db);
      const second = harness({ RPC_PAID_DAILY_BUDGET: '2' }, store), third = harness({ RPC_PAID_DAILY_BUDGET: '2' }, store);
      const results = await Promise.all([second.meter.request({ method: 'eth_blockNumber' }, second.send), third.meter.request({ method: 'eth_blockNumber' }, third.send)]);
      expect(results.sort()).toEqual(['paid', 'public']);
      await third.meter.usage();
      const rows = (await second.meter.usage()).today;
      expect(rows.find(r => r.provider === 'paid')).toMatchObject({ calls: 2, units: 2 });
      expect(rows.find(r => r.provider === 'public')).toMatchObject({ calls: 1, units: 1 });
      await expect(second.meter.request({ method: 'debug_traceCall' }, second.send)).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
      second.advance(86400_000);
      expect(await second.meter.request({ method: 'eth_blockNumber' }, second.send)).toBe('paid');
      expect((await second.meter.usage()).today).toEqual([{ provider: 'paid', method: 'eth_blockNumber', calls: 1, units: 1 }]);
      await second.meter.close();await third.meter.close();
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  }, 15000);
});

describe('leased SQL admission',()=>{
  it('admits cached calls while the indexer holds its write transaction, with no admission transaction or per-call SQL',async()=>{
    const db=await openDb({pgliteDir:':memory:'}), store=createSqlUsageStore(db), h=harness({RPC_PAID_MAX_RPM:'1000000'},store);
    try {
      const transactions=vi.spyOn(db,'tx');await h.meter.request({method:'eth_blockNumber'},h.send);
      expect(transactions).not.toHaveBeenCalled();
      const execute=vi.spyOn(db.sql,'query');let unlock!:()=>void,entered!:()=>void;
      const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{unlock=resolve;});
      const write=db.tx(async tx=>{await tx.sql.query('SELECT 1');entered();await gate;});await ready;
      const sqlBefore=execute.mock.calls.length;
      try {
        const admitted=Promise.all(Array.from({length:98},()=>h.meter.request({method:'eth_blockNumber'},h.send)));
        await Promise.race([admitted,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('admission waited behind write')),1000);timer.unref();})]);
        expect(execute.mock.calls.length).toBe(sqlBefore);
      } finally {unlock();await write;}
      expect(h.send.paid).toHaveBeenCalledTimes(99);
      expect((await h.meter.usage()).today).toEqual([{provider:'paid',method:'eth_blockNumber',calls:99,units:99}]);
      await h.meter.close();expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:99}]);
    }finally{await db.close();}
  });
  it('shares weighted leases atomically across processes, caps actual spending, and releases unused units on exit',async()=>{
    const db=await openDb({pgliteDir:':memory:'}),store=createSqlUsageStore(db);
    const a=harness({RPC_PAID_DAILY_BUDGET:'150',RPC_PAID_MAX_RPM:'1000000',RPC_WEIGHTS:'{"debug_traceCall":2}'},store),b=harness({RPC_PAID_DAILY_BUDGET:'150',RPC_PAID_MAX_RPM:'1000000',RPC_WEIGHTS:'{"debug_traceCall":2}'},store);
    try{
      await Promise.all([a.meter.request({method:'debug_traceCall'},a.send),b.meter.request({method:'debug_traceCall'},b.send)]);
      expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:150}]);
      await a.meter.close();await b.meter.close();
      expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:4}]);
      const c=harness({RPC_PAID_DAILY_BUDGET:'150',RPC_PAID_MAX_RPM:'1000000',RPC_WEIGHTS:'{"debug_traceCall":2}'},store);
      for(let i=0;i<73;i++)await c.meter.request({method:'debug_traceCall'},c.send);
      await expect(c.meter.request({method:'debug_traceCall'},c.send)).rejects.toMatchObject({code:'rpc_budget_exhausted'});
      expect(c.send.paid).toHaveBeenCalledTimes(73);await c.meter.close();
      expect((await store.today('2026-10-01')).find(r=>r.provider==='paid')).toMatchObject({calls:75,units:150});
    }finally{await db.close();}
  });
  it('keeps one lease of outstanding reservation when a weighted refill is interrupted',async()=>{
    const db=await openDb({pgliteDir:':memory:'}),store=createSqlUsageStore(db);
    const h=harness({RPC_WEIGHTS:'{"debug_traceCall":99,"eth_getCode":2}'},store);
    try{
      await h.meter.request({method:'debug_traceCall'},h.send);
      const lease=store.lease!;store.lease=async(...args)=>{const result=await lease(...args);h.meter.stop();return result;};
      await expect(h.meter.request({method:'eth_getCode',params:['0x','0x1']},h.send)).rejects.toMatchObject({code:'shutdown_requested'});
      expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:199}]);
      expect(h.send.paid).toHaveBeenCalledTimes(1);await h.meter.close();
      expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:99}]);
    }finally{await db.close();}
  });
  it('keeps at most one unused lease after a crash and prevents a replacement process from spending that reservation',async()=>{
    const db=await openDb({pgliteDir:':memory:'}),store=createSqlUsageStore(db),crashed=harness({RPC_PAID_DAILY_BUDGET:'100'},store);
    try{
      await crashed.meter.request({method:'debug_traceCall'},crashed.send);
      const replacement=harness({RPC_PAID_DAILY_BUDGET:'100'},store);
      await expect(replacement.meter.request({method:'debug_traceCall'},replacement.send)).rejects.toMatchObject({code:'rpc_budget_exhausted'});
      expect(replacement.send.paid).not.toHaveBeenCalled();
      expect((await db.sql.query("SELECT units FROM rpc_usage WHERE method='__total__'")).rows).toEqual([{units:100}]);
      await replacement.meter.close();await crashed.meter.close();
    }finally{await db.close();}
  });
  it('flushes buffered method counters on the three-second timer and on shutdown without turning a manual stop into a budget',async()=>{
    vi.useFakeTimers();const db=await openDb({pgliteDir:':memory:'}),store=createSqlUsageStore(db),record=vi.spyOn(store,'record'),h=harness({},store);
    try{
      const clear=vi.spyOn(globalThis,'clearInterval');h.meter.start();await h.meter.request({method:'eth_blockNumber'},h.send);
      expect((await db.sql.query("SELECT calls FROM rpc_usage WHERE method='eth_blockNumber'")).rows).toEqual([]);
      await vi.advanceTimersByTimeAsync(3000);expect(record).toHaveBeenCalledTimes(1);await h.meter.usage();
      expect((await db.sql.query("SELECT calls FROM rpc_usage WHERE method='eth_blockNumber'")).rows).toEqual([{calls:1}]);
      await h.meter.close();expect(h.meter.stopReason).toBe('shutdown_requested');expect(h.exit).not.toHaveBeenCalled();expect(clear).toHaveBeenCalledTimes(2);clear.mockRestore();
    }finally{await db.close();}
  });
});
