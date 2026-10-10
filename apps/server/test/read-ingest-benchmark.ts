/** Offline comparison of read-maintenance overhead in the actual indexer write path. */
import { performance } from 'node:perf_hooks';
import { readFile,writeFile } from 'node:fs/promises';
import { binary,migrate,migrateEngines,} from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry } from '@eko/chain';
import { BlockDecoder } from '@eko/indexer';
import { ReadStore } from '../src/read/store.js';
import { BlockRows } from '../../indexer/src/rows.js';
import type { ChainClient,RpcBlock,RpcReceipt } from '../../indexer/src/types.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as const;
const now=Date.now(),sec=Math.floor(now/1000),fixture=JSON.parse(await readFile(new URL('../../indexer/test/fixtures/4663/blocks.json',import.meta.url),'utf8')) as Record<string,{block:RpcBlock;receipts:RpcReceipt[]}>;
const results:unknown[]=[];
for(const enabled of [false,true]) {
 const db=await openDb({pgliteDir:':memory:'});
 try {
  await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(now));
  if(!enabled)for(const table of ['tokens','pools','swaps','bars_1m'])await db.sql.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  const blocks=[structuredClone(fixture.v3PoolCreated),structuredClone(fixture.ponsLaunch),structuredClone(fixture.ponsSell)];
  const client:ChainClient={chainId:async()=>4663,head:async()=>0n,block:async n=>blocks.find(b=>BigInt(b.block.number)===n)!.block,receipts:async n=>blocks.find(b=>BigInt(b.block.number)===n)!.receipts,
   code:async()=> '0x',logs:async()=>[],v3Pool:async()=>null,tokenMetadata:async(_a,n)=>({name:'Sample coin',symbol:'DEMO',decimals:18,totalSupply:10n**27n,supplyBlock:n}),ethUsdRate:async n=>({value:2000,block:n,source:{address:address(9000),venue:'uniswap_v3',fee:3000}})};
  const decoder=new BlockDecoder(client,loadRegistry(),undefined,()=>{});
  let writes=0;const fixtureStart=performance.now();
  for(const [i,{block,receipts}] of blocks.entries()) {
   block.timestamp=`0x${(sec-180+i*60).toString(16)}`;
   const prepared=await decoder.prepare(db,block,receipts),start=performance.now();
   await db.tx(async tx=>{await tx.insert('chain_blocks',{number:String(BigInt(block.number)),block:String(BigInt(block.number)),hash:binary(block.hash),parent_hash:binary(block.parentHash),ts:new Date(Number(BigInt(block.timestamp))*1000)});await decoder.write(tx,block,receipts,prepared);});
   writes+=performance.now()-start;decoder.committed(prepared);
  }
  const fixtureMs=performance.now()-fixtureStart,store=new ReadStore(db,()=>now),modelStart=performance.now();await store.refreshModels();
  results.push({kind:'fixture',enabled,ingestMs:fixtureMs,writeMs:writes,refreshMs:performance.now()-modelStart});
  await db.insert('chain_blocks',{number:'1',block:'1',hash:binary(hash(1)),parent_hash:binary(hash(0)),ts:new Date(now-3600000)});
  await db.insertMany('tokens',Array.from({length:100},(_,i)=>({address:binary(address(1000+i)),name:'Synthetic coin',symbol:'SAMPLE',decimals:18,first_block:'1',block:'1',launchpad:i<50?'pons':'other',deployer:i<50?binary(address(2000+i)):null,curve:i<50?binary(address(3000+i)):null})));
  writes=0;const start=performance.now();
  // Ten bounded 20-block chunks, each with 500 swaps/block. Includes deferred sender/pricing rows.
  for(let batch=0;batch<10;batch++) {
   const rows=new BlockRows();
   for(let i=0;i<10000;i++) {
    const n=batch*10000+i,c=n%100,pending=c>=50,pricing=pending&&c%2===0;
    rows.add('swaps',{ts:new Date((sec-1200+Math.floor(n/500)*6)*1000),block:String(100+Math.floor(n/500)),tx_hash:binary(hash(1000000+n)),log_index:0,
     venue:pending?'uniswap_v3':'pons_curve',pool_id:binary(address(3000+c)),coin:binary(address(1000+c)),quote_asset:binary(address(0)),
     trader:pending?null:binary(address(4000+n%2000)),tx_from:pending?null:binary(address(4000+n%2000)),tx_to:pending?null:binary(address(3000+c)),senders_pending:pending,
     side:n%3===0?-1:1,amount_coin:'1000000000000000000',amount_quote:'1',price_quote:pricing?null:1,usd:pricing?null:10,pricing_pending:pricing,priced_block:pricing?null:'1'});
   }
   const writing=performance.now();await db.tx(tx=>rows.flush(tx));writes+=performance.now()-writing;
  }
  const ingestMs=performance.now()-start,refreshStart=performance.now();await store.refreshModels();
  results.push({kind:'100k swaps',enabled,ingestMs,writeMs:writes,refreshMs:performance.now()-refreshStart});
  console.log(JSON.stringify(results.slice(-2)));
 } finally {await db.close();}
}
await writeFile('/private/tmp/eko-read-ingest-benchmark.json',JSON.stringify(results,null,2));
