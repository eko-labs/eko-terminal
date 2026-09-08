import { concat, decodeEventLog, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { canonicalize, createGuardReceiptCodec, GuardReceiptPayloadSchema, PublicReceiptPayloadSchema,
  ReceiptItemSchema, ReceiptLookupSchema, ReceiptSummarySchema, VerdictSchema } from '@eko/shared';
import type { ReceiptLookup } from '@eko/shared';
import registryAbi from '../../chain/abi/eko/ReceiptsRegistry.json' with { type: 'json' };
import type { ChainDb } from './client.js';
import type { GuardRegistryReader } from './guard-receipts.js';
import type { ReceiptCommitAnchor } from './receipt-committer.js';

const codec = createGuardReceiptCodec({ concat, encodeAbiParameters, keccak256, stringToHex });
export interface ReceiptRegistryReader extends Omit<GuardRegistryReader, 'getBlock'> {
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
}
interface ItemRow {
  id: string; producer: string; kind: 'verdict' | 'forecast' | 'harness_private'; chain_id: string;
  revision_id: string; payload_hash: Hex; canonical_payload: string | null; data: unknown; recorded_at: Date; leaf: Hex | null;
}
interface AnchorRow {
  data: ReceiptCommitAnchor & { receiptId?: string; payloadHash?: Hex }; proof: Hex[];
  root: Hex; leaf_count: number; tx_hash: Hex; registry: Address; committer: Address;
}

/** Read-only CA-16 adapter. Only retained original bytes can be revealed; no
 * journal/decryption or producer/committer mutation occurs on this path. */
export class ReceiptApiStore {
  /**
   * Wire read storage, configured registry, chain reader and reveal clock. Host-only construction;
   * no account auth, chain read or payload integrity check occurs until get.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  constructor(readonly db: ChainDb, readonly registry: Address | undefined,
    readonly reader: ReceiptRegistryReader, public now: () => number = Date.now) {}
  /**
   * Read a public item/commitment, authenticate canonical payload/leaf/revision and proof/anchor
   * bindings, and re-read chain 4663 successful transaction, matching registry event and canonical
   * block. Anonymous API read; missing id returns null, integrity/schema/RPC/SQL failures reject.
   * Forecast reveal starts from authenticated commit-block time; private journal payloads never
   * reveal.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async get(id: string): Promise<ReceiptLookup | null> {
    let row = (await this.db.sql.query<ItemRow>(`SELECT id,producer,kind,chain_id,revision_id,payload_hash,leaf,canonical_payload,data,recorded_at FROM receipt_items WHERE id=$1
      UNION ALL SELECT id,producer,kind,chain_id,revision_id,payload_hash,NULL,canonical_payload,data,recorded_at
      FROM receipt_publications WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM receipt_items WHERE id=$1)
      UNION ALL SELECT id,'guard','verdict',chain_id,revision_id,payload_hash,NULL,canonical_payload,data,recorded_at
      FROM guard_receipt_payloads WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM receipt_items WHERE id=$1)`, [id])).rows[0];
    if (!row) {
      const publication = (await this.db.sql.query<{ commitment: Hex; recorded_at: Date }>(
        'SELECT commitment,recorded_at FROM receipt_private_publications WHERE id=$1', [id])).rows[0];
      if (publication) {
        const data = { id, kind: 'harness_private' as const, hash: publication.commitment };
        row = { id, producer: 'harness', kind: data.kind, chain_id: '4663', revision_id: id, payload_hash: data.hash,
          leaf: null, canonical_payload: canonicalize(data), data, recorded_at: publication.recorded_at };
      }
    }
    if (!row) return null;
    const item = ReceiptItemSchema.parse({ id: row.id, kind: row.kind, hash: row.payload_hash });
    const leaf = codec.encodeReceiptLeaf(item);
    const archived=row.data==null && row.canonical_payload==null;
    if(archived && (row.producer!=='engines' || row.kind!=='verdict'))throw new Error('Receipt archived header integrity failure');
    if (Number(row.chain_id) !== 4663 || (row.leaf !== null && row.leaf !== leaf)
      || (!archived && canonicalize(row.data) !== row.canonical_payload)) throw new Error('Receipt integrity failure');
    let durationSec = 0;
    if (item.kind === 'harness_private') {
      if (row.producer !== 'harness' || row.revision_id !== id || row.canonical_payload !== canonicalize(item))
        throw new Error('Receipt commitment integrity failure');
    } else if (!archived) {
      if (!codec.verifyPayload(row.data, item)) throw new Error('Receipt payload integrity failure');
      const version = (row.data as { schemaVersion?: string }).schemaVersion;
      if (version === 'guard-receipt-2' || version === 'public-receipt-1') {
        const payload = version === 'guard-receipt-2' ? GuardReceiptPayloadSchema.parse(row.data) : PublicReceiptPayloadSchema.parse(row.data);
        const chainId = 'chainId' in payload ? payload.chainId : payload.decision.chainId;
        if (payload.receiptId !== id || payload.kind !== item.kind || payload.revisionId !== row.revision_id
          || chainId !== 4663 || Date.parse(payload.recordedAt) !== new Date(row.recorded_at).getTime()
          || canonicalize(payload) !== row.canonical_payload) throw new Error('Receipt payload binding failure');
        if ('snapshotHash' in payload && codec.hash(payload.deterministicInput) !== payload.snapshotHash)
          throw new Error('Receipt snapshot integrity failure');
        if ('window' in payload && payload.window.kind === 'forecast') durationSec = payload.window.durationSec;
      } else {
        // Original V1 verdict bytes/levels are immutable, never reformatted as V2.
        if (item.kind === 'verdict') VerdictSchema.parse(row.data);
        else {
          // TODO(spec): No complete historical V1 forecast payload schema is
          // frozen. Require its original forecast-1/windowSec fields; never
          // infer a reveal window from recording time or presentation data.
          const legacy = row.data as { schemaVersion?: string; windowSec?: number };
          if (legacy.schemaVersion !== 'forecast-1' || !Number.isSafeInteger(legacy.windowSec) || legacy.windowSec! <= 0)
            throw new Error('Legacy forecast window unavailable');
          durationSec = legacy.windowSec!;
        }
      }
    }
    const summary=archived ? (await this.db.sql.query<{summary:unknown}>('SELECT summary FROM receipt_publications WHERE id=$1',[id])).rows[0]?.summary : undefined;
    const base = { ...item, leaf, canonicalization: 'jcs-rfc8785/v1' as const,
      ...(archived ? { payloadStatus:'expired' as const, ...(summary ? {summary:ReceiptSummarySchema.parse(summary)} : {}) } : {}) };
    const anchor = (await this.db.sql.query<AnchorRow>(`SELECT a.data,i.proof,b.root,b.leaf_count,a.tx_hash,t.registry,t.committer
      FROM receipt_batch_items i JOIN receipt_batches b ON b.id=i.batch_id
      JOIN receipt_commit_anchors a ON a.batch_id=b.id JOIN receipt_commit_attempts t ON t.tx_hash=a.tx_hash AND t.batch_id=b.id
      WHERE i.receipt_id=$1 AND NOT EXISTS(SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id AND e.kind='orphaned')
      ORDER BY a.recorded_at,a.id LIMIT 1`, [id])).rows[0]
      ?? (await this.db.sql.query<AnchorRow>(`SELECT a.data,a.data->'proof' AS proof,a.data->>'root' AS root,
        (SELECT count(DISTINCT receipt_id)::int FROM guard_receipt_anchors other WHERE other.data->>'txHash'=a.data->>'txHash'
          AND other.batch_id=a.batch_id AND other.data->>'root'=a.data->>'root') AS leaf_count,
        a.data->>'txHash' AS tx_hash,a.registry_address AS registry,a.data->>'committer' AS committer
        FROM guard_receipt_anchors a WHERE a.receipt_id=$1
        AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchor_events e WHERE e.anchor_id=a.id)
        ORDER BY a.recorded_at,a.id LIMIT 1`, [id])).rows[0];
    if (!anchor) return ReceiptLookupSchema.parse({ ...base, status: 'pending' });
    const a = anchor.data;
    if (!this.registry || anchor.registry.toLowerCase() !== this.registry.toLowerCase()
      || a.registry.toLowerCase() !== this.registry.toLowerCase() || a.txHash !== anchor.tx_hash
      || a.committer.toLowerCase() !== anchor.committer.toLowerCase() || a.root !== anchor.root
      || (a.leafCount !== undefined && a.leafCount !== anchor.leaf_count)
      || (a.receiptId !== undefined && (a.receiptId !== id || a.payloadHash !== item.hash))
      || !codec.verifyReceiptProof(item, anchor.proof, a.root)) throw new Error('Receipt anchor binding failure');
    if (await this.reader.getChainId() !== 4663) throw new Error('Receipt chain mismatch');
    const tx = await this.reader.getTransactionReceipt({ hash: a.txHash });
    const block = await this.reader.getBlock({ blockNumber: BigInt(a.blockNumber) });
    if (tx.status !== 'success' || tx.transactionHash !== a.txHash || String(tx.blockNumber) !== a.blockNumber
      || tx.blockHash !== a.blockHash || block.hash !== a.blockHash) throw new Error('Receipt anchor is not canonical');
    const matches = tx.logs.filter(log => {
      if (log.address.toLowerCase() !== this.registry!.toLowerCase() || log.removed || log.logIndex !== a.logIndex) return false;
      try {
        const event = decodeEventLog({ abi: registryAbi as Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
        const args = event.args as unknown as { batchId: bigint; root: Hex; leafCount: number; committer: Address };
        return event.eventName === 'BatchCommitted' && String(args.batchId) === String(a.batchId)
          && args.root === a.root && args.leafCount === anchor.leaf_count && args.committer.toLowerCase() === a.committer.toLowerCase();
      } catch { return false; }
    });
    if (matches.length !== 1) throw new Error('Receipt registry event mismatch');
    // Snapshot verdicts have no future window. Forecast time starts at the
    // authenticated commit block, never recordedAt or a prepared batch time.
    const reveal = !archived && item.kind !== 'harness_private' && this.now() >= (Number(block.timestamp) + durationSec) * 1000;
    return ReceiptLookupSchema.parse({ ...base, status: 'anchored', merkleRoot: a.root, proof: anchor.proof,
      batchId: a.batchId, txHash: a.txHash, block: Number(a.blockNumber), blockHash: a.blockHash,
      registry: this.registry, chainId: 4663, logIndex: a.logIndex,
      ...(reveal ? { revealed: row.data, canonicalPayload: row.canonical_payload } : {}),
    });
  }
}
