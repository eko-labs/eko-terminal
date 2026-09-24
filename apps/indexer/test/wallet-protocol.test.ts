import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, hex, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadRegistry, RpcGuardError } from '@eko/chain';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex, type Address, type Hex } from 'viem';
import { collectWalletProtocol } from '../src/wallet-protocol.js';
import type { RemoteInputs } from '../src/decode.js';
import type { RpcBlock, RpcReceipt } from '../src/types.js';
import { BlockDecoder } from '../src/decode.js';
import { address, hash, cursor, at, traceFixture, fakeAcquisition, account, otherAccount, sponsor } from '../../../packages/chain/test/fixtures/trace-principals.js';
const registry=loadRegistry();
const handles:ChainDb[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(handles.splice(0).map(db=>db.close()));});
async function database(){const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);return db;}
const remote=():RemoteInputs=>({codes:new Map(),metadata:new Map(),pools:new Map(),rate:null});
function inputs(){
  const f=traceFixture();
  const block:RpcBlock={...f.rawBlock,number:f.rawBlock.number as Hex,hash:f.rawBlock.hash as Hex,timestamp:f.rawBlock.timestamp as Hex,parentHash:hash(122),transactions:[{...f.transaction,transactionIndex:f.transaction.transactionIndex as Hex}]};
  const receipts:RpcReceipt[]=[{...f.receipt,blockNumber:block.number,blockHash:block.hash,transactionIndex:f.receipt.transactionIndex as Hex,status:f.receipt.status as Hex,logs:f.receipt.logs.map(l=>({...l,logIndex:l.logIndex as Hex,topics:l.topics as [Hex,...Hex[]],blockNumber:block.number,blockHash:block.hash}))}];
  return {f,block,receipts};
}
const data=(row:Record<string,unknown>)=>JSON.parse(row.data as string);

