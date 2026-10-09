import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary, runRetention } from '@eko/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadFixture } from './read-fixture.js';
import { readCurveStates,readPoolLiquidity,readPoolMoney } from '../src/read/pool-liquidity.js';
const now=Date.parse('2026-12-01T00:00:00Z');
let built:Awaited<ReturnType<typeof buildApp>>,coin:import('@eko/shared').Address;
beforeAll(async()=>{
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'fixture-retention-placeholder'.repeat(2),LEGACY_API:'false',RUN_WORKER:'false'}),{startBackground:false});
  const card=await seedReadFixture(built.ctx.dbh.chain,now-40*86400000);coin=card.identity.address;
  built.ctx.reads.store.now=()=>now;
  const db=built.ctx.dbh.chain,n=(await db.sql.query<{n:string}>('SELECT max(number)+100 AS n FROM chain_blocks')).rows[0]!.n;
  await db.insert('chain_blocks',{number:n,block:n,hash:binary(`0x${'ab'.repeat(32)}`),parent_hash:binary(`0x${'cd'.repeat(32)}`),ts:new Date(now)});
  await db.sql.query("INSERT INTO engine_block_times VALUES($1,$2,NULL,'head')",[n,new Date(now)]);
  for(const h of ['1h','24h','7d'])await db.sql.query("INSERT INTO outcomes VALUES($1,$2,$3,'survived','{}') ON CONFLICT DO NOTHING",[binary(coin),h,n]);
});
afterAll(async()=>{await built?.close();});
describe('settled indexed API reads',()=>{
  it('returns identical card, verdict, candles, flow and money readings with no chain reload',async()=>{
    const db=built.ctx.dbh.chain;
    const urls=[`/v1/coins/${coin}`,`/v1/coins/${coin}/verdict`,`/v1/coins/${coin}/candles?tf=1m&from=${now/1000-45*86400}&to=${now/1000}`,`/v1/coins/${coin}/flow?window=1h`];
    const read=async()=>Promise.all(urls.map(async url=>{const r=await built.app.inject(url);expect(r.statusCode,url).toBe(200);return r.json();}));
    const money=async()=>Promise.all([readCurveStates(db,[coin]),readPoolLiquidity(db,[coin]),readPoolMoney(db,[coin],now)]);
    const grades=await built.ctx.reads.grades.read();
    const before=await read(),values=await money(),usage=JSON.stringify(built.ctx.chains.meter.usage());
    const result=await runRetention(db,{quoteTokens:[],swapDays:1,transferDays:1,dryRun:false,pauseMs:0,now:()=>now});
    expect(result.historyTransfers+result.historySwaps+result.historyPons).toBeGreaterThan(0);
    expect(await read()).toEqual(before);expect(await built.ctx.reads.grades.read()).toEqual(grades);expect(await money()).toEqual(values);
    const scan=(await built.app.inject(`/v1/scan?q=${coin}`)).json();expect(scan.status).toBe('ready');const {delayedSec:_transport,...storedCard}=before[0];expect(scan.card).toEqual(storedCard);
    expect(JSON.stringify(built.ctx.chains.meter.usage())).toBe(usage);
  });
});
