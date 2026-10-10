import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { canonicalize, createGuardReceiptCodec, ReceiptItemSchema, ReceiptLookupSchema } from '@eko/shared';
import type { PublicReceiptPayload } from '@eko/shared';
import { currentReceiptAnchor, publishReceipt, ReceiptCommitJournal, ReceiptOutbox } from '@eko/db';
import type { ReceiptBatch, ReceiptCommitAttempt, ReceiptRegistryReader } from '@eko/db';
import { commitData, ReceiptWorker, receiptsAbi } from '../../engines/src/receipts/worker.js';
import type { ReceiptChain } from '../../engines/src/receipts/worker.js';
import { verifyReceipt } from '../../../packages/receipts-verifier/src/index.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts } from '../src/db/schema.js';

const codec=createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex});
const registry=`0x${'ab'.repeat(20)}` as const;
class FixtureChain implements ReceiptChain {
  account=privateKeyToAccount(generatePrivateKey());
  signs=0; sent:Hex[]=[];
  canonical=codec.hash('fixture-commit-block');
  transactions=new Map<Hex,Awaited<ReturnType<ReceiptRegistryReader['getTransactionReceipt']>>>();
  batches=new Map<bigint,{root:Hex;leafCount:number;committer:Address}>();
  getChainId=async () => 4663;
  finalized=async () => 50n;
  block=async () => this.canonical;
  receipt=async (hash:Hex) => this.transactions.get(hash) ?? null;
  sign=async (batch:ReceiptBatch):Promise<ReceiptCommitAttempt> => {
    const nonce=this.signs++;
    const raw=await this.account.signTransaction({chainId:4663,nonce,to:registry,data:commitData(batch),value:0n,gas:200000n,gasPrice:1n});
    return {batch_id:batch.id,tx_hash:keccak256(raw),registry,committer:this.account.address,nonce:String(nonce),raw_transaction:raw};
  };
  broadcast=async (raw:Hex) => {this.sent.push(raw);return keccak256(raw);};
  confirm(batch:ReceiptBatch, attempt:ReceiptCommitAttempt, batchId:bigint) {
    this.batches.set(batchId,{root:batch.root,leafCount:batch.items.length,committer:attempt.committer});
    this.transactions.set(attempt.tx_hash,{transactionHash:attempt.tx_hash,status:'success',blockNumber:50n,blockHash:this.canonical,logs:[{
      address:registry,topics:encodeEventTopics({abi:receiptsAbi,eventName:'BatchCommitted',args:{batchId,root:batch.root,committer:attempt.committer}}) as Hex[],
      data:encodeAbiParameters([{type:'uint32'}],[batch.items.length]),logIndex:3,
    }]});
  }
}
function payload(id:string, recordedAt:string, forecast=false):PublicReceiptPayload {
  const input={status:'observed',quantity:'900719925474099312345'};
  return {schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:id,revisionId:id,
    kind:forecast?'forecast':'verdict',chainId:4663,coin:registry,recordedAt,modelIds:forecast?['fixture-model']:[],
    personaSetVersion:forecast?'fixture-personas':null,cardSchemaVersion:'fixture-card-1',rulesVersion:'fixture-rules-1',
    outputSchemaVersion:forecast?'forecast-1':'verdict-1',snapshotHash:codec.hash(input),deterministicInput:input,decision:{level:'pending'},
    window:forecast?{kind:'forecast',startsAt:'commit_block',durationSec:3600}:{kind:'snapshot',blockNumber:1,blockHash:codec.hash('fixture-source')},
    supersedes:null,reorgOf:null};
}
let built:Awaited<ReturnType<typeof buildApp>>,dir:string;
beforeAll(async () => {
  dir=await mkdtemp(join(tmpdir(),'eko-mixed-receipts-'));
  const path=join(dir,'destruction.log');await writeFile(path,'eko-journal-destruction-v1\n',{mode:0o600});
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',LEGACY_API:'false',
    SESSION_SECRET:'fixture-receipt-placeholder'.repeat(2),HARNESS_KEY_PEPPER:'fixture-key-placeholder'.repeat(2),
    JOURNAL_KEK:randomBytes(32).toString('hex'),JOURNAL_KEK_ID:'fixture-kek-v1',JOURNAL_TOMBSTONE_PATH:path,
    RECEIPTS_REGISTRY_ADDRESS:registry}),{startBackground:false});
});
afterAll(async () => {vi.restoreAllMocks();await built?.close();if(dir)await rm(dir,{recursive:true,force:true});});