describe('scoped wallet protocol evidence',()=>{
  it('stores independent operations and keeps sponsorship separate using 043 subtrees, without a new acquisition',async()=>{
    const {f,block,receipts}=inputs(),fake=fakeAcquisition(f.responses);
    const acquired=await fake.acquisition.acquire(cursor);
    const supplied={block:acquired,options:{at,entryPoints:f.profiles}};
    const result=await collectWalletProtocol(block,receipts,registry,remote(),supplied);
    const operations=result.rows.get('userops');
    expect(operations).toHaveLength(2);
    expect(operations.map(r=>hex(r.sender as Uint8Array))).toEqual([account,otherAccount]);
    expect(operations.map(r=>hex(r.paymaster as Uint8Array))).toEqual([sponsor,sponsor]);
    expect(operations.map(r=>r.nonce)).toEqual(['1','2']);
    expect(result.actors.get(`${f.transaction.hash}:1`)?.userOpSender).toBe(account);
    expect(result.actors.get(`${f.transaction.hash}:3`)?.userOpSender).toBe(otherAccount);
    expect(result.actors.get(`${f.transaction.hash}:2`)?.missing).toBe(true);
    expect(data(result.rows.get('wallet_protocol_coverage')[0]).bindings.filter((b:{logIndex:string})=>['1','3'].includes(b.logIndex)).map((b:{sender:string;operationHash:string})=>[b.sender,b.operationHash])).toEqual([[account,f.operationHashes[0]],[otherAccount,f.operationHashes[1]]]);
    await collectWalletProtocol(block,receipts,registry,remote(),supplied);
    expect(fake.requests).toHaveLength(4); // Existing 043 acquisition alone; protocol collection issues zero reads.
    await fake.meter.close();
  });
  it('persists raw unverified events and named deployment gaps without accepting sender or outer signer',async()=>{
    const {block,receipts}=inputs(),result=await collectWalletProtocol(block,receipts,registry,remote());
    expect(result.rows.get('userops')).toHaveLength(0);
    const coverage=data(result.rows.get('wallet_protocol_coverage')[0]);
    expect(coverage.rawProtocolLogs).toHaveLength(2);
    expect(coverage.entryPoints.every((p:{status:string})=>p.status==='registry_verified')).toBe(true);
    expect(coverage.holderAttribution.reason).toBe('unverified_entry_point');
    expect(coverage.userOperationEvents).toBe('missing_verified_events');
    expect(coverage.principalBindings).toBe('missing_043');
    expect([...result.actors.values()].every(a=>a.missing)).toBe(true);
  });
  it('accepts pinned events while leaving per-log execution missing when traces are absent',async()=>{
    const {f,block,receipts}=inputs();
    const result=await collectWalletProtocol(block,receipts,registry,remote(),{options:{at,entryPoints:f.profiles}});
    expect(result.rows.get('userops')).toHaveLength(2);
    expect([...result.actors.values()].every(a=>a.missing)).toBe(true);
    const expired=f.profiles.map(p=>({...p,effectiveUntil:{...cursor,blockNumber:'122'}}));
    expect((await collectWalletProtocol(block,receipts,registry,remote(),{options:{at,entryPoints:expired}})).rows.get('userops')).toHaveLength(0);
  });
  it('retains authorization signatures separately from changing completed delegation state, including revocation',async()=>{
    const {block}=inputs(),signer=privateKeyToAccount(hash(1));
    const signed=await signer.signAuthorization({contractAddress:address(33),chainId:4663,nonce:7});
    const authorization={chainId:toHex(signed.chainId),address:signed.address,nonce:toHex(signed.nonce),yParity:toHex(signed.yParity!),r:signed.r,s:signed.s};
    block.transactions[0]={hash:hash(11),from:address(12),to:signer.address,type:'0x4',authorizationList:[authorization]};
    const r=remote();r.codes.set(signer.address.toLowerCase(),`0xef0100${address(33).slice(2)}`);
    const result=await collectWalletProtocol(block,[],registry,r);
    const rows=result.rows.get('delegations_7702');
    expect(rows).toHaveLength(2);expect(hex(rows[0].authority as Uint8Array)).toBe(signer.address.toLowerCase());
    expect(rows[0].signature_valid).toBe(true);expect(data(rows[0]).effective).toBe('unknown');
    const invalid=structuredClone(block);
    // A scalar exceeding the curve's low-s limit must never become signature-valid evidence.
    invalid.transactions[0].authorizationList![0].s=`0x${'f'.repeat(64)}`;
    expect((await collectWalletProtocol(invalid,[],registry,r)).rows.get('delegations_7702')[0].signature_valid).toBe(false);
    expect(hex(rows[1].implementation as Uint8Array)).toBe(address(33));
    block.number='0x7c';block.hash=hash(124);block.transactions[0].hash=hash(22);
    r.codes.set(signer.address.toLowerCase(),'0x');
    const changed=await collectWalletProtocol(block,[],registry,r);
    expect(changed.rows.get('delegations_7702').find(row=>row.kind==='code')?.implementation).toBeNull();
    r.codeBlocks=new Map([[signer.address.toLowerCase(),123n]]);
    const stale=await collectWalletProtocol(block,[],registry,r);
    expect(stale.rows.get('delegations_7702').filter(row=>row.kind==='code')).toHaveLength(0);
    expect(data(stale.rows.get('wallet_protocol_coverage')[0]).code).toBe('missing_current_state');
  });
  it('does not treat receipt-only SetCode data or synthetic/missing receipts as full authorization coverage',async()=>{
    const {block,receipts}=inputs();block.transactionsComplete=false;block.transactions[0].type='0x4';
    const scoped=await collectWalletProtocol(block,receipts,registry,remote());
    expect(data(scoped.rows.get('wallet_protocol_coverage')[0]).authorizationList).toBe('missing');
    const missing=await collectWalletProtocol(block,[],registry,remote());
    expect(data(missing.rows.get('wallet_protocol_coverage')[0]).receipt).toBe('missing');
    receipts[0].synthetic=true;
    expect(data((await collectWalletProtocol(block,receipts,registry,remote())).rows.get('wallet_protocol_coverage')[0]).receipt).toBe('missing');
  });
  it('retains acquired calldata and transaction gas for Watcher, with scoped inputs explicitly missing',async()=>{
    const {block,receipts}=inputs();block.transactions[0].gas='0x186a0';receipts[0].gasUsed='0x13880';
    const full=await collectWalletProtocol(block,receipts,registry,remote());
    expect(data(full.rows.get('wallet_protocol_coverage')[0]).transaction).toEqual({input:block.transactions[0].input,gasLimit:'0x186a0',gasUsed:'0x13880'});
    block.transactionsComplete=false;
    const scoped=await collectWalletProtocol(block,receipts,registry,remote());
    expect(data(scoped.rows.get('wallet_protocol_coverage')[0]).transaction).toBeNull();
  });
  it('rejects mixed forks and duplicate receipts',async()=>{
    const {block,receipts}=inputs();
    await expect(collectWalletProtocol(block,[...receipts,...receipts],registry,remote())).rejects.toThrow('Duplicate');
    receipts[0].blockHash=hash(999);
    await expect(collectWalletProtocol(block,receipts,registry,remote())).rejects.toThrow('mismatch');
  });
  it('replays idempotently, retains improved coverage, and removes protocol evidence on canonical rollback',async()=>{
    const db=await database(),{f,block,receipts}=inputs();
    const missing=await collectWalletProtocol(block,receipts,registry,remote());
    const verified=await collectWalletProtocol(block,receipts,registry,remote(),{options:{at,entryPoints:f.profiles}});
    await db.tx(async tx=>{await missing.rows.flush(tx);await verified.rows.flush(tx);await verified.rows.flush(tx);});
    expect((await db.sql.query('SELECT * FROM userops')).rows).toHaveLength(2);
    expect((await db.sql.query('SELECT * FROM wallet_protocol_coverage')).rows).toHaveLength(2);
    await db.tx(tx=>tx.deleteAbove(122n));
    expect((await db.sql.query('SELECT * FROM userops')).rows).toHaveLength(0);
    expect((await db.sql.query('SELECT * FROM wallet_protocol_coverage')).rows).toHaveLength(0);
    await verified.rows.flush(db);
    expect((await db.sql.query('SELECT * FROM userops')).rows).toHaveLength(2);
    await migrate(db);
    expect((await db.sql.query("SELECT id FROM eko_indexer_migrations WHERE id='0136_wallet_protocol'")).rows).toHaveLength(1);
  });
  it('can stop storing wallet-protocol evidence while still attributing protocol actors',async()=>{
    const db=await database(),{f,block,receipts}=inputs();
    const decoder=new BlockDecoder({} as import('../src/types.js').ChainClient,registry);
    const options={remote:remote(),walletProtocol:{options:{at,entryPoints:f.profiles}}};
    const stored=await decoder.prepare(db,block,receipts,options);
    expect(stored.protocolRows.get('userops')).toHaveLength(2);
    decoder.storeWalletProtocol=false;
    const paused=await decoder.prepare(db,block,receipts,options);
    for(const table of ['userops','delegations_7702','wallet_protocol_coverage'] as const)expect(paused.protocolRows.get(table)).toHaveLength(0);
    expect([...paused.actors.keys()]).toEqual([...stored.actors.keys()]);
  });
  it('reuses the existing scoped code admission and propagates meter stops without extra reads',async()=>{
    const {block,receipts}=inputs(),code=vi.fn(async()=>{throw new RpcGuardError('rpc_session_budget_reached');});
    const client={code,tokenMetadata:vi.fn(),v3Pool:vi.fn()} as unknown as import('../src/types.js').ChainClient;
    const decoder=new BlockDecoder(client,registry);
    await expect(decoder.prefetch(block,receipts,{forceSenders:true})).rejects.toThrow();
    expect(code).toHaveBeenCalledTimes(1);expect(client.tokenMetadata).not.toHaveBeenCalled();
  });
});
