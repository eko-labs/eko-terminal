import { concat, decodeEventLog, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import registryAbi from '../../chain/abi/eko/ReceiptsRegistry.json' with { type: 'json' };
import { canonicalize, createGuardReceiptCodec, GuardReceiptPayloadSchema, ReceiptRefV2Schema, RECEIPT_BATCH_INTERVAL_SEC } from '@eko/shared';
import type { GuardReceiptPayload, ReceiptItem, ReceiptRefV2 } from '@eko/shared';
import { currentReceiptAnchor } from './receipt-anchors.js';
import type { ChainDb } from './client.js';

const codec = createGuardReceiptCodec({ concat, encodeAbiParameters, keccak256, stringToHex });
export interface PreparedGuardReceiptBatch { items: ReceiptItem[]; root: Hex; proofs: Hex[][]; through: string }
export interface GuardRegistryReader {
  getChainId(): Promise<number>;
  getTransactionReceipt(input: { hash: Hex }): Promise<{
    status: 'success' | 'reverted'; transactionHash: Hex; blockNumber: bigint; blockHash: Hex;
    logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number | null; removed?: boolean }[];
  }>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null }>;
}
interface Anchor { receiptId: string; payloadHash: Hex; root: Hex; batchId: number; proof: Hex[]; txHash: Hex;
  registry: Address; blockNumber: string; blockHash: Hex; logIndex: number; committer: Address }

/** Receipts-owned persistence adapter. No signer, network acquisition or anchor
 * submission runs implicitly. Registry address and chain must come from configuration. */
