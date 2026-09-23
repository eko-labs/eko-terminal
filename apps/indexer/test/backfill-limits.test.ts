import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, migrate, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry, RpcGuardError } from '@eko/chain';
import { toHex, type Address } from 'viem';
import { AdaptiveWindow, BackfillFailedError, isRangeLimit, PonsBackfill, RangeLeases } from '../src/backfill.js';
import { BlockDecoder } from '../src/decode.js';
import { addressBatches, budgetedQueries, logBlockLimit, type LogFilter } from '../src/log-budget.js';
import { safeError } from '../src/safe-error.js';
import { Metrics, type ChainClient } from '../src/types.js';
const registry=loadRegistry(), quiet=()=>{};
const address=(n:number):Address=>`0x${n.toString(16).padStart(40,'0')}`;
const topic=`0x${'a'.repeat(64)}` as const;
const capacity='eth_getLogs on robinhood is limited to 200000 addresses x blocks and this request needs 1000000, narrow the fromBlock/toBlock range or filter on fewer addresses (a filter with no address counts as 5 addresses)';
const handles:ChainDb[]=[];
afterEach(async()=>{await Promise.all(handles.splice(0).map(db=>db.close()));});
async function database(){const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);return db;}
function client():ChainClient {
  const b=(n:bigint)=>({number:toHex(n),hash:topic,parentHash:topic,timestamp:toHex(1800000000),transactions:[]});
  return {chainId:async()=>4663,head:async()=>199999n,block:async n=>b(n),header:async n=>b(n),receipts:async()=>[],logs:async()=>[],
    tokenMetadata:async()=>({name:'Sample token',symbol:'DEMO',decimals:18}),code:async()=> '0x',v3Pool:async()=>null};
}
function worker(db:ChainDb,rpc:ChainClient,logger=quiet,workers=2){return new PonsBackfill(rpc,db,new BlockDecoder(rpc,registry,new Metrics(quiet),quiet),{workers,concurrency:4,logRange:20000,logger});}
function assertBudget(f:LogFilter){const count=f.addresses?.length || (f.address?1:5);expect(Number(f.to-f.from+1n)*count).toBeLessThanOrEqual(200000);expect(f.to-f.from+1n).toBeLessThanOrEqual(100000n);}
function providerError(reason='Invalid log filter', variant=0){return Object.assign(new Error(`${reason}\nURL: https://rpc.invalid/?dkey=demo-key-${variant}\nRequest body: {"params":["demo-body"]}\nDetails: demo-details`),{shortMessage:reason,details:`URL: https://rpc.invalid/?api_key=demo-key-${variant}\nRequest body: {"token":"demo-body"}`});}

