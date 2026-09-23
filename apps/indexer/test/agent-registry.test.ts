import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, binary, hex, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry } from '@eko/chain';
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type Address, type Hex } from 'viem';
import { AgentRegistryCollector, agentTransferAbi, type RegistryWalletEventProfile } from '../src/agent-registry.js';
import type { ChainClient, RpcLog } from '../src/types.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:number,fork=0)=>`0x${(n+fork*10000).toString(16).padStart(64,'0')}` as Hex;
const registry=loadRegistry(),emitter=registry.requireAddress('erc8004.identityRegistry');
const owner=address(1),otherOwner=address(2),wallet=address(3),otherWallet=address(4),zero=address(0);
const eventAbi=parseAbi(['event WalletChanged(uint256 indexed agentId, address wallet)']);
const makeLog=(block:number,from:Address,to:Address,id=1):RpcLog=>({address:emitter,
  topics:encodeEventTopics({abi:agentTransferAbi,eventName:'Transfer',args:{from,to,tokenId:BigInt(id)}}) as [Hex,...Hex[]],data:'0x',
  blockNumber:toHex(block),blockHash:hash(block),transactionHash:hash(block+100),logIndex:'0x0'});
let db:ChainDb,logs:RpcLog[],fork:number,read:ReturnType<typeof vi.fn<NonNullable<ChainClient['agentWallets']>>>,client:ChainClient;
beforeEach(async()=>{
  db=await openDb({pgliteDir:':memory:'});await migrate(db);logs=[];fork=0;
  read=vi.fn(async(ids:bigint[],n:bigint)=>ids.map(()=>({owner:n>=8n?otherOwner:owner,wallet:n>=8n?otherWallet:wallet,tokenUri:'ipfs://fixture'})));
  client={chainId:async()=>4663,head:async()=>12n,block:async n=>({number:toHex(n),hash:hash(Number(n),Number(n)>=8?fork:0),parentHash:hash(Number(n)-1),timestamp:'0x1',transactions:[]}),
    receipts:async()=>[],logs:async input=>logs.filter(l=>BigInt(l.blockNumber)>=input.from&&BigInt(l.blockNumber)<=input.to&&input.topics.includes(l.topics[0])),
    code:async()=> '0x',agentWallets:read,tokenMetadata:async()=>({symbol:null,name:null,decimals:null}),v3Pool:async()=>null};
});
afterEach(async()=>{await db.close();});
describe('indexer-owned declared wallet collection',()=>{
  it('batches identities at the event block and never substitutes token ownership',async()=>{
    logs=[makeLog(5,zero,owner,1),{...makeLog(5,zero,owner,2),logIndex:'0x1'},makeLog(8,owner,otherOwner)];
    await new AgentRegistryCollector(client,db,registry).scan(0n,12n);
    expect(read.mock.calls.map(([ids,n])=>[ids,n])).toEqual([[[1n,2n],5n],[[1n],8n]]);
    const rows=(await db.sql.query<{wallet:Uint8Array;owner:Uint8Array;wallet_block:string}>('SELECT * FROM agent_registry ORDER BY wallet_block,agent_id')).rows;
    expect(rows.map(r=>[hex(r.owner),hex(r.wallet),String(r.wallet_block)])).toEqual([[owner,wallet,'5'],[owner,wallet,'5'],[otherOwner,otherWallet,'8']]);
    expect(await new AgentRegistryCollector(client,db,registry).coverage()).toMatchObject({agents:2,nonzero_wallets:2,walletChangeEvents:'unverified'});
  });
  it('seeks one snapshot per identity with the same results as history DISTINCT ON at pinned heads and after reorgs',async()=>{
    await db.sql.query(`INSERT INTO agent_registry(agent_id,owner,wallet,token_uri,registered_block,wallet_block,block,block_hash,evidence)
      SELECT id,CASE WHEN id%3=0 AND b=40 THEN $1::bytea ELSE $2::bytea END,$3,NULL,0,b,b,$4,'{}'
      FROM generate_series(1,200) id CROSS JOIN generate_series(1,40) b`,[binary(zero),binary(owner),binary(wallet),binary(hash(1))]);
    const query=db.sql.query.bind(db.sql);let compared=0;
    db.sql.query=async function<T>(sql:string,params?:unknown[]) {
      const result=await query<T>(sql,params);
      if(sql.startsWith('SELECT a.* FROM agent_registry_ids')) {
        const previous=await query('SELECT DISTINCT ON(agent_id) * FROM agent_registry WHERE wallet_block<=$1 ORDER BY agent_id,wallet_block DESC',params);
        expect(result.rows).toEqual(previous.rows);compared++;
        const plan=await query('EXPLAIN '+sql,params);
        expect(JSON.stringify(plan.rows)).toContain('agent_registry_pkey');
      }
      return result;
    };
    const c=new AgentRegistryCollector(client,db,registry);
    for(const n of [0n,5n,17n,50n])await c.snapshot(n);
    await db.sql.query('DELETE FROM agent_registry WHERE wallet_block>12 OR agent_id=1');
    await c.snapshot(12n);expect(compared).toBe(5);
    expect((await c.coverage()).agents).toBe(199);
  });
  it('resolves only supplied reviewed event profiles and enforces their pinned bytecode',async()=>{
    const l:RpcLog={...makeLog(9,zero,owner),topics:encodeEventTopics({abi:eventAbi,eventName:'WalletChanged',args:{agentId:1n}}) as [Hex,...Hex[]],data:encodeAbiParameters([{type:'address'}],[otherWallet])};
    const {keccak256}=await import('viem');
    const p:RegistryWalletEventProfile={event:eventAbi[0],agentIdField:'agentId',codeHash:keccak256('0x01'),fromBlock:'0',toBlock:'20',evidence:{reviewId:'fixture-review',log:l}};
    logs=[makeLog(5,zero,owner),l];client.code=async()=> '0x01';
    const collector=new AgentRegistryCollector(client,db,registry,{walletEvents:[p]});
    await collector.scan(0n,12n);
    expect((await db.sql.query("SELECT * FROM agent_registry_events WHERE kind='wallet_change'")).rows).toHaveLength(1);
    client.code=async()=> '0x02';
    await expect(collector.scan(9n,9n)).rejects.toThrow('bytecode mismatch');
    expect(await collector.coverage()).toMatchObject({walletChangeEvents:'supplied_verified_profiles'});
  });
  it('does not invent a registration from transfers; retroactive mint replay fills history',async()=>{
    logs=[makeLog(5,zero,owner),makeLog(8,owner,otherOwner)];const c=new AgentRegistryCollector(client,db,registry);
    await c.scan(8n,12n);expect((await db.sql.query('SELECT * FROM agent_registry')).rows).toHaveLength(0);
    await c.scan(0n,12n);expect((await db.sql.query('SELECT * FROM agent_registry')).rows).toHaveLength(2);
    await c.scan(0n,12n);expect((await db.sql.query('SELECT * FROM agent_registry')).rows).toHaveLength(2);
  });
  it('keeps zero wallets and burn withdrawal evidence without owner fallback',async()=>{
    logs=[makeLog(5,zero,owner),makeLog(8,owner,zero)];read.mockImplementation(async(ids:bigint[])=>ids.map(()=>({owner,wallet:zero,tokenUri:null})));
    const c=new AgentRegistryCollector(client,db,registry);await c.scan(0n,12n);await c.snapshot(12n);
    expect(await c.coverage()).toMatchObject({agents:1,nonzero_wallets:0});
    expect(read).toHaveBeenCalledTimes(1);
    expect(hex((await db.sql.query<{owner:Uint8Array}>('SELECT owner FROM agent_registry ORDER BY wallet_block DESC')).rows[0].owner)).toBe(zero);
  });
  it('stores a changed head wallet only from its pinned discovery cut',async()=>{
    logs=[makeLog(5,zero,owner)];const c=new AgentRegistryCollector(client,db,registry);await c.scan(0n,12n);
    await c.snapshot(12n);await c.snapshot(12n);
    expect((await db.sql.query<{wallet_block:string}>('SELECT wallet_block FROM agent_registry ORDER BY wallet_block')).rows.map(r=>String(r.wallet_block))).toEqual(['5','12']);
  });
  it('rolls back registry checkpoints and replays replacement fork observations',async()=>{
    logs=[makeLog(5,zero,owner),makeLog(8,owner,otherOwner)];const c=new AgentRegistryCollector(client,db,registry,{window:2});
    await c.scan(0n,12n);fork=1;logs[1]={...logs[1],blockHash:hash(8,1),transactionHash:hash(108,1)};
    await c.reconcile();expect(await db.cursor('agent_registry')).toBe(5n);
    expect((await db.sql.query('SELECT * FROM agent_registry')).rows).toHaveLength(1);
    await c.scan(6n,12n);expect(hex((await db.sql.query<{block_hash:Uint8Array}>('SELECT block_hash FROM agent_registry WHERE wallet_block=8')).rows[0].block_hash)).toBe(hash(8,1));
  });
  it('rejects removed, malformed, wrong-emitter and fork-changing inputs atomically',async()=>{
    const c=new AgentRegistryCollector(client,db,registry);
    logs=[{...makeLog(5,zero,owner),removed:true}];await expect(c.scan(0n,12n)).rejects.toThrow('canonical scope');
    logs=[{...makeLog(5,zero,owner),address:owner}];await expect(c.scan(0n,12n)).rejects.toThrow('canonical scope');
    logs=[{...makeLog(5,zero,owner),topics:[makeLog(5,zero,owner).topics[0]],data:'0x'}];await expect(c.scan(0n,12n)).rejects.toThrow();
    logs=[makeLog(5,zero,owner)];read.mockImplementation(async()=>{fork=1;return [{owner,wallet,tokenUri:null}];});
    await expect(c.scan(0n,12n)).rejects.toThrow('range changed');
    expect((await db.sql.query('SELECT * FROM agent_registry_events')).rows).toHaveLength(0);
  });
  it('propagates missing/partial reads without recording a zero wallet',async()=>{
    logs=[makeLog(5,zero,owner)];read.mockResolvedValue([]);
    await expect(new AgentRegistryCollector(client,db,registry).scan(0n,12n)).rejects.toThrow('Incomplete');
    expect((await db.sql.query('SELECT * FROM agent_registry')).rows).toHaveLength(0);
  });
});
