import { rpcPauseRetryAt } from '@eko/chain';
import { decodeEventLog, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import type { Abi, Address, Hex, TransactionSerialized } from 'viem';
import { GuardReceiptStore, ReceiptCommitJournal, ReceiptOutbox } from '@eko/db';
import type { GuardRegistryReader, ReceiptBatch, ReceiptCommitAttempt, ReceiptCommitAnchor } from '@eko/db';
import registryAbi from '../../../../packages/chain/abi/eko/ReceiptsRegistry.json' with { type: 'json' };

export const receiptsAbi = registryAbi as Abi;
/**
 * Encode only registry commit(root,item count) calldata from the supplied batch. Receipts-role
 * preparation, no wallet auth or signing; ABI/argument errors throw. Leaf correctness is verified
 * by separate batch checks.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export const commitData = (batch: ReceiptBatch) => encodeFunctionData({abi:receiptsAbi,functionName:'commit',args:[batch.root,batch.items.length]});
type ReceiptTx = Awaited<ReturnType<GuardRegistryReader['getTransactionReceipt']>>;
export interface ReceiptChain {
  getChainId(): Promise<number>;
  receipt(hash: Hex): Promise<ReceiptTx | null>;
  block(number: bigint): Promise<Hex | null>;
  finalized(): Promise<bigint>;
  sign(batch: ReceiptBatch): Promise<ReceiptCommitAttempt>;
  broadcast(raw: Hex): Promise<Hex>;
}
export type ReceiptLog = (event: string, fields?: Record<string, unknown>) => void;

/** Validate the persisted envelope before *every* broadcast, including recovery.
 * This hot signer is restricted to commit calldata, zero value, configured registry
 * and chain. No user transaction or owner rotation action enters the adapter.
 * @remarks
 * Parse/recover the signed envelope and bind hash, off-chain batch id, registry/target, signer,
 * chain 4663, zero value, nonce and exact commit calldata. Receipts role only;
 * malformed/mismatched envelopes reject before any broadcast. This does not prove current on-chain
 * committer authority.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export async function validateCommitAttempt(attempt: ReceiptCommitAttempt, batch: ReceiptBatch, registry: Address) {
  const tx = parseTransaction(attempt.raw_transaction);
  const signer = await recoverTransactionAddress({serializedTransaction:attempt.raw_transaction as TransactionSerialized});
  if (keccak256(attempt.raw_transaction) !== attempt.tx_hash || attempt.batch_id !== batch.id
    || attempt.registry.toLowerCase() !== registry.toLowerCase() || tx.to?.toLowerCase() !== registry.toLowerCase()
    || signer.toLowerCase() !== attempt.committer.toLowerCase() || tx.chainId !== 4663
    || (tx.value ?? 0n) !== 0n || String(tx.nonce) !== attempt.nonce || tx.data !== commitData(batch))
    throw new Error('Receipt commit envelope mismatch');
}
/**
 * Require successful transaction/hash and exactly one nonremoved registry BatchCommitted log
 * matching root/count/signer and representable positive id. Receipts role only; mismatch/malformed
 * evidence throws. Caller separately checks chain and canonical block; this function alone does
 * not make RPC reads.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export function authenticateCommit(tx: ReceiptTx, attempt: ReceiptCommitAttempt, batch: ReceiptBatch): ReceiptCommitAnchor {
  if (tx.status !== 'success' || tx.transactionHash !== attempt.tx_hash) throw new Error('Receipt transaction mismatch');
  const matches: ReceiptCommitAnchor[] = [];
  for (const log of tx.logs) {
    if (log.address.toLowerCase() !== attempt.registry.toLowerCase() || log.removed || log.logIndex === null) continue;
    try {
      const event = decodeEventLog({abi:receiptsAbi,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
      if (event.eventName !== 'BatchCommitted') continue;
      const args = event.args as unknown as {batchId:bigint;root:Hex;leafCount:number;committer:Address};
      if (args.root !== batch.root || args.leafCount !== batch.items.length || args.committer.toLowerCase() !== attempt.committer.toLowerCase()
        || args.batchId <= 0n || args.batchId > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      matches.push({batchId:Number(args.batchId),txHash:tx.transactionHash,registry:attempt.registry,committer:args.committer,
        root:args.root,leafCount:args.leafCount,blockNumber:String(tx.blockNumber),blockHash:tx.blockHash,logIndex:log.logIndex});
    } catch { /* Malformed/unrelated logs cannot authenticate our transaction. */ }
  }
  if (matches.length !== 1) throw new Error('Exactly one matching BatchCommitted event required');
  return matches[0]!;
}