it('journals an opted-in private entry, anchors a mixed batch, recovers after restart and advances later public batches with commitment-only private output', async () => {
  const db=built.ctx.dbh.chain,chain=new FixtureChain();
  const [account]=await built.ctx.dbh.db.insert(accounts).values({kind:'wallet'}).returning();
  const agent=await built.ctx.harness.create(account!.id,{name:'Sample agent',kind:'other',preset:'balanced'},10);
  await built.ctx.journal.setConsent(account!.id,true);
  const entry=await built.ctx.journal.append(account!.id,agent.id,{kind:'note',payload:{text:'private-fixture-note'},share:false});
  const privateItem=ReceiptItemSchema.parse({id:entry.id,kind:'harness_private',hash:entry.commitment});
  const verdict=payload('mixed-verdict',entry.ts),forecast=payload('mixed-forecast',entry.ts,true);
  await publishReceipt(db,'fixture-verdict-producer',verdict);await publishReceipt(db,'fixture-forecast-producer',forecast);
  let now=(Math.floor(Date.parse(entry.ts)/300000)+1)*300000;
  const through=new Date(now).toISOString(),outbox=new ReceiptOutbox(db),log=vi.fn();
  vi.spyOn(built.ctx.receipts.reader,'getChainId').mockImplementation(chain.getChainId);
  vi.spyOn(built.ctx.receipts.reader,'getTransactionReceipt').mockImplementation(async ({hash}) => {
    const tx=await chain.receipt(hash);if(!tx)throw new Error('Unknown fixture transaction');return tx;
  });
  vi.spyOn(built.ctx.receipts.reader,'getBlock').mockImplementation(async () => ({hash:chain.canonical,timestamp:BigInt(now/1000)}));
  built.ctx.receipts.now=() => now;
  const get=async (id:string) => {
    const response=await built.app.inject({url:`/v1/receipts/${encodeURIComponent(id)}`});
    expect(response.statusCode,response.body).toBe(200);return ReceiptLookupSchema.parse(response.json());
  };
  expect(await get(entry.id)).toEqual({id:entry.id,kind:'harness_private',hash:entry.commitment,
    leaf:codec.encodeReceiptLeaf(privateItem),canonicalization:'jcs-rfc8785/v1',status:'pending'});
  let journal=new ReceiptCommitJournal(db),worker=new ReceiptWorker(journal,chain,registry,log,() => now);
  await worker.tick();
  const batch=(await journal.batch(now))!,attempt=(await journal.attempt(batch))!;
  const items=[privateItem,
    {id:verdict.receiptId,kind:verdict.kind,hash:codec.hash(verdict)},{id:forecast.receiptId,kind:forecast.kind,hash:codec.hash(forecast)}]
    .sort((a,b) => a.id.localeCompare(b.id));
  const tree=codec.buildReceiptTree(items);
  expect(batch).toEqual({id:keccak256(stringToHex(canonicalize({chainId:4663,through,items}))),root:tree.root,items,proofs:tree.proofs,through});
  expect(chain.signs).toBe(1);expect(chain.sent).toEqual([attempt.raw_transaction]);
  for (const [index,item] of batch.items.entries()) {
    const stored=(await db.sql.query<{leaf:Hex}>('SELECT leaf FROM receipt_items WHERE id=$1',[item.id])).rows[0]!;
    expect(stored.leaf).toBe(tree.leaves[index]);
    expect(codec.verifyReceiptProof(item,batch.proofs[index]!,batch.root)).toBe(true);
  }
  expect(await outbox.get(entry.id)).toBeNull();expect(await outbox.getPrivate(entry.id)).toEqual(items.find(i => i.kind==='harness_private'));
  // Restart with the signed mixed batch still pending: recovery must use the same validated items.
  worker.stop();await journal.release();journal=new ReceiptCommitJournal(db);worker=new ReceiptWorker(journal,chain,registry,log,() => now);
  expect(await journal.acquire()).toBe(true);expect(await journal.batch(now)).toEqual(batch);
  chain.confirm(batch,attempt,1n);await worker.tick();expect(chain.signs).toBe(1);
  for (const [index,item] of batch.items.entries()) {
    const result=await get(item.id);
    expect(result).toMatchObject({status:'anchored',leaf:tree.leaves[index],merkleRoot:batch.root,proof:batch.proofs[index],batchId:1,txHash:attempt.tx_hash});
  }
  const privateResult=await get(entry.id);
  expect(privateResult).not.toHaveProperty('revealed');expect(privateResult).not.toHaveProperty('canonicalPayload');
  const verified=await verifyReceipt(privateResult,registry,{
    ...built.ctx.receipts.reader, getChainId:chain.getChainId,
    getTransactionReceipt:({hash}) => built.ctx.receipts.reader.getTransactionReceipt({hash}),
    getBlock:async () => ({hash:chain.canonical}),
    readContract:async ({args}) => chain.batches.get(args[0]),
  });
  expect(verified.status).toBe('commitment');expect(verified.steps.map(s => s.status)).toEqual(['commitment','passed','passed']);
  const publication=(await db.sql.query<{data:unknown;canonical_payload:string}>('SELECT * FROM receipt_items WHERE id=$1',[entry.id])).rows;
  expect(publication[0]!.data).toEqual({id:entry.id,kind:'harness_private',hash:entry.commitment});
  expect(publication[0]!.canonical_payload).toBe(canonicalize(publication[0]!.data));
  expect(JSON.stringify(privateResult)).not.toMatch(/salt|payload|account|agent|journal|ciphertext/i);
  for (const output of [privateResult,verified,batch,publication,log.mock.calls]) {
    expect(JSON.stringify(output)).not.toMatch(/private-fixture-note|salt|ciphertext/i);
    expect(JSON.stringify(output)).not.toContain(account!.id);expect(JSON.stringify(output)).not.toContain(agent.id);
  }
  // A second process starts after anchoring and handles the next public window.
  worker.stop();await journal.release();journal=new ReceiptCommitJournal(db);worker=new ReceiptWorker(journal,chain,registry,log,() => now);
  const later=payload('later-public-verdict',through);await publishReceipt(db,'fixture-verdict-producer',later);
  await worker.tick();expect(chain.signs).toBe(1);expect((await get(later.receiptId)).status).toBe('pending');
  now+=300000;await worker.tick();
  const next=(await journal.batch(now))!,nextAttempt=(await journal.attempt(next))!;
  expect(next.items).toEqual([{id:later.receiptId,kind:'verdict',hash:codec.hash(later)}]);
  expect(codec.verifyReceiptProof(next.items[0]!,next.proofs[0]!,next.root)).toBe(true);
  chain.confirm(next,nextAttempt,2n);await worker.tick();
  expect(chain.signs).toBe(2);expect((await get(later.receiptId)).status).toBe('anchored');
  expect(await currentReceiptAnchor(db,later.receiptId)).toMatchObject({batchId:2,txHash:nextAttempt.tx_hash});
  expect(await get(entry.id)).toEqual(privateResult);expect(await journal.batch(now)).toBeNull();
  expect((await db.sql.query('SELECT * FROM receipt_batches')).rows).toHaveLength(2);
  await journal.release();
});