describe('RPC address × block budget',()=>{
  it('caps inclusive windows for single-address, array, and topic-only filters',()=>{
    expect(logBlockLimit({address:address(1)})).toBe(100000);
    expect(logBlockLimit({addresses:Array.from({length:50},(_,i)=>address(i+1))})).toBe(4000);
    expect(logBlockLimit({})).toBe(40000);
    for(const f of [{address:address(1)},{},{addresses:Array.from({length:123},(_,i)=>address(i+1))}]) {
      const queries=[...budgetedQueries({...f,from:0n,to:199999n,topics:[topic]})];
      queries.forEach(assertBudget);
      const tracked=f.addresses ?? [f.address];
      for(const a of tracked){const selected=queries.filter(q=>a==null || q.address===a || q.addresses?.includes(a));expect(selected[0].from).toBe(0n);expect(selected.at(-1)!.to).toBe(199999n);for(let i=1;i<selected.length;i++)expect(selected[i].from).toBe(selected[i-1].to+1n);}
    }
    expect(addressBatches({from:0n,to:1n,addresses:Array.from({length:123},(_,i)=>address(i+1)),topics:[topic]}).map(q=>q.addresses!.length)).toEqual([50,50,23]);
    expect(()=>[...budgetedQueries({from:0n,to:1n,addresses:[],topics:[topic]})]).toThrow('Empty');
  });
  it.each(['logs:holders','logs:pair_swaps'] as const)('plans %s across 200k blocks without capacity failures',async stream=>{
    const db=await database();const rpc=client();const targets=Array.from({length:101},(_,i)=>address(i+1));
    if(stream==='logs:holders')await db.insertMany('tokens',targets.map(a=>({address:binary(a),decimals:18,first_block:'0',block:'0'})));
    else await db.insertMany('pools',targets.map(a=>({id:binary(a),venue:'uniswap_v3',currency0:binary(address(200)),currency1:binary(address(201)),fee:100,tick_spacing:1,creation_verified:true,created_block:'0',block:'0'})));
    let active=0,maxActive=0;const calls:LogFilter[]=[];
    rpc.logs=async f=>{assertBudget(f);calls.push(f);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return [];};
    await worker(db,rpc,quiet,4).run(stream,0n,199999n);
    expect(maxActive).toBeLessThanOrEqual(4);expect(calls.length).toBeLessThan(140);
    for(const a of targets){const ranges=calls.filter(f=>f.addresses?.includes(a)).sort((a,b)=>a.from<b.from?-1:1);expect(ranges[0].from).toBe(0n);expect(ranges.at(-1)!.to).toBe(199999n);for(let i=1;i<ranges.length;i++)expect(ranges[i].from).toBe(ranges[i-1].to+1n);}
    expect((await db.sql.query<{status:string}>('SELECT status FROM ingest_ranges')).rows.map(r=>r.status)).toEqual(Array(10).fill('done'));
  });
  it('recognizes wrapped provider capacity errors and shrinks instead of consuming range retries',async()=>{
    const error=Object.assign(new Error('RPC request failed'),{shortMessage:'RPC request failed',details:capacity});
    expect(isRangeLimit(error)).toBe(true);const window=new AdaptiveWindow(20000);expect(window.failure(error)).toBe(true);expect(window.size).toBe(10000);
    const db=await database(),rpc=client();const requests:LogFilter[]=[];let first=true;
    rpc.logs=async f=>{assertBudget(f);requests.push(f);if(first){first=false;throw error;}return [];};
    await worker(db,rpc,quiet,1).run('logs:pools',0n,19999n);
    expect(requests.some(f=>f.to-f.from+1n===10000n)).toBe(true);
    expect((await db.sql.query<{attempts:number;error_repeats:number}>('SELECT attempts,error_repeats FROM ingest_ranges')).rows[0]).toEqual({attempts:1,error_repeats:0});
  });
});