export class ReceiptWorker {
  private stopped = false;
  private wake?: () => void;
  private ticking = false;
  /**
   * Wire the receipts-owned journal, restricted chain/signing adapter, configured registry and
   * clocks/logger. Host construction only; no lease, signing or broadcast starts until tick/run and
   * dependencies are not authenticated here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  constructor(readonly journal: ReceiptCommitJournal, readonly chain: ReceiptChain, readonly registry: Address,
    readonly log: ReceiptLog = () => {}, readonly now: () => number = Date.now) {}
  /**
   * Request stop and wake its poll delay. Receipts operator only; an already dispatched persisted
   * transaction may still land and remains subject to recovery.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  stop() { this.stopped = true; this.wake?.(); }
  private async refresh() {
    const anchors = await this.journal.unfinalized();
    const finalized = anchors.length ? await this.chain.finalized() : 0n;
    for (const anchor of anchors) {
      const hash = await this.chain.block(BigInt(anchor.data.blockNumber));
      if (!hash) throw new Error('Canonical receipt block unavailable');
      if (hash !== anchor.data.blockHash) await this.journal.anchorEvent(anchor.id,'orphaned');
      else if (BigInt(anchor.data.blockNumber) <= finalized) await this.journal.anchorEvent(anchor.id,'finalized');
    }
    // Honor anchors written before 080 without changing Guard's immutable bytes.
    const reader: GuardRegistryReader = {
      getChainId: () => this.chain.getChainId(),
      getBlock: async ({blockNumber}) => ({hash:await this.chain.block(blockNumber)}),
      getTransactionReceipt: async ({hash}) => {const tx=await this.chain.receipt(hash);if (!tx) throw new Error('Receipt unavailable');return tx;},
    };
    await this.journal.fenced(tx => new GuardReceiptStore(tx).refreshAnchors(reader,4663,new Date(this.now()).toISOString()));
  }
  private async rebroadcast(attempt: ReceiptCommitAttempt) {
    if (this.stopped) return;
    // Renew/check ownership immediately before dispatch. A stalled owner can
    // only send the identical already-journaled transaction after expiry.
    await this.journal.fenced(async () => {});
    if (await this.chain.broadcast(attempt.raw_transaction) !== attempt.tx_hash) throw new Error('Broadcast hash mismatch');
    this.log('receipt_pending',{txHash:attempt.tx_hash});
  }
  /**
   * Acquire the DB lease, require chain 4663, refresh anchors, recover bounded publications and
   * validate every retained signed envelope before broadcast or canonical event anchoring. Receipts
   * operator supplies restricted signer/provider. Concurrent/stopped tick does nothing;
   * lease/provider/integrity failures reject. Missing receipts reuse identical stored bytes; only
   * finalized reverts permit a new attempt.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      if (!await this.journal.acquire()) return;
      if (await this.chain.getChainId() !== 4663) throw new Error('Receipt chain mismatch');
      await this.refresh();
      // Bound each poll; backlog continues on subsequent polls without an unsafe cursor.
      await this.journal.fenced(tx => new ReceiptOutbox(tx).recover(100));
      const batch = await this.journal.batch(this.now());
      if (!batch) { await this.journal.heartbeat();return; }
      let attempt = await this.journal.attempt(batch);
      if (!attempt) {
        if (this.stopped) return;
        attempt = await this.chain.sign(batch);
        await validateCommitAttempt(attempt,batch,this.registry);
        await this.journal.saveAttempt(attempt);
      }
      await validateCommitAttempt(attempt,batch,this.registry);
      // Never infer failure from a missing receipt, timeout, rotation or nonce.
      // Recovery checks the exact hash first; a resend uses the same signed bytes.
      const receipt = await this.chain.receipt(attempt.tx_hash);
      if (receipt) {
        if (receipt.transactionHash !== attempt.tx_hash) throw new Error('Receipt hash mismatch');
        const canonical = await this.chain.block(receipt.blockNumber);
        if (!canonical) throw new Error('Canonical receipt block unavailable');
        if (canonical !== receipt.blockHash) {await this.rebroadcast(attempt);return;}
        if (receipt.status === 'reverted') {
          // TODO(spec): No confirmation depth is specified. Successful canonical inclusion is
          // provisional until finalized; only finalized reverts permit a new signed attempt.
          if (receipt.blockNumber <= await this.chain.finalized()) await this.journal.failed(attempt,receipt.blockNumber,receipt.blockHash);
          throw new Error('Receipt commit reverted');
        }
        const anchor = authenticateCommit(receipt,attempt,batch);
        await this.journal.anchor(batch,anchor);
        const lag = (await this.journal.db.sql.query<{lag:string}>(`SELECT EXTRACT(EPOCH FROM clock_timestamp()-r.recorded_at) AS lag
          FROM receipt_items r JOIN receipt_batch_items i ON i.receipt_id=r.id WHERE i.batch_id=$1 ORDER BY r.recorded_at LIMIT 1`, [batch.id])).rows[0]!.lag;
        this.log('receipt_committed',{batchId:anchor.batchId,txHash:anchor.txHash,blockNumber:anchor.blockNumber,root:anchor.root,leafCount:anchor.leafCount,'receipts.commit_lag_s':Number(lag)});
        await this.journal.heartbeat();
      } else await this.rebroadcast(attempt);
    } finally { this.ticking = false; }
  }
  /**
   * Poll until stop, report bounded tick errors and heartbeat absence, and release the worker lease
   * in finally. Receipts operator only; no user signing authority. Tick errors are logged for
   * retained-attempt recovery; health/lease-release SQL failures can reject the loop.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async run(pollMs = 10000) {
    try {
      while (!this.stopped) {
        let delay=pollMs;
        try { await this.tick(); }
        catch (error) {
          const retryAt=rpcPauseRetryAt(error);
          if(retryAt!==undefined)delay=Math.max(pollMs,retryAt-this.now());
          else this.log('receipt_worker_error',{action:'recover_persisted_transaction'});
        }
        const health = await this.journal.health();
        if (health.heartbeat_missing) this.log('receipt_heartbeat_missing',{alert:true,heartbeat_age_s:Number(health.heartbeat_age_s)});
        if (!this.stopped) await new Promise<void>(resolve => {
          const timer=setTimeout(() => {this.wake=undefined;resolve();},delay);
          this.wake=() => {clearTimeout(timer);this.wake=undefined;resolve();};
        });
      }
    } finally { await this.journal.release(); }
  }
}
