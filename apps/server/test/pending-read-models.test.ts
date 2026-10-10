import { expect,it } from 'vitest';
import { binary,migrate,migrateEngines } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { PairRowSchema } from '@eko/shared';
import { loadRegistry,v3Abi } from '@eko/chain';
import { encodeAbiParameters,encodeEventTopics,toHex,type Hex } from 'viem';
import { enrichSenders } from '../../indexer/src/enrich.js';
import { BlockRows } from '../../indexer/src/rows.js';
import type { ChainClient,RpcBlock,RpcLog,RpcReceipt } from '../../indexer/src/types.js';
import { readServices } from '../src/http/v1/reads.js';
import { ReadStore } from '../src/read/store.js';
import { seedReadFixture,sampleAddress } from './read-fixture.js';

it('masks pending buyers/prices and refreshes distinct senders, bars and ranks after real enrichment UPDATEs',async()=>{
 const db=await openDb({pgliteDir:':memory:'}),now=Date.now();
 try {
  await migrate(db);await migrateEngines(db);const card=await seedReadFixture(db,now),coin=card.identity.address;
  const services=readServices(new ReadStore(db,()=>now)),known=(await services.pairs.row(coin))!.buyers;
  const n=card.verdict.asOfBlock+1,pool=sampleAddress(6000),sender=sampleAddress(6001),txHash=`0x${'4'.repeat(64)}` as Hex,blockHash=`0x${'5'.repeat(64)}` as Hex;
  const at=new Date(Math.floor((now/1000-60)/60)*60000),quote=loadRegistry().requireAddress('tokens.WETH');
  const block:RpcBlock={number:toHex(n),hash:blockHash,parentHash:(await db.blockHash(BigInt(n-1)))!,timestamp:toHex(Math.floor(at.getTime()/1000)),transactions:[]};
  const event=v3Abi.find(e=>e.name==='Swap')!;
  const args={sender,recipient:sender,amount0:-(10n**19n),amount1:10n**18n,sqrtPriceX96:1n,liquidity:1n,tick:0};
  const logs:RpcLog[]=[0,1].map(i=>({address:pool,topics:encodeEventTopics({abi:[event],args}) as [Hex,...Hex[]],data:encodeAbiParameters(event.inputs.filter(p=>!('indexed' in p && p.indexed)),event.inputs.filter(p=>!('indexed' in p && p.indexed)).map(p=>args[p.name! as keyof typeof args])),blockNumber:toHex(n),blockHash,transactionHash:txHash,logIndex:toHex(i)}));
  const receipts:RpcReceipt[]=[{transactionHash:txHash,blockHash,blockNumber:toHex(n),from:sender,to:pool,logs}];
  const rows=new BlockRows();
  rows.add('chain_blocks',{number:n,block:n,hash:binary(blockHash),parent_hash:binary(block.parentHash),ts:at});
  rows.add('pools',{id:binary(pool),venue:'uniswap_v3',currency0:binary(coin),currency1:binary(quote),fee:3000,tick_spacing:60,created_block:n,block:n,creation_verified:true});
  for(let i=0;i<2;i++)rows.add('swaps',{ts:at,block:n,tx_hash:binary(txHash),log_index:i,venue:'uniswap_v3',pool_id:binary(pool),coin:binary(coin),quote_asset:binary(quote),trader:null,tx_from:null,tx_to:null,senders_pending:true,pricing_pending:true,side:1,amount_coin:'10000000000000000000',amount_quote:'1000000000000000000',price_quote:null,usd:null,priced_block:null});
  await db.tx(tx=>rows.flush(tx));
  await db.sql.query('UPDATE tokens SET graduated_block=$2,graduated_pool=$3 WHERE address=$1',[binary(coin),n,binary(pool)]);
  const oldMinute=new Date(Math.floor((now/1000-4800)/60)*60000);
  await db.sql.query('INSERT INTO bars_1m VALUES($1,$2,2,2,2,2,1,1,$3,$3)',[binary(coin),oldMinute,n-1]);
  const pending=PairRowSchema.parse(await services.pairs.row(coin));
  expect(pending.buyers).toBe(known);expect(pending.unavailable).toEqual(expect.arrayContaining(['buyers','volume','change','spark','marketCap']));expect(pending.priceUnavailable).toBe(true);expect((await services.store.rows(coin))[0].row.spark8h).toBeUndefined();
  expect((await db.sql.query('SELECT 1 FROM read_buyers WHERE trader IS NULL')).rows).toHaveLength(0);
  const client:ChainClient={chainId:async()=>4663,head:async()=>BigInt(n),block:async()=>block,header:async()=>block,receipts:async()=>receipts,
   code:async()=> '0x',logs:async()=>[],v3Pool:async()=>({currency0:coin,currency1:quote,fee:3000,tickSpacing:60}),tokenMetadata:async()=>({name:'Quote token',symbol:'QUOTE',decimals:18,totalSupply:10n**27n}),ethUsdRate:async b=>({value:2000,block:b,source:{address:sampleAddress(9000),venue:'uniswap_v3',fee:3000}})};
  expect((await enrichSenders(db,coin,client)).enriched).toBe(2);
  const enriched=(await services.pairs.row(coin))!;
  expect(enriched.buyers).toBe(known+1);expect(enriched.unavailable).not.toContain('buyers');expect(enriched.unavailable).not.toContain('volume');expect(enriched.unavailable).not.toContain('spark');expect(enriched.unavailable).not.toContain('change');
  expect(enriched.priceUnavailable).toBe(false);expect(enriched.priceUsd).toBe(200);expect(enriched.change1hPct).toBe(9900);expect((await services.store.rows(coin))[0].row.spark8h!.at(-1)).toBe(200);
  const stored=(await db.sql.query<{buyers:string;volume:number}>('SELECT buyers,volume FROM read_coins WHERE coin=$1',[binary(coin)])).rows[0];expect(Number(stored.buyers)).toBe(known+1);expect(stored.volume).toBe(4000);
  const candles=await services.coins.candles(coin,'1m',Math.floor(now/1000)-3600,Math.floor(now/1000));expect(candles.bars.at(-1)?.c).toBe(200);expect(candles.bars.at(-1)?.vUsd).toBe(4000);
  expect((await db.sql.query('SELECT 1 FROM swaps WHERE coin=$1 AND (senders_pending OR pricing_pending)',[binary(coin)])).rows).toHaveLength(0);
  // A rolled-back source UPDATE cannot alter the durable queue or cached buyer count.
  await expect(db.tx(async tx=>{await tx.sql.query('UPDATE swaps SET trader=NULL,senders_pending=true WHERE tx_hash=$1',[binary(txHash)]);throw new Error('rollback fixture');})).rejects.toThrow('rollback fixture');
  expect((await services.pairs.row(coin))!.buyers).toBe(known+1);
  // Simulate a committed change between the batch calculation and its queue acknowledgement.
  await db.sql.query('UPDATE swaps SET trader=trader WHERE tx_hash=$1',[binary(txHash)]);
  const transact=db.tx.bind(db);let inject=true;
  db.tx=fn=>transact(async tx=>{const query=tx.sql.query.bind(tx.sql);tx.sql.query=async function<T>(sql:string,params?:unknown[]){const result=await query<T>(sql,params);if(inject&&sql.startsWith('SELECT refresh_read_models')){inject=false;await query('UPDATE swaps SET trader=$1 WHERE tx_hash=$2 AND log_index=0',[binary(sampleAddress(6002)),binary(txHash)]);}return result;};return fn(tx);});
  await services.store.refreshModels();expect((await db.sql.query('SELECT 1 FROM read_dirty WHERE coin=$1',[binary(coin)])).rows).toHaveLength(1);
  db.tx=transact;expect((await services.pairs.row(coin))!.buyers).toBe(known+2);
  // Reorg-style deletes remove the known buyer and recompute activity without ingest-side projection work.
  await db.sql.query('DELETE FROM swaps WHERE tx_hash=$1',[binary(txHash)]);expect((await services.pairs.row(coin))!.buyers).toBe(known);
  await db.sql.query('DELETE FROM tokens WHERE address=$1',[binary(coin)]);await services.store.refreshModels();
  for(const table of ['read_coins','read_buyers','read_feed','read_first_verdict'])expect((await db.sql.query(`SELECT 1 FROM ${table} WHERE coin=$1`,[binary(coin)])).rows).toHaveLength(0);
 } finally {await db.close();}
},30000);
