import { afterEach, expect, it, vi } from 'vitest';
import { binary, openDb } from '@eko/db';
import { RpcMeter, type MeterOptions } from '../src/rpc/metered.js';
const address=`0x${'11'.repeat(20)}`, hash=(n:number)=>binary(`0x${n.toString(16).padStart(64,'0')}`);
const dbs:Awaited<ReturnType<typeof openDb>>[]=[];
afterEach(async()=>{for(const db of dbs.splice(0))await db.close();});
async function setup(code='0x6000',options:MeterOptions={}) {
  const db=await openDb({pgliteDir:':memory:'});dbs.push(db);
  await db.sql.query('CREATE TABLE chain_blocks(number bigint PRIMARY KEY,hash bytea)');
  await db.sql.query('CREATE TABLE delegations_7702(authority bytea,block bigint)');
  for(let n=1;n<=3;n++)await db.sql.query('INSERT INTO chain_blocks VALUES($1,$2)',[n,hash(n)]);
  const send={paid:vi.fn(async()=>code),public:vi.fn(async()=>code)};
  const make=()=>new RpcMeter({RPC_HTTP_URL:'https://paid.invalid',RPC_PAID_MAX_RPM:'1000000'}, {db,log:()=>{},...options});
  const meter=make();
  const read=(block:unknown,m=meter)=>m.request({method:'eth_getCode',params:[address,block]},send,'archive');
  return {db,meter,make,send,read};
}
it('persists immutable code across blocks and restarts, counting one paid call instead of three',async()=>{
  const h=await setup();
  expect(await h.read('0x1')).toBe('0x6000');expect(await h.read({blockHash:`0x${'0'.repeat(63)}2`,requireCanonical:true})).toBe('0x6000');await h.meter.close();
  const restarted=h.make();expect(await h.read('0x3',restarted)).toBe('0x6000');
  expect(h.send.paid).toHaveBeenCalledTimes(1);expect((await restarted.usage()).today[0].calls).toBe(1);await restarted.close();
});
it('coalesces simultaneous reads of one canonical address/block',async()=>{
  const h=await setup();expect(await Promise.all(Array.from({length:8},()=>h.read('0x1')))).toEqual(Array(8).fill('0x6000'));
  expect(h.send.paid).toHaveBeenCalledTimes(1);await h.meter.close();
});
it('never reuses empty/delegated code, future observations, unindexed blocks or latest',async()=>{
  const h=await setup('0x');await h.read('0x1');h.send.paid.mockResolvedValue('0xef0100'+'22'.repeat(20));await h.read('0x2');
  h.send.paid.mockResolvedValue('0x6000');await h.read('0x3');await h.read('0x1');await h.read('0x9');await h.read('latest');
  expect(h.send.paid).toHaveBeenCalledTimes(6);await h.meter.close();
});
it('invalidates on reorg or indexed 7702 changes, preserving actual new results',async()=>{
  const h=await setup();await h.read('0x1');
  await h.db.sql.query('UPDATE chain_blocks SET hash=$1 WHERE number=1',[hash(10)]);h.send.paid.mockResolvedValue('0x6010');
  expect(await h.read('0x2')).toBe('0x6010');
  await h.db.sql.query('INSERT INTO delegations_7702 VALUES($1,3)',[binary(address)]);h.send.paid.mockResolvedValue('0xef0100'+'22'.repeat(20));
  expect(await h.read('0x3')).toMatch(/^0xef0100/);expect(h.send.paid).toHaveBeenCalledTimes(3);await h.meter.close();
});
it('does not retain errors',async()=>{
  const h=await setup();h.send.paid.mockRejectedValueOnce(new Error('execution reverted'));
  await expect(h.read('0x1')).rejects.toThrow();expect(await h.read('0x1')).toBe('0x6000');
  expect(h.send.paid).toHaveBeenCalledTimes(2);await h.meter.close();
});

it('serves warm code while paused and keeps cache misses nonblocking for the rerate lane',async()=>{
  let now=0;
  const h=await setup('0x6000',{pauseOnOutage:true,now:()=>now,sleep:async ms=>{
    if(ms<10_000)now+=ms;else await new Promise<void>(()=>{});
  }});
  try {
    await h.read('0x1');
    h.send.paid.mockRejectedValue(new Error('User balance exceeded'));
    const pending=h.meter.request({method:'eth_getCode',params:[`0x${'22'.repeat(20)}`,'0x1']},h.send,'archive',false);
    await expect(pending).rejects.toMatchObject({code:'provider_balance_exceeded'});
    expect(h.meter.pause?.reason).toBe('provider_balance_exceeded');
    expect(await h.read('0x3')).toBe('0x6000');
    expect(h.send.paid).toHaveBeenCalledTimes(2);
  } finally {await h.meter.close();}
});

it('does not make nonblocking code reads join a foreground request held by an outage',async()=>{
  let now=0, entered!:()=>void;
  const paused=new Promise<void>(resolve=>{entered=resolve;});
  const h=await setup('0x6000',{pauseOnOutage:true,now:()=>now,onPauseChange:state=>{if(state)entered();},sleep:async ms=>{
    if(ms<10_000)now+=ms;else await new Promise<void>(()=>{});
  }});
  h.send.paid.mockRejectedValue(new Error('User balance exceeded'));
  const foreground=h.read('0x1').catch(error=>error);
  try {
    await paused;
    await expect(h.meter.request({method:'eth_getCode',params:[address,'0x1']},h.send,'archive',false))
      .rejects.toMatchObject({code:'provider_balance_exceeded'});
    expect(h.send.paid).toHaveBeenCalledTimes(1);
  } finally {await h.meter.close();}
  expect(await foreground).toMatchObject({code:'shutdown_requested'});
});
