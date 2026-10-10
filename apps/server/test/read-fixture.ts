import { withHistoryFixtures } from '../../../packages/db/test/helpers/historical-db.js';
import { readFile } from 'node:fs/promises';
import { binary, type ChainDb } from '@eko/db';
import { loadRegistry } from '@eko/chain';
import { EngineWorker } from '@eko/engines';
import { BlockDecoder } from '@eko/indexer';
import type { ChainClient, RpcBlock, RpcReceipt } from '../../indexer/src/types.js';
export const sampleAddress=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const;
export async function seedReadFixture(db:ChainDb,now=Date.now()) {
  withHistoryFixtures(db);
  const fixture=JSON.parse(await readFile(new URL('../../indexer/test/fixtures/4663/blocks.json',import.meta.url),'utf8')) as Record<string,{block:RpcBlock;receipts:RpcReceipt[]}>;
  const {block,receipts}=structuredClone(fixture.ponsLaunch);
  block.timestamp=`0x${Math.floor(now/1000-7200).toString(16)}`;
  const n=BigInt(block.number);
  const client:ChainClient={chainId:async()=>4663,head:async()=>n,block:async()=>block,receipts:async()=>receipts,code:async()=> '0x',
    tokenMetadata:async()=>({name:'Fixture coin',symbol:'FIX',decimals:18,totalSupply:10n**27n,supplyBlock:n}),
    v3Pool:async()=>null,logs:async()=>[],ethUsdRate:async()=>({value:2000,block:n,source:{address:sampleAddress(9000),venue:'uniswap_v3',fee:3000}})};
  const decoder=new BlockDecoder(client,loadRegistry(),undefined,()=>{});
  const prepared=await decoder.prepare(db,block,receipts,{ponsOnly:true});
  await db.ensurePartitions(new Date(Number(BigInt(block.timestamp))*1000));
  await db.tx(async tx=>{
    await tx.insert('chain_blocks',{number:n.toString(),block:n.toString(),hash:binary(block.hash),parent_hash:binary(block.parentHash),ts:new Date(Number(BigInt(block.timestamp))*1000)});
    await decoder.write(tx,block,receipts,prepared,{ponsOnly:true});
  });
  decoder.committed(prepared);
  await new EngineWorker(db).replay(Number(n),Number(n));
  const result=await db.sql.query<{data:import('@eko/shared').CoinCard}>('SELECT data FROM coin_card_latest ORDER BY coin LIMIT 1');
  if(!result.rows[0])throw new Error('Indexer fixture produced no engine card');
  return result.rows[0].data;
}
