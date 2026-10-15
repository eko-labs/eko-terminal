import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { binary, hex, migrate, migrateEngines, } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry } from '@eko/chain';
import { BlockDecoder } from '@eko/indexer';
import { enrichSenders } from '../../indexer/src/enrich.js';
import { EngineWorker } from '@eko/engines';
import { toUntrusted } from '@eko/untrusted';
import { readRoutes, readServices } from '../src/http/v1/reads.js';
import { ReadStore } from '../src/read/store.js';
import type { ChainClient, RpcBlock, RpcReceipt } from '../../indexer/src/types.js';

// Deterministic high-entropy text: repeated padding can compress enough to hide oversized index tuples.
const longText = (seed:string) => Array.from({length:240},(_,i)=>createHash('sha256').update(`${seed}:${i}`).digest('base64')).join('').slice(0,10*1024);
const now=Date.now(),registry=loadRegistry();
it.each([true,false])('preserves hostile chain identities through migration and reads (existing data: %s)',async existing=>{
 const db=await openDb({pgliteDir:':memory:'}),app=Fastify();
 try {
  await migrate(db);
  if(!existing) {
   await migrateEngines(db);
   // Emulate an already-applied pre-review migration while the token table is empty.
   await db.sql.query('CREATE INDEX tokens_symbol_lower ON tokens(lower(symbol))');
   await db.sql.query('DROP INDEX tokens_symbol_address');
   await db.sql.query('CREATE INDEX tokens_symbol_address ON tokens(lower(symbol),address) INCLUDE(name,symbol,launchpad,curve)');
   await db.sql.query("UPDATE eko_engine_migrations SET id='0111_v1_reads' WHERE id='0113_v1_reads'");
   await migrateEngines(db);
  }
  const fixture=JSON.parse(await readFile(new URL('../../indexer/test/fixtures/4663/blocks.json',import.meta.url),'utf8')) as Record<string,{block:RpcBlock;receipts:RpcReceipt[]}>;
  const blocks=[structuredClone(fixture.v3PoolCreated),structuredClone(fixture.ponsLaunch)];
  const controls=existing ? '' : '\u001b\u202e\u2066';
  const name=controls+longText('name')+' tailneedle',symbol=controls+longText('symbol');
  expect(Buffer.byteLength(name)).toBeGreaterThanOrEqual(10*1024);expect(Buffer.byteLength(symbol)).toBeGreaterThanOrEqual(10*1024);
  const client:ChainClient={chainId:async()=>4663,head:async()=>BigInt(blocks[1].block.number),block:async n=>blocks.find(b=>BigInt(b.block.number)===n)!.block,
   receipts:async n=>blocks.find(b=>BigInt(b.block.number)===n)!.receipts,code:async()=> '0x',logs:async()=>[],v3Pool:async()=>null,
   tokenMetadata:async(_a,n)=>({name,symbol,decimals:18,totalSupply:10n**27n,supplyBlock:n}),ethUsdRate:async n=>({value:2000,block:n,source:{address:registry.requireAddress('uniswapV3.quoterV2'),venue:'uniswap_v3',fee:3000}})};
  const decoder=new BlockDecoder(client,registry,undefined,()=>{});
  for(const [i,{block,receipts}] of blocks.entries()) {
   block.timestamp=`0x${Math.floor(now/1000-120+i*60).toString(16)}`;
   const prepared=await decoder.prepare(db,block,receipts);
   await db.tx(async tx=>{
    await tx.ensurePartitions(new Date(now));
    await tx.insert('chain_blocks',{number:String(BigInt(block.number)),block:String(BigInt(block.number)),hash:binary(block.hash),parent_hash:binary(block.parentHash),ts:new Date(Number(BigInt(block.timestamp))*1000)});
    await decoder.write(tx,block,receipts,prepared);
   });
   decoder.committed(prepared);
  }
  if(existing)await migrateEngines(db);
  await migrateEngines(db); // replaying the renamed migration is idempotent
  expect((await db.sql.query("SELECT id FROM eko_engine_migrations WHERE id='0113_v1_reads'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT id FROM eko_engine_migrations WHERE id='0111_v1_reads'")).rows).toHaveLength(0);
  const pending=(await db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens WHERE name IS NULL AND deployer IS NULL ORDER BY address LIMIT 1')).rows[0];
  expect(pending).toBeDefined();
  const deferred=(await db.sql.query<{n:string}>('SELECT count(*) AS n FROM swaps WHERE senders_pending OR pricing_pending')).rows[0];
  expect(Number(deferred.n)).toBeGreaterThan(0);
  await enrichSenders(db,hex(pending.address),client);
  const identities=(await db.sql.query<{address:Uint8Array;name:string;symbol:string;deployer:Uint8Array|null}>('SELECT address,name,symbol,deployer FROM tokens WHERE name=$1',[name])).rows;
  const pons=identities.find(t=>t.deployer),v3=identities.find(t=>!t.deployer);
  expect(pons).toBeDefined();expect(v3).toBeDefined();
  await new EngineWorker(db).replay(Number(BigInt(blocks[0].block.number)),Number(BigInt(blocks[1].block.number)));
  const services=readServices(new ReadStore(db,()=>now));
  await app.register(async scope=>readRoutes(scope,services),{prefix:'/v1'});
  const ponsAddress=hex(pons!.address),v3Address=hex(v3!.address),from=Math.floor(now/1000)-3600,to=Math.floor(now/1000);
  for(const route of ['/v1/radar','/v1/pairs?stage=new','/v1/pairs?stage=near_grad','/v1/pairs?stage=migrated','/v1/feed','/v1/feed?kinds=new_pair','/v1/feed?kinds=verdict']) {
   const response=await app.inject(route);expect(response.statusCode,route).toBe(200);
   for(const row of response.json().rows)if(row.address===ponsAddress || row.coin===ponsAddress || row.coin===v3Address) {
    expect(row.symbol).toEqual(toUntrusted(symbol,32));
    if(row.name)expect(row.name).toEqual(toUntrusted(name,120));
   }
  }
  for(const address of [ponsAddress,v3Address]) {
   for(const suffix of ['', '/verdict','/flow']) {
    const response=await app.inject(`/v1/coins/${address}${suffix}`);expect(response.statusCode).toBe(address===ponsAddress ? 200 : 404);
    if(!suffix && address===ponsAddress){expect(response.json().identity.name).toEqual(toUntrusted(name,120));expect(response.json().identity.symbol).toEqual(toUntrusted(symbol,32));}
   }
   for(const suffix of [`/candles?tf=5m&from=${from}&to=${to}`,`/markers?from=${from}&to=${to}`])expect((await app.inject(`/v1/coins/${address}${suffix}`)).statusCode).toBe(200);
   const scan=(await app.inject(`/v1/scan?q=${address}`)).json();expect(scan.status).toBe(address===ponsAddress ? 'ready' : 'pending');
   const identity=scan.card?.identity ?? scan.candidates[0];expect(identity.name).toEqual(toUntrusted(name,120));expect(identity.symbol).toEqual(toUntrusted(symbol,32));
  }
  // Match beyond any bounded name prefix; filter full symbols to reject prefix collisions.
  expect((await app.inject('/v1/scan?q=tailneedle')).json().candidates.map((r:{address:string})=>r.address)).toEqual(expect.arrayContaining([ponsAddress,v3Address]));
  expect((await services.scan.scan(symbol.slice(0,110)+'!')).status).toBe('not_found');
  expect((await services.scan.scan(symbol)).candidates?.map(r=>r.address)).toEqual(expect.arrayContaining([ponsAddress,v3Address]));
  const stored=(await db.sql.query<{name:string;symbol:string}>('SELECT name,symbol FROM tokens WHERE address=ANY($1::bytea[])',[[pons!.address,v3!.address]])).rows;
  expect(stored).toHaveLength(2);for(const row of stored){expect(row.name).toBe(name);expect(row.symbol).toBe(symbol);}
  const feed=(await db.sql.query<{symbol:string}>('SELECT symbol FROM read_feed WHERE coin=$1',[pons!.address])).rows;
  expect(feed.length).toBeGreaterThan(0);expect(feed.every(r=>r.symbol===symbol)).toBe(true);
  const terms=(await db.sql.query<{n:number}>('SELECT max(octet_length(term)) AS n FROM unnest(read_name_terms($1)) term',[name+'🙂'])).rows[0].n;
  expect(terms).toBeLessThanOrEqual(12);
  const indexes=(await db.sql.query<{indexname:string;indexdef:string}>("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='tokens'")).rows;
  expect(indexes.find(i=>i.indexname==='tokens_symbol_lower')).toBeUndefined();
  expect(indexes.find(i=>i.indexname==='tokens_symbol_address')!.indexdef.replaceAll('"','')).toContain('left(lower(symbol), 64)');
  expect(indexes.every(i=>!i.indexdef.includes('INCLUDE'))).toBe(true);
 } finally {await app.close();await db.close();}
},120000);