export class GuardReceiptStore {
  readonly writer = 'receipts';
  /**
   * Retain the receipts-role database adapter. Host-only construction; no payload/anchor mutation,
   * chain acquisition or authentication occurs here.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  constructor(readonly db: ChainDb) {}
  /** Called in the verdict transaction after allocating its immutable identity.
   * @remarks
   * Validate canonical Guard envelope/hashes and its already allocated revision binding, then
   * persist immutable payload bytes idempotently. Authorized verdict transaction caller only;
   * mismatch/reused identity or schema/SQL failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async record(raw: GuardReceiptPayload) {
    const payload=GuardReceiptPayloadSchema.parse(raw),canonicalPayload=canonicalize(payload),payloadHash=codec.hash(payload);
    if(!codec.verifyPayload(payload,{id:payload.receiptId,kind:'verdict',hash:payloadHash})) throw new Error('Invalid Guard receipt envelope');
    const revision=(await this.db.sql.query<{receipt_id:string;payload_hash:string}>('SELECT receipt_id,payload_hash FROM guard_verdict_revisions WHERE id=$1',[payload.revisionId])).rows[0];
    if(!revision || revision.receipt_id!==payload.receiptId || revision.payload_hash!==payloadHash) throw new Error('Guard receipt revision mismatch');
    await this.db.sql.query('INSERT INTO guard_receipt_payloads(id,revision_id,chain_id,payload_hash,canonical_payload,data,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
      [payload.receiptId,payload.revisionId,payload.decision.chainId,payloadHash,canonicalPayload,JSON.stringify(payload),payload.recordedAt]);
    const stored=(await this.db.sql.query<{canonical_payload:string}>('SELECT canonical_payload FROM guard_receipt_payloads WHERE id=$1',[payload.receiptId])).rows[0];
    if(stored.canonical_payload!==canonicalPayload)throw new Error('Guard receipt identity reused for different bytes');
  }
  /**
   * Read and validate original Guard payload bytes and attach stored active anchor
   * references/events. Public/internal read without wallet session; missing id returns null and
   * integrity/SQL failure rejects. Live canonicality must be checked by ReceiptApiStore before
   * public proof reliance.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async get(id: string): Promise<{ payload: GuardReceiptPayload; canonicalPayload: string; receipt: ReceiptRefV2; events: unknown[] } | null> {
    const row = (await this.db.sql.query<{ data: unknown; canonical_payload: string; payload_hash: Hex; revision_id: string }>(
      'SELECT * FROM guard_receipt_payloads WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    const payload = GuardReceiptPayloadSchema.parse(row.data);
    if (canonicalize(payload) !== row.canonical_payload || !codec.verifyPayload(payload, { id, kind: 'verdict', hash: row.payload_hash }))
      throw new Error('Stored Guard receipt integrity failure');
    const anchor = await currentReceiptAnchor(this.db,id) ?? (await this.db.sql.query<{ data: Anchor }>(`SELECT a.data FROM guard_receipt_anchors a WHERE a.receipt_id=$1
      AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchor_events e WHERE e.anchor_id=a.id) ORDER BY a.recorded_at,a.id LIMIT 1`, [id])).rows[0]?.data;
    const receipt = ReceiptRefV2Schema.parse(anchor ? { status: 'anchored', id, payloadHash: row.payload_hash,
      root: anchor.root, batchId: anchor.batchId, proof: anchor.proof, txHash: anchor.txHash }
      : { status: 'recorded', id, payloadHash: row.payload_hash });
    const events = (await this.db.sql.query<{data:unknown}>('SELECT data FROM guard_verdict_events WHERE target_id=$1 ORDER BY known_position,acquisition_sequence,id',[row.revision_id])).rows.map(r=>r.data);
    return { payload, canonicalPayload: row.canonical_payload, receipt, events };
  }
  /** Five-minute cadence, including unanchored backlog. This boundary is never
   * a batch ID. No public root/transaction reference exists until recordAnchor.
   * @remarks
   * Build a sorted tree over eligible unanchored Guard receipts before a validated five-minute
   * cutoff, including backlog. Receipts role only; invalid time or SQL failure rejects and empty
   * input returns null. No on-chain batch id or public anchor is created.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async prepareBatch(now: string): Promise<PreparedGuardReceiptBatch | null> {
    const millis = Date.parse(now);
    if (!Number.isFinite(millis)) throw new Error('Invalid receipt batch time');
    const through = new Date(Math.floor(millis / (RECEIPT_BATCH_INTERVAL_SEC * 1000)) * RECEIPT_BATCH_INTERVAL_SEC * 1000).toISOString();
    const rows = (await this.db.sql.query<{id:string;payload_hash:Hex}>(`SELECT p.id,p.payload_hash FROM guard_receipt_payloads p WHERE p.recorded_at<$1
      AND NOT EXISTS(SELECT 1 FROM receipt_batch_items i JOIN receipt_commit_anchors a ON a.batch_id=i.batch_id
        WHERE i.receipt_id=p.id AND NOT EXISTS(SELECT 1 FROM receipt_commit_anchor_events e WHERE e.anchor_id=a.id AND e.kind='orphaned'))
      AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchors a WHERE a.receipt_id=p.id
        AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchor_events e WHERE e.anchor_id=a.id)) ORDER BY p.recorded_at,p.id`,[through])).rows;
    if (!rows.length) return null;
    const items: ReceiptItem[] = rows.map(r=>({id:r.id,kind:'verdict',hash:r.payload_hash}));
    const tree = codec.buildReceiptTree(items);
    return { items, root: tree.root, proofs: tree.proofs, through };
  }
  /**
   * Rebuild the prepared tree, require unique items, matching reader chain, successful canonical
   * transaction and exactly one matching registry event, then bind every persisted payload to its
   * proof. Receipts role supplies configured chain/registry; validation/RPC/SQL failures reject.
   * This checks supplied chain equality; callers choose the intended chain.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async recordAnchor(batch: PreparedGuardReceiptBatch, txHash: Hex, registry: Address, chainId: number, reader: GuardRegistryReader, recordedAt: string) {
    const tree = codec.buildReceiptTree(batch.items);
    if (tree.root !== batch.root || canonicalize(tree.proofs) !== canonicalize(batch.proofs)
      || new Set(batch.items.map(i=>i.id)).size !== batch.items.length) throw new Error('Invalid prepared receipt batch');
    if (await reader.getChainId() !== chainId) throw new Error('Receipt registry chain mismatch');
    const tx = await reader.getTransactionReceipt({hash:txHash});
    if (tx.status !== 'success' || tx.transactionHash !== txHash || (await reader.getBlock({blockNumber:tx.blockNumber})).hash !== tx.blockHash)
      throw new Error('Receipt anchor transaction is not canonical/successful');
    const matches: {batchId:bigint;root:Hex;leafCount:number;committer:Address;logIndex:number}[]=[];
    for (const log of tx.logs) {
      if (log.address.toLowerCase() !== registry.toLowerCase() || log.removed || log.logIndex === null) continue;
      try {
        const event = decodeEventLog({abi:registryAbi as Abi,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
        if (event.eventName !== 'BatchCommitted') continue;
        const args = event.args as unknown as {batchId:bigint;root:Hex;leafCount:number;committer:Address};
        if (args.root===tree.root && args.leafCount===batch.items.length) matches.push({...args,logIndex:log.logIndex});
      } catch { /* Unrelated or malformed log cannot authenticate this batch. */ }
    }
    if (matches.length !== 1) throw new Error('Matching registry BatchCommitted event required');
    const event = matches[0]!;
    if (event.batchId <= 0n || event.batchId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unrepresentable registry batch ID');
    await this.db.tx(async db=>{
      for (const [i,item] of batch.items.entries()) {
        const payload = (await db.sql.query<{payload_hash:Hex;chain_id:string}>('SELECT payload_hash,chain_id FROM guard_receipt_payloads WHERE id=$1',[item.id])).rows[0];
        if (!payload || item.kind!=='verdict' || payload.payload_hash!==item.hash || Number(payload.chain_id)!==chainId) throw new Error('Receipt batch item mismatch');
        const data:Anchor={receiptId:item.id,payloadHash:item.hash,root:tree.root,proof:tree.proofs[i]!,batchId:Number(event.batchId),txHash,
          registry:registry.toLowerCase() as Address,blockNumber:String(tx.blockNumber),blockHash:tx.blockHash,logIndex:event.logIndex,committer:event.committer};
        const id=codec.hash(data);
        await db.sql.query('INSERT INTO guard_receipt_anchors(id,receipt_id,chain_id,registry_address,batch_id,data,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
          [id,item.id,chainId,data.registry,String(event.batchId),JSON.stringify(data),recordedAt]);
      }
    });
  }
  /** Recheck committed block hashes without rewriting payloads or anchor facts.
   * Orphaned batches return to the recorded queue and can be anchored again.
   * @remarks
   * Recheck unresolved anchor block hashes against the supplied chain and append orphan observations
   * without rewriting immutable payloads. Receipts role only; chain mismatch, unavailable canonical
   * header or RPC/SQL failure rejects; finalization is not recorded on this path.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async refreshAnchors(reader: GuardRegistryReader, chainId: number, recordedAt: string) {
    if (await reader.getChainId()!==chainId) throw new Error('Receipt registry chain mismatch');
    const rows=(await this.db.sql.query<{id:string;data:Anchor}>(`SELECT a.id,a.data FROM guard_receipt_anchors a WHERE a.chain_id=$1
      AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchor_events e WHERE e.anchor_id=a.id)`,[chainId])).rows;
    const headers=new Map<string,Hex|null>();
    for(const row of rows) {
      if(!headers.has(row.data.blockNumber)) headers.set(row.data.blockNumber,(await reader.getBlock({blockNumber:BigInt(row.data.blockNumber)})).hash);
      const canonicalHash=headers.get(row.data.blockNumber);
      if(!canonicalHash) throw new Error('Missing canonical anchor block');
      if(canonicalHash===row.data.blockHash)continue;
      const event={kind:'orphaned',anchorId:row.id,canonicalHash,recordedAt};
      await this.db.sql.query("INSERT INTO guard_receipt_anchor_events(id,anchor_id,kind,data,recorded_at) VALUES($1,$2,'orphaned',$3,$4) ON CONFLICT(id) DO NOTHING",
        [codec.hash({anchorId:row.id,canonicalHash}),row.id,JSON.stringify(event),recordedAt]);
    }
  }
}
