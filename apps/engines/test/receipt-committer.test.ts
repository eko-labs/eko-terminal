import { RpcGuardError } from '@eko/chain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { concat, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { canonicalize, createGuardReceiptCodec, GuardReceiptPayloadSchema, GuardAssessmentV2Schema } from '@eko/shared';
import type { PublicReceiptPayload, ReceiptItem } from '@eko/shared';
import { migrate, migrateEngines, publishReceipt, publishPrivateReceipt, ReceiptCommitJournal, ReceiptOutbox, currentReceiptAnchor, GuardSourceStore, GuardVerdictStore, GuardReceiptStore, guardManifestId } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { ChainDb, GuardRegistryReader, ReceiptBatch, ReceiptCommitAttempt } from '@eko/db';
import { authenticateCommit, commitData, ReceiptWorker, receiptsAbi, validateCommitAttempt } from '../src/receipts/worker.js';
import type { ReceiptChain } from '../src/receipts/worker.js';

const codec=createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex});
const registry=`0x${'ab'.repeat(20)}` as Address, at='2026-10-02T00:00:00.000Z', now=Date.parse('2026-10-02T00:05:00.000Z');
const hash=(s:string) => keccak256(stringToHex(s));
const databases: ChainDb[]=[];
afterEach(async () => {vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db => db.close()));});
function payload(id:string, overrides:Partial<PublicReceiptPayload>={}):PublicReceiptPayload {
  const input={quantity:'900719925474099312345',status:'observed'};
  return {schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:id,revisionId:id,kind:'verdict',chainId:4663,
    coin:registry,recordedAt:at,modelIds:[],personaSetVersion:null,cardSchemaVersion:'fixture-card-1',rulesVersion:'fixture-rules-1',outputSchemaVersion:'verdict-1',
    snapshotHash:codec.hash(input),deterministicInput:input,decision:{level:'pending'},window:{kind:'snapshot',blockNumber:1,blockHash:hash('source')},supersedes:null,reorgOf:null,...overrides};
}
class FixtureChain implements ReceiptChain {
  account=privateKeyToAccount(generatePrivateKey());
  nonce=0; signs=0; sent:Hex[]=[]; attempts:ReceiptCommitAttempt[]=[];
  receipts=new Map<Hex,Awaited<ReturnType<GuardRegistryReader['getTransactionReceipt']>>>();
  canonical=hash('commit-block'); final=0n; unavailable=false; broadcastFailure=false;
  getChainId=async () => 4663;
  finalized=async () => this.final;
  block=async () => this.unavailable ? null : this.canonical;
  receipt=async (txHash:Hex) => {if (this.unavailable) throw new Error('fixture RPC failure');return this.receipts.get(txHash) ?? null;};
  sign=async (batch:ReceiptBatch) => {
    this.signs++;
    const raw=await this.account.signTransaction({chainId:4663,nonce:this.nonce++,to:registry,data:commitData(batch),value:0n,gas:200000n,gasPrice:1n});
    const attempt={tx_hash:keccak256(raw),batch_id:batch.id,registry,committer:this.account.address,nonce:String(this.nonce-1),raw_transaction:raw};
    this.attempts.push(attempt);return attempt;
  };
  broadcast=async (raw:Hex) => {this.sent.push(raw);if (this.broadcastFailure) throw new Error('fixture lost broadcast response');return keccak256(raw);};
  confirmation(batch:ReceiptBatch, attempt:ReceiptCommitAttempt, batchId=17n, committer=attempt.committer) {
    return {transactionHash:attempt.tx_hash,status:'success' as const,blockNumber:50n,blockHash:this.canonical,logs:[{
      address:registry,topics:encodeEventTopics({abi:receiptsAbi,eventName:'BatchCommitted',args:{batchId,root:batch.root,committer}}) as Hex[],
      data:encodeAbiParameters([{type:'uint32'}],[batch.items.length]),logIndex:3,
    }]};
  }
}
async function setup(id='fixture-receipt') {
  const db=await openDb({pgliteDir:':memory:'});databases.push(db);await migrate(db);await migrateEngines(db);
  await publishReceipt(db,'fixture-producer',payload(id));
  const journal=new ReceiptCommitJournal(db),chain=new FixtureChain(),log=vi.fn();
  const worker=new ReceiptWorker(journal,chain,registry,log,() => now);
  return {db,journal,chain,worker,log};
}
async function pending(f:Awaited<ReturnType<typeof setup>>) {
  await f.worker.tick();const batch=(await f.journal.batch(now))!,attempt=(await f.journal.attempt(batch))!;
  return {batch,attempt};
}
describe('080 synthetic committer, no chain access', () => {
  it('rejects missing selected public/private items before signing, including stored-batch recovery', async () => {
    const f=await setup('missing-public');
    await publishPrivateReceipt(f.db,'missing-private',hash('fixture-commitment'),at);
    const publicRead=vi.spyOn(ReceiptOutbox.prototype,'get').mockResolvedValueOnce(null);
    await expect(f.worker.tick()).rejects.toThrow('Receipt item integrity failure: selected item missing');
    publicRead.mockRestore();
    const privateRead=vi.spyOn(ReceiptOutbox.prototype,'getPrivate').mockResolvedValueOnce(null);
    await expect(f.worker.tick()).rejects.toThrow('Receipt item integrity failure: selected item missing');
    privateRead.mockRestore();
    expect(f.chain.signs).toBe(0);
    expect((await f.db.sql.query('SELECT * FROM receipt_batches')).rows).toEqual([]);
    const batch=(await f.journal.batch(now))!;
    for (const method of ['get','getPrivate'] as const) {
      const read=vi.spyOn(ReceiptOutbox.prototype,method).mockResolvedValueOnce(null);
      await expect(f.worker.tick()).rejects.toThrow('Receipt item integrity failure: selected item missing');
      read.mockRestore();
    }
    expect(f.chain.signs).toBe(0);
    expect(await f.journal.batch(now)).toEqual(batch);
    await f.worker.tick();expect(f.chain.signs).toBe(1);
  });
  it('refuses every fenced journal mutation from a worker without the active lease', async () => {
    const f=await setup('foreign-worker');
    const {batch,attempt}=await pending(f);
    const foreign=new ReceiptCommitJournal(f.db);
    const anchor=authenticateCommit(f.chain.confirmation(batch,attempt),attempt,batch);
    for (const action of [
      () => foreign.heartbeat(), () => foreign.batch(now), () => foreign.saveAttempt(attempt),
      () => foreign.failed(attempt,50n,f.chain.canonical), () => foreign.anchor(batch,anchor),
      () => foreign.anchorEvent('00000000-0000-4000-8000-000000000001','orphaned'),
    ]) await expect(action()).rejects.toThrow('Receipt lease lost');
    const lease=await f.db.sql.query('SELECT owner,lease_until FROM receipt_worker_lease WHERE chain_id=4663');
    await foreign.release();
    expect((await f.db.sql.query('SELECT owner,lease_until FROM receipt_worker_lease WHERE chain_id=4663')).rows).toEqual(lease.rows);
    expect(await f.journal.acquire()).toBe(true);
    expect(await f.journal.attempt(batch)).toEqual(attempt);
    expect(await f.journal.unfinalized()).toEqual([]);
    expect((await f.db.sql.query('SELECT * FROM receipt_commit_failures')).rows).toEqual([]);
  });
  it('run rejects a foreign chain without signing or broadcasting and releases on shutdown', async () => {
    const f=await setup('foreign-chain');
    f.chain.getChainId=async () => 1;
    const worker=new ReceiptWorker(f.journal,f.chain,registry,(event) => {
      if (event==='receipt_worker_error') worker.stop();
    },() => now);
    await worker.run(1);
    expect(f.chain.signs).toBe(0);expect(f.chain.sent).toEqual([]);
    expect(await f.journal.unfinalized()).toEqual([]);
    expect(await new ReceiptCommitJournal(f.db).acquire()).toBe(true);
  });
  it('reproduces every frozen V1/V2 leaf and proof without altering the fixtures', () => {
    for (const name of ['v1','guard-v2']) {
      const fixture=JSON.parse(readFileSync(new URL(`../../../packages/shared/test/fixtures/receipts/${name}.json`,import.meta.url),'utf8'));
      const items:ReceiptItem[]=fixture.items.map((item:ReceiptItem) => ({id:item.id,kind:item.kind,hash:item.hash}));
      const tree=codec.buildReceiptTree(items);
      expect(tree.root).toBe(fixture.root);expect(tree.proofs).toEqual(fixture.proofs);
      expect(tree.leaves).toEqual(fixture.items.map((item:{leaf:Hex}) => item.leaf));
      items.forEach((item,index) => {expect(codec.verifyReceiptProof(item,tree.proofs[index]!,tree.root)).toBe(true);});
    }
  });
  it('seals only a completed window, stores exact proofs, excludes a second worker and binds the actual sequential event', async () => {
    const f=await setup();
    const early=new ReceiptWorker(f.journal,f.chain,registry,f.log,() => Date.parse(at)+299999);
    await early.tick();expect(f.chain.signs).toBe(0);
    const {batch,attempt}=await pending(f);
    expect(batch.items).toHaveLength(1);expect(batch.through).toBe('2026-10-02T00:05:00.000Z');
    expect(codec.verifyReceiptProof(batch.items[0]!,batch.proofs[0]!,batch.root)).toBe(true);
    const second=new ReceiptCommitJournal(f.db);
    await new ReceiptWorker(second,f.chain,registry).tick();expect(f.chain.signs).toBe(1);expect(await second.acquire()).toBe(false);
    await expect(second.fenced(async () => {})).rejects.toThrow('lease lost');
    f.chain.receipts.set(attempt.tx_hash,f.chain.confirmation(batch,attempt,23n));
    await f.worker.tick();
    const stored=(await new ReceiptOutbox(f.db).get(batch.items[0]!.id))!;
    expect(stored.receipt).toMatchObject({status:'anchored',batchId:23,txHash:attempt.tx_hash,root:batch.root,proof:batch.proofs[0]});
    expect(await currentReceiptAnchor(f.db,stored.item.id)).toMatchObject({committer:attempt.committer,blockNumber:'50',blockHash:f.chain.canonical,leafCount:1});
    expect(f.log).toHaveBeenCalledWith('receipt_committed',expect.objectContaining({'receipts.commit_lag_s':expect.any(Number)}));
    expect(stored.canonicalPayload).toBe(canonicalize(payload(stored.item.id)));
  });
  it('commits mixed immutable public, forecast and Guard payloads and exposes Guard anchors through its existing adapter', async () => {
    const f=await setup('mixed-public');
    await publishReceipt(f.db,'fixture-swarm',payload('mixed-forecast',{kind:'forecast',modelIds:['fixture-model'],personaSetVersion:'fixture-personas',
      window:{kind:'forecast',startsAt:'commit_block',durationSec:3600},outputSchemaVersion:'forecast-1'}));
    const fixture=JSON.parse(readFileSync(new URL('../../../packages/shared/test/fixtures/receipts/guard-v2.json',import.meta.url),'utf8'));
    const sample=GuardReceiptPayloadSchema.parse(fixture.items.find((item:{case:string}) => item.case==='exact-threshold').payload);
    const source={sourceId:'mixed-fixture',sourceRevision:codec.hash('mixed-source'),replayMode:'production' as const,
      cut:sample.decision.availabilityCut,watermark:sample.decision.cursor};
    const manifest=await new GuardSourceStore(f.db).putManifest({...source,id:guardManifestId(source),acquiredAt:at});
    const revision=await new GuardVerdictStore(f.db).putRevision({
      assessment:GuardAssessmentV2Schema.parse({...sample.decision,receipt:{status:'recorded',id:'internal-calculation',payloadHash:codec.hash(null)}}),
      deterministicInput:sample.deterministicInput,manifestId:manifest.id,sourceRevision:manifest.sourceRevision,context:sample.revisionKey.context,
      dependencyIds:[],recordedAt:at,runId:'mixed-run',
    });
    await publishReceipt(f.db,'fixture-producer',payload('next-window',{recordedAt:'2026-10-02T00:05:00.000Z'}));
    const {batch,attempt}=await pending(f);expect(batch.items).toHaveLength(3);
    f.chain.receipts.set(attempt.tx_hash,f.chain.confirmation(batch,attempt));await f.worker.tick();
    const guard=(await new GuardReceiptStore(f.db).get(revision.data.assessment.receipt.id))!;
    expect(guard.receipt).toMatchObject({status:'anchored',root:batch.root,txHash:attempt.tx_hash});
    expect(await new GuardReceiptStore(f.db).prepareBatch('2026-10-02T00:10:00.000Z')).toBeNull();
    const forecast=(await new ReceiptOutbox(f.db).get('mixed-forecast'))!;
    expect('window' in forecast.payload ? forecast.payload.window : null).toEqual({kind:'forecast',startsAt:'commit_block',durationSec:3600});
    expect(await currentReceiptAnchor(f.db,'mixed-forecast')).toMatchObject({blockNumber:'50'});
    expect((await new ReceiptOutbox(f.db).get('next-window'))!.receipt.status).toBe('recorded');
  });
  it('recovers a crash after intent persistence, then an accepted broadcast whose response was lost, and confirmation before restart', async () => {
    const f=await setup('restart');
    const save=vi.spyOn(f.journal,'saveAttempt');const real=f.journal.saveAttempt.bind(f.journal);
    save.mockImplementationOnce(async attempt => {await real(attempt);throw new Error('fixture crash after persistence');});
    await expect(f.worker.tick()).rejects.toThrow('crash');expect(f.chain.sent).toHaveLength(0);
    const batch=(await f.journal.batch(now))!,attempt=(await f.journal.attempt(batch))!;
    f.worker.stop();await f.journal.release();
    const journal=new ReceiptCommitJournal(f.db),restarted=new ReceiptWorker(journal,f.chain,registry,undefined,() => now);
    f.chain.broadcastFailure=true;
    await expect(restarted.tick()).rejects.toThrow('lost broadcast response');
    f.chain.broadcastFailure=false;await restarted.tick();
    expect(f.chain.signs).toBe(1);expect(f.chain.sent).toEqual([attempt.raw_transaction,attempt.raw_transaction]);
    f.chain.receipts.set(attempt.tx_hash,f.chain.confirmation(batch,attempt));
    restarted.stop();await journal.release();
    const last=new ReceiptWorker(new ReceiptCommitJournal(f.db),f.chain,registry,undefined,() => now);
    await last.tick();expect(f.chain.sent).toHaveLength(2);expect(await currentReceiptAnchor(f.db,'restart')).toMatchObject({txHash:attempt.tx_hash});
  });
  it('keeps pending identity across RPC failure and rotation; only a finalized revert permits a fresh key attempt', async () => {
    const f=await setup('rotation'),{batch,attempt}=await pending(f);
    f.chain.unavailable=true;await expect(f.worker.tick()).rejects.toThrow('fixture RPC failure');
    expect(f.chain.signs).toBe(1);expect(await f.journal.attempt(batch)).toMatchObject({tx_hash:attempt.tx_hash});
    f.chain.unavailable=false;f.chain.account=privateKeyToAccount(generatePrivateKey());
    await f.worker.tick();expect(f.chain.signs).toBe(1);expect(f.chain.sent.at(-1)).toBe(attempt.raw_transaction);
    const reverted={...f.chain.confirmation(batch,attempt),status:'reverted' as const,logs:[]};
    f.chain.receipts.set(attempt.tx_hash,reverted);
    await expect(f.worker.tick()).rejects.toThrow('reverted');expect(await f.journal.attempt(batch)).toBeDefined();
    f.chain.final=50n;await expect(f.worker.tick()).rejects.toThrow('reverted');expect(await f.journal.attempt(batch)).toBeUndefined();
    await f.worker.tick();expect(f.chain.signs).toBe(2);
    const next=(await f.journal.attempt(batch))!;expect(next.committer).toBe(f.chain.account.address);expect(next.tx_hash).not.toBe(attempt.tx_hash);
    f.chain.receipts.set(next.tx_hash,f.chain.confirmation(batch,next,99n));await f.worker.tick();
    expect(await currentReceiptAnchor(f.db,'rotation')).toMatchObject({batchId:99,committer:next.committer,txHash:next.tx_hash});
  });
  it('rejects junk roots/counts/emitters/committers, duplicates, wrong transactions and non-commit signed envelopes', async () => {
    const f=await setup('junk'),{batch,attempt}=await pending(f),tx=f.chain.confirmation(batch,attempt);
    const other=privateKeyToAccount(generatePrivateKey()).address;
    const bad=[{...tx,transactionHash:hash('other-transaction')},{...tx,logs:[{...tx.logs[0]!,address:other}]},
      f.chain.confirmation({...batch,root:hash('junk')},attempt),f.chain.confirmation({...batch,items:[...batch.items,...batch.items]},attempt),
      f.chain.confirmation(batch,attempt,18n,other),{...tx,logs:[...tx.logs,...tx.logs]},
      {...tx,logs:[{...tx.logs[0]!,removed:true}]},f.chain.confirmation(batch,attempt,0n)];
    for (const value of bad) expect(() => authenticateCommit(value,attempt,batch)).toThrow();
    f.chain.receipts.set(attempt.tx_hash,bad[4]!);await expect(f.worker.tick()).rejects.toThrow('BatchCommitted');
    expect(await currentReceiptAnchor(f.db,'junk')).toBeNull();expect(f.chain.signs).toBe(1);
    const raw=await f.chain.account.signTransaction({chainId:4663,nonce:2,to:other,value:1n,gas:21000n,gasPrice:1n});
    await expect(validateCommitAttempt({...attempt,raw_transaction:raw,tx_hash:keccak256(raw),nonce:'2'},batch,registry)).rejects.toThrow('envelope');
    await expect(validateCommitAttempt({...attempt,committer:other},batch,registry)).rejects.toThrow('envelope');
    const sent=[...f.chain.sent];
    f.chain.receipts.set(attempt.tx_hash,tx);
    vi.spyOn(f.journal,'attempt').mockResolvedValue({...attempt,committer:other});
    await expect(f.worker.tick()).rejects.toThrow('envelope');
    expect(f.chain.sent).toEqual(sent);
    expect(await currentReceiptAnchor(f.db,'junk')).toBeNull();
  });
  it('requeues an orphaned anchor with the same tree/transaction, preserves history, and stops rechecking finalized anchors', async () => {
    const f=await setup('reorg'),{batch,attempt}=await pending(f);
    f.chain.receipts.set(attempt.tx_hash,f.chain.confirmation(batch,attempt));await f.worker.tick();
    const bytes=(await new ReceiptOutbox(f.db).get('reorg'))!.canonicalPayload,originalBlock=f.chain.canonical;
    f.chain.unavailable=true;await expect(f.worker.tick()).rejects.toThrow('Canonical receipt block unavailable');
    expect(await currentReceiptAnchor(f.db,'reorg')).not.toBeNull();f.chain.unavailable=false;
    f.chain.canonical=hash('replacement-block');
    // Some providers retain an orphaned receipt: it must never be accepted,
    // but its presence cannot prevent an identical canonical rebroadcast.
    await f.worker.tick();
    f.chain.receipts.delete(attempt.tx_hash);await f.worker.tick();expect(await currentReceiptAnchor(f.db,'reorg')).toBeNull();
    expect(f.chain.signs).toBe(1);expect(f.chain.sent.at(-1)).toBe(attempt.raw_transaction);
    f.chain.receipts.set(attempt.tx_hash,f.chain.confirmation(batch,attempt,24n));await f.worker.tick();
    expect(await currentReceiptAnchor(f.db,'reorg')).toMatchObject({batchId:24,blockHash:f.chain.canonical});
    expect((await new ReceiptOutbox(f.db).get('reorg'))!.canonicalPayload).toBe(bytes);
    expect((await f.db.sql.query('SELECT * FROM receipt_commit_anchors')).rows).toHaveLength(2);
    f.chain.canonical=originalBlock;f.chain.receipts.set(attempt.tx_hash,f.chain.confirmation(batch,attempt));
    await f.worker.tick();expect(await currentReceiptAnchor(f.db,'reorg')).toMatchObject({blockHash:originalBlock,batchId:17});
    expect((await f.db.sql.query('SELECT * FROM receipt_commit_anchors')).rows).toHaveLength(3);
    f.chain.final=50n;await f.worker.tick();expect(await f.journal.unfinalized()).toHaveLength(0);
  });
  it('fences an expired worker, exposes two-window heartbeat alerts, and drains shutdown before releasing ownership', async () => {
    const f=await setup('lease-loss');await f.journal.acquire();
    await f.db.sql.query("UPDATE receipt_worker_lease SET lease_until=clock_timestamp()-interval '1 second',heartbeat_at=clock_timestamp()-interval '10 minutes'");
    const second=new ReceiptCommitJournal(f.db);expect(await second.acquire()).toBe(true);
    await expect(f.journal.fenced(async () => {})).rejects.toThrow('lease lost');
    expect((await second.health()).heartbeat_missing).toBe(true);
    await second.heartbeat();expect((await second.health()).heartbeat_missing).toBe(false);await second.release();
    const sign=f.chain.sign;
    f.chain.sign=async batch => {const attempt=await sign(batch);f.worker.stop();return attempt;};
    await f.worker.tick();expect(f.chain.sent).toHaveLength(0);
    await f.journal.release();expect(await second.acquire()).toBe(true);
    await new ReceiptWorker(second,f.chain,registry,undefined,() => now).tick();expect(f.chain.signs).toBe(1);expect(f.chain.sent).toHaveLength(1);
  });
});


it('sleeps the receipt worker until the provider retry and wakes promptly on stop',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1000);
  const release=vi.fn(async()=>{}),log=vi.fn();
  const journal={health:vi.fn(async()=>({heartbeat_missing:false})),release} as unknown as ReceiptCommitJournal;
  const worker=new ReceiptWorker(journal,{} as ReceiptChain,registry,log);
  const tick=vi.spyOn(worker,'tick').mockRejectedValueOnce(new RpcGuardError('provider_quota_exceeded','provider_quota_exceeded',true,61000))
    .mockImplementation(async()=>worker.stop());
  const running=worker.run(1000);
  try {
    await vi.advanceTimersByTimeAsync(59000);expect(tick).toHaveBeenCalledTimes(1);expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);await running;expect(tick).toHaveBeenCalledTimes(2);expect(release).toHaveBeenCalledOnce();
  }finally{worker.stop();await running;vi.useRealTimers();}
});
