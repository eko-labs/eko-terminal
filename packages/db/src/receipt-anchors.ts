import type { Hex } from 'viem';
import type { ChainDb } from './client.js';
import type { ReceiptCommitAnchor } from './receipt-committer.js';

/** Current anchor facts are separate from immutable payloads and historical anchors.
 * @remarks
 * Read the earliest stored non-orphaned unified anchor for this receipt and attach its retained
 * proof. Internal receipt read without account auth; missing anchor returns undefined and SQL
 * failures reject. This helper does not perform live chain authentication.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export async function currentReceiptAnchor(db: ChainDb, id: string) {
  const row = (await db.sql.query<{ data: ReceiptCommitAnchor; proof: Hex[] }>(`SELECT a.data,i.proof FROM receipt_batch_items i
    JOIN receipt_commit_anchors a ON a.batch_id=i.batch_id WHERE i.receipt_id=$1
    AND NOT EXISTS(SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id AND e.kind='orphaned')
    ORDER BY a.recorded_at,a.id LIMIT 1`, [id])).rows[0];
  return row ? { ...row.data, proof: row.proof } : null;
}

