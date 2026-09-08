import { randomUUID } from 'node:crypto';
import { concat, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import type { Address, Hex } from 'viem';
import { canonicalize, createReceiptEncoder } from '@eko/shared';
import type { ReceiptItem } from '@eko/shared';
import type { ChainDb } from './client.js';
import { ReceiptOutbox } from './receipt-outbox.js';

const codec = createReceiptEncoder({ concat, encodeAbiParameters, keccak256, stringToHex });
export interface ReceiptBatch { id: string; root: Hex; items: ReceiptItem[]; proofs: Hex[][]; through: string }
export interface ReceiptCommitAttempt { tx_hash: Hex; batch_id: string; registry: Address; committer: Address; nonce: string; raw_transaction: Hex }
export interface ReceiptCommitAnchor { batchId: number; txHash: Hex; registry: Address; committer: Address; root: Hex; leafCount: number; blockNumber: string; blockHash: Hex; logIndex: number }

/** Database clock leases plus row locking fence every journal mutation. An expired
 * worker may only have an already persisted identical raw broadcast in flight. */
export class ReceiptCommitJournal {
  readonly owner = randomUUID();
  /**
   * Create worker identity and require an integer lease duration of at least one second. Receipts-
   * role construction only; invalid lease throws; ownership is acquired separately from the
   * database.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  constructor(readonly db: ChainDb, readonly leaseMs = 60000) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new Error('Invalid receipt lease');
  }
  /**
   * Acquire/renew the chain-4663 DB-clock lease only for this worker or after expiry; return false
   * when another owner holds it. Receipts role only; SQL failure rejects, no chain signer authority
   * is granted.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async acquire() {
    return (await this.db.sql.query(`UPDATE receipt_worker_lease SET owner=$1,lease_until=clock_timestamp()+$2*interval '1 millisecond'
      WHERE chain_id=4663 AND (owner=$1 OR lease_until<=clock_timestamp()) RETURNING owner`, [this.owner, this.leaseMs])).rows.length === 1;
  }
  /**
   * Renew an unexpired owned lease under a transaction lock before invoking the supplied mutation
   * callback. Receipts role only; lost lease throws and SQL/callback failures roll back/reject.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async fenced<T>(fn: (db: ChainDb) => Promise<T>) {
    return this.db.tx(async tx => {
      const rows = (await tx.sql.query(`UPDATE receipt_worker_lease SET lease_until=clock_timestamp()+$2*interval '1 millisecond'
        WHERE chain_id=4663 AND owner=$1 AND lease_until>clock_timestamp() RETURNING owner`, [this.owner, this.leaseMs])).rows;
      if (!rows.length) throw new Error('Receipt lease lost');
      return fn(tx);
    });
  }
  /**
   * Update receipt heartbeat through the fenced transaction. Receipts role only; lost lease or SQL
   * failure rejects instead of claiming liveness.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async heartbeat() { await this.fenced(tx => tx.sql.query('UPDATE receipt_worker_lease SET heartbeat_at=clock_timestamp() WHERE chain_id=4663')); }
  /**
   * Expire only this worker's matching lease. Host worker shutdown call; SQL failures reject and
   * another owner's lease is untouched.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async release() { await this.db.sql.query("UPDATE receipt_worker_lease SET owner='',lease_until=clock_timestamp() WHERE chain_id=4663 AND owner=$1", [this.owner]); }
  /**
   * Read persisted heartbeat age/missing status. Host/public operational read without wallet auth;
   * SQL failure rejects; this does not inspect the on-chain signer balance.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async health() { return (await this.db.sql.query<{ heartbeat_age_s: string; heartbeat_missing: boolean }>('SELECT * FROM receipt_commit_health WHERE chain_id=4663')).rows[0]!; }
  /**
   * Under a fenced lease, recover the earliest unanchored batch with root/proof integrity checks or
   * build/store a deterministic tree over unbatched items before the five-minute cutoff. Receipts
   * role only; invalid time, lost lease, tampered batch or SQL failure rejects, no items returns
   * null. Prepared ids are off-chain identities, not registry sequence ids.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async batch(now: number): Promise<ReceiptBatch | null> {
    if (!Number.isFinite(now)) throw new Error('Invalid receipt time');
    return this.fenced(async tx => {
      const outbox = new ReceiptOutbox(tx);
      const pending = (await tx.sql.query<{id:string;root:Hex;through:Date;leaf_count:number}>(`SELECT b.* FROM receipt_batches b WHERE b.chain_id=4663
        AND NOT EXISTS(SELECT 1 FROM receipt_commit_anchors a WHERE a.batch_id=b.id AND NOT EXISTS(
          SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id AND e.kind='orphaned')) ORDER BY b.recorded_at,b.id LIMIT 1`)).rows[0];
      if (pending) {
        const rows = (await tx.sql.query<{id:string;kind:ReceiptItem['kind']|null;proof:Hex[]}>(`SELECT i.receipt_id AS id,r.kind,i.proof FROM receipt_batch_items i
          LEFT JOIN receipt_items r ON r.id=i.receipt_id WHERE i.batch_id=$1 ORDER BY i.item_index`, [pending.id])).rows;
        const items: ReceiptItem[] = [];
        for (const row of rows) {
          if (row.kind === null) throw new Error('Receipt item integrity failure: selected item missing');
          items.push(await outbox.getItem(row.id,row.kind));
        }
        const tree = codec.buildReceiptTree(items);
        if (items.length !== pending.leaf_count || tree.root !== pending.root || canonicalize(tree.proofs) !== canonicalize(rows.map(r => r.proof))) throw new Error('Receipt batch integrity failure');
        return {id:pending.id,root:tree.root,items,proofs:tree.proofs,through:new Date(pending.through).toISOString()};
      }
      const through = new Date(Math.floor(now / 300000) * 300000).toISOString();
      const rows = (await tx.sql.query<{id:string;kind:ReceiptItem['kind']}>(`SELECT r.id,r.kind FROM receipt_items r WHERE r.chain_id=4663 AND r.recorded_at<$1
        AND NOT EXISTS(SELECT 1 FROM receipt_batch_items i WHERE i.receipt_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchors a WHERE a.receipt_id=r.id AND NOT EXISTS(
          SELECT 1 FROM guard_receipt_anchor_events e WHERE e.anchor_id=a.id)) ORDER BY r.recorded_at,r.id`, [through])).rows;
      if (!rows.length) return null;
      const items: ReceiptItem[] = [];
      for (const row of rows) items.push(await outbox.getItem(row.id,row.kind));
      const tree = codec.buildReceiptTree(items);
      const id = keccak256(stringToHex(canonicalize({chainId:4663,through,items})));
      await tx.sql.query('INSERT INTO receipt_batches VALUES($1,4663,$2,$3,$4,$5)', [id,tree.root,items.length,through,new Date(now)]);
      for (const [index,item] of items.entries()) await tx.sql.query('INSERT INTO receipt_batch_items VALUES($1,$2,$3,$4)', [id,item.id,index,JSON.stringify(tree.proofs[index])]);
      return {id,root:tree.root,items,proofs:tree.proofs,through};
    });
  }
  /**
   * Read the latest retained nonfailed signed attempt for the batch, or undefined. Receipts role
   * only; SQL failures reject. Caller must validate envelope and canonical inclusion before
   * broadcast/anchor.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async attempt(batch: ReceiptBatch) {
    return (await this.db.sql.query<ReceiptCommitAttempt>(`SELECT a.*,a.nonce::text AS nonce FROM receipt_commit_attempts a WHERE a.batch_id=$1
      AND NOT EXISTS(SELECT 1 FROM receipt_commit_failures f WHERE f.tx_hash=a.tx_hash)
      ORDER BY a.recorded_at,a.tx_hash DESC LIMIT 1`, [batch.id])).rows[0];
  }
  /**
   * Persist the signed attempt under the owned unexpired lease before broadcast. Receipts role
   * caller must validate its envelope; this store does not validate signatures/calldata. Lease loss
   * or SQL failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async saveAttempt(attempt: ReceiptCommitAttempt) {
    await this.fenced(tx => tx.sql.query(`INSERT INTO receipt_commit_attempts(tx_hash,batch_id,registry,committer,nonce,raw_transaction)
      VALUES($1,$2,$3,$4,$5,$6)`, [attempt.tx_hash,attempt.batch_id,attempt.registry,attempt.committer,attempt.nonce,attempt.raw_transaction]));
  }
  /**
   * Record a caller-verified finalized revert idempotently under the lease. Receipts role supplies
   * canonical block evidence; this store does not authenticate that evidence. Lease/SQL failure
   * rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async failed(attempt: ReceiptCommitAttempt, blockNumber: bigint, blockHash: Hex) {
    await this.fenced(tx => tx.sql.query('INSERT INTO receipt_commit_failures(tx_hash,block_number,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [attempt.tx_hash,String(blockNumber),blockHash]));
  }
  /**
   * Persist supplied authenticated inclusion under the lease, reject a conflicting active anchor and
   * notify after insertion without rewriting payloads. Receipts role must verify event/canonicality
   * first. Lost lease, conflicting data or SQL failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async anchor(batch: ReceiptBatch, data: ReceiptCommitAnchor) {
    await this.fenced(async tx => {
      const existing=(await tx.sql.query<{data:ReceiptCommitAnchor}>(`SELECT a.data FROM receipt_commit_anchors a WHERE a.batch_id=$1
        AND NOT EXISTS(SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id AND e.kind='orphaned')`,[batch.id])).rows[0];
      if (existing) {
        if (canonicalize(existing.data)!==canonicalize(data)) throw new Error('Receipt batch already anchored differently');
        return;
      }
      // Inclusion may disappear and later return in the very same block. Preserve
      // both observations instead of reusing an ID permanently marked orphaned.
      const id = randomUUID();
      await tx.sql.query('INSERT INTO receipt_commit_anchors(id,batch_id,tx_hash,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id,batch.id,data.txHash,JSON.stringify(data)]);
      await tx.sql.query("SELECT pg_notify('eko_receipt_committed',$1)", [JSON.stringify({batchId:data.batchId,txHash:data.txHash})]);
    });
  }
  /**
   * List anchors with no finalization/orphan observation. Receipts worker read without wallet auth;
   * SQL failures reject and no canonical chain reads occur here.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async unfinalized() {
    return (await this.db.sql.query<{id:string;data:ReceiptCommitAnchor}>(`SELECT a.id,a.data FROM receipt_commit_anchors a
      WHERE NOT EXISTS(SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id)`)).rows;
  }
  /**
   * Append an idempotent finalized/orphaned observation under the owned lease. Receipts role
   * supplies verified chain outcome; lease/SQL failures reject and immutable anchor facts remain.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async anchorEvent(id: string, kind: 'orphaned' | 'finalized') {
    await this.fenced(tx => tx.sql.query('INSERT INTO receipt_commit_anchor_events(anchor_id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING', [id,kind]));
  }
}