describe('backfill guard stops', () => {
  it.each(['rpc_session_budget_reached', 'rpc_budget_exhausted'] as const)('releases the range without failure counters or retries on %s', async reason => {
    const db = await database(), rpc = client(), logger = vi.fn();
    const error = new Error('Archive read refused', { cause: new RpcGuardError(reason) });
    const reads = vi.spyOn(rpc, 'logs').mockRejectedValue(error);
    await expect(worker(db, rpc, logger, 1).run('logs:pons_factory', 0n, 19999n)).rejects.toBe(error);
    expect(reads).toHaveBeenCalledTimes(1);
    expect((await db.sql.query('SELECT status,attempts,last_error,error_repeats,lease_owner FROM ingest_ranges')).rows).toEqual([
      { status: 'todo', attempts: 1, last_error: null, error_repeats: 0, lease_owner: null },
    ]);
    expect(logger.mock.calls).toEqual([]);
    reads.mockResolvedValue([]);
    await worker(db, rpc, logger, 1).run('logs:pons_factory', 0n, 19999n);
    expect((await db.sql.query('SELECT status,error_repeats FROM ingest_ranges')).rows).toEqual([{ status: 'done', error_repeats: 0 }]);
  });
});
describe('range failures',()=>{
  it('retires a range after three identical sanitized failures, completes others, reports and rejects at the end',async()=>{
    const db=await database(),rpc=client();const logger=vi.fn();let attempts=0;const completed:bigint[]=[];
    rpc.logs=async f=>{if(f.from===0n)throw providerError('Invalid log filter',++attempts);completed.push(f.from);return [];};
    await expect(worker(db,rpc,logger).run('logs:pons_factory',0n,59999n)).rejects.toBeInstanceOf(BackfillFailedError);
    expect(attempts).toBe(3);expect(completed).toContain(20000n);expect(completed).toContain(40000n);
    const rows=(await db.sql.query<{from_block:number;status:string;attempts:number;error_repeats:number;last_error:string}>('SELECT * FROM ingest_ranges ORDER BY from_block')).rows;
    expect(rows.map(r=>r.status)).toEqual(['failed','done','done']);expect(rows[0]).toMatchObject({attempts:3,error_repeats:3,last_error:'Invalid log filter'});
    const report=logger.mock.calls.find(([event])=>event==='backfill_failed_ranges')?.[1];expect(report).toMatchObject({count:1,ranges:[{from:'0',to:'19999',attempts:3,error:'Invalid log filter'}]});
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/demo-key|demo-body|demo-details|rpc.invalid|Request body/);
    // A restart remembers terminal failures and does not spin or repeat known bad requests.
    await expect(worker(db,rpc,logger).run('logs:pons_factory',0n,59999n)).rejects.toBeInstanceOf(BackfillFailedError);expect(attempts).toBe(3);
  });
  it('resets the consecutive counter when the reason changes and recovers after more than three claims',async()=>{
    const db=await database(),rpc=client();let attempts=0;
    rpc.logs=async()=>{attempts++;if(attempts<=4)throw new Error(attempts%2 ? 'Archive unavailable' : 'Receipt unavailable');return [];};
    await worker(db,rpc,quiet,1).run('logs:pons_factory',0n,19999n);expect(attempts).toBe(5);
    expect((await db.sql.query('SELECT status,attempts,last_error,error_repeats FROM ingest_ranges')).rows[0]).toEqual({status:'done',attempts:5,last_error:null,error_repeats:0});
  });
  it('persists counters across lease owners, rejects stale failures, and bounds alternating failures',async()=>{
    const db=await database(),leases=new RangeLeases(db);await leases.seed('logs:pools',0n,19999n);
    const old=await leases.claim('logs:pools','sample-worker-a',0n,19999n);
    await db.sql.query("UPDATE ingest_ranges SET lease_until=now()-interval '1 second'");
    const next=await leases.claim('logs:pools','sample-worker-b',0n,19999n);
    await expect(leases.fail(old!,new Error('Wrong owner'))).rejects.toThrow('lease lost');expect(await leases.fail(next!,providerError())).toBe(1);
    const another=new RangeLeases(db);const third=await another.claim('logs:pools','sample-worker-c',0n,19999n);expect(await another.fail(third!,providerError())).toBe(2);
    const fourth=await another.claim('logs:pools','sample-worker-c',0n,19999n);expect(await another.fail(fourth!,providerError())).toBe(3);expect(await another.claim('logs:pools','sample-worker-c',0n,19999n)).toBeNull();
    const rpc=client();let calls=0;rpc.logs=async()=>{throw new Error(++calls%2?'First reason':'Second reason');};
    await expect(worker(db,rpc,quiet,1).run('logs:pons_factory',20000n,39999n)).rejects.toBeInstanceOf(BackfillFailedError);expect(calls).toBe(9);
  });
});

describe('secret-safe error reasons',()=>{
  it('reduces a viem-style URL/body/details error to a short reason',()=>{
    const error=providerError();error.cause=providerError();
    expect(safeError(error)).toBe('Invalid log filter');expect(safeError(error)).not.toMatch(/demo-key|demo-body|demo-details|https|Request body|URL|Details/);
  });
  it('preserves the provider reason behind a wrapper body and strips key parameters and JSON details',()=>{
    const error=Object.assign(new Error('HTTP request failed\nRequest body: {"params":["demo-body"]}'),{cause:{message:'HTTP request failed',details:capacity}});
    expect(safeError(error)).toBe(`HTTP request failed | ${capacity}`.slice(0,300));expect(isRangeLimit(error)).toBe(true);
    expect(safeError(new Error('Denied ?dkey=demo-key&api_key=demo-key token=demo-key api-key:demo-key'))).not.toContain('demo-key');
    expect(safeError({shortMessage:'Provider rejected request',details:'{"params":["demo-body"],"key":"demo-key"}'})).toBe('Provider rejected request');
    expect(safeError(new Error('x'.repeat(1000)))).toHaveLength(300);
  });
});
