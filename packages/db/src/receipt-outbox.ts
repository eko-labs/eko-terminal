import { concat, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import type { Hex } from 'viem';
import { canonicalize, createGuardReceiptCodec, GuardReceiptPayloadSchema, PublicReceiptPayloadSchema, ReceiptRefV2Schema } from '@eko/shared';
import type { PublicReceiptPayload, ReceiptItem } from '@eko/shared';
import type { ChainDb } from './client.js';
import { currentReceiptAnchor } from './receipt-anchors.js';
import { hex } from './types.js';

const codec = createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex});
export interface Publication {
  id:string; producer:string; kind:'verdict'|'forecast'|'harness_private'; chain_id:string; revision_id:string;
  summary?: {coin?:string};
  payload_hash:Hex; canonical_payload:string; data:unknown; recorded_at:Date;
}
// Guard 034's immutable raw payload journal is already a durable producer outbox.
const sources = `SELECT id,producer,kind,chain_id,revision_id,payload_hash,canonical_payload,data,recorded_at FROM receipt_publications
  UNION ALL SELECT id,'guard','verdict',chain_id,revision_id,payload_hash,canonical_payload,data,recorded_at FROM guard_receipt_payloads
  UNION ALL SELECT id,'harness','harness_private',4663,id,commitment,
    jsonb_build_object('id',id,'kind','harness_private','hash',commitment)::text,
    jsonb_build_object('id',id,'kind','harness_private','hash',commitment),recorded_at FROM receipt_private_publications`;

function privateItem(row: Publication): ReceiptItem {
  const item: ReceiptItem = { id: row.id, kind: 'harness_private', hash: row.payload_hash };
  if (row.producer !== 'harness' || row.kind !== 'harness_private' || row.revision_id !== row.id || Number(row.chain_id) !== 4663
    || !/^0x[0-9a-f]{64}$/.test(row.payload_hash) || canonicalize(row.data) !== canonicalize(item)) throw new Error('Private receipt integrity failure');
  return item;
}
/** MCP publishes only commitments in its journal transaction; receipts alone
 * writes receipt_items. Survives private-row deletion before outbox recovery.
 * @remarks
 * Persist only a validated commitment/id/time in the caller's private-journal transaction and
 * compare an existing id for exact commitment equality. Authenticated journal caller supplies
 * identity; invalid commitment/reused identity or SQL failure rejects. No account/payload/salt
 * metadata enters this publication.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export async function publishPrivateReceipt(db: ChainDb, id: string, commitment: Hex, recordedAt: string) {
  if (!/^0x[0-9a-f]{64}$/.test(commitment)) throw new Error('Invalid private commitment');
  await db.sql.query('INSERT INTO receipt_private_publications(id,commitment,recorded_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id,commitment,recordedAt]);
  const row = (await db.sql.query<{commitment:string}>('SELECT commitment FROM receipt_private_publications WHERE id=$1', [id])).rows[0];
  if (row?.commitment !== commitment) throw new Error('Private receipt identity reused');
}
/** Verify original public payload schema, canonical bytes, identity, hash and snapshot before retention removes it.
 * Host retention/outbox caller only. Invalid or private payloads reject, no database or network mutation occurs.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export function validateReceiptPublication(row: Publication) {
  const payload = row.producer === 'guard' ? GuardReceiptPayloadSchema.parse(row.data) : PublicReceiptPayloadSchema.parse(row.data);
  const chainId = 'chainId' in payload ? payload.chainId : payload.decision.chainId;
  if (payload.receiptId !== row.id || payload.revisionId !== row.revision_id || payload.kind !== row.kind
    || chainId !== Number(row.chain_id) || Date.parse(payload.recordedAt) !== new Date(row.recorded_at).getTime()
    || canonicalize(payload) !== row.canonical_payload || canonicalize(row.data) !== row.canonical_payload
    || !codec.verifyPayload(payload,{id:row.id,kind:row.kind,hash:row.payload_hash})) throw new Error('Receipt publication integrity failure');
  if ('snapshotHash' in payload && codec.hash(payload.deterministicInput) !== payload.snapshotHash) throw new Error('Receipt snapshot hash mismatch');
  return payload;
}
function same(a:Publication,b:Publication) {
  return a.id===b.id && a.producer===b.producer && a.kind===b.kind && Number(a.chain_id)===Number(b.chain_id)
    && a.revision_id===b.revision_id && a.payload_hash===b.payload_hash && (a.canonical_payload===null || b.canonical_payload===null || a.canonical_payload===b.canonical_payload);
}

/** Call in the producer's persistence transaction. A crash after commit leaves
 * the exact public bytes available to recover(), without card reconstruction.
 * No forecast producer is run or output synthesized by this adapter.
 * @remarks
 * Validate and canonically hash the immutable public payload, check revision references and
 * idempotent identity equality, then persist in the producer transaction. Authorized producer
 * supplies data; invalid producer/schema/canonical bytes/reference/reused id or SQL failure
 * rejects. No forecast output is synthesized.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export async function publishReceipt(db:ChainDb, producer:string, raw:PublicReceiptPayload) {
  if (!producer || producer==='guard') throw new Error('Invalid public receipt producer');
  const payload=PublicReceiptPayloadSchema.parse(raw), canonicalPayload=canonicalize(payload);
  if (canonicalize(raw)!==canonicalPayload) throw new Error('Noncanonical receipt input');
  const row:Publication={id:payload.receiptId,producer,kind:payload.kind,chain_id:String(payload.chainId),revision_id:payload.revisionId,
    payload_hash:codec.hash(payload),canonical_payload:canonicalPayload,data:payload,recorded_at:new Date(payload.recordedAt)};
  validateReceiptPublication(row);
  return db.tx(async tx=>{
    for (const reference of new Set([payload.supersedes,payload.reorgOf].filter((id):id is string=>id!==null))) {
      const old=(await tx.sql.query<Publication>('SELECT * FROM receipt_publications WHERE id=$1',[reference])).rows[0];
      if (!old && producer==='engines' && row.kind==='verdict' && payload.chainId===4663) {
        // Pre-079 verdicts have retained outputs but no original raw envelope.
        // Reference their identity; never synthesize or rehash missing bytes.
        const legacy=(await tx.sql.query<{coin:Uint8Array}>('SELECT coin FROM verdicts WHERE id=$1',[reference])).rows[0];
        if (legacy && hex(legacy.coin)===payload.coin) continue;
      }
      if (!old || old.producer!==producer || old.kind!==row.kind || Number(old.chain_id)!==payload.chainId
        || (old.data==null ? old.summary?.coin : PublicReceiptPayloadSchema.parse(old.data).coin)!==payload.coin) throw new Error('Invalid receipt revision reference');
    }
    await tx.sql.query(`INSERT INTO receipt_publications(id,producer,kind,chain_id,revision_id,payload_hash,canonical_payload,data,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [row.id,producer,row.kind,payload.chainId,row.revision_id,row.payload_hash,canonicalPayload,JSON.stringify(payload),payload.recordedAt]);
    const stored=(await tx.sql.query<Publication>('SELECT * FROM receipt_publications WHERE id=$1',[row.id])).rows[0];
    if (!stored || !same(stored,row)) throw new Error('Receipt identity reused for different input');
    return {status:'recorded' as const,id:row.id,payloadHash:row.payload_hash};
  });
}

/** Receipts is the only writer to receipt_items and receipt_batches. Producers
 * retain immutable publications; acknowledgement is item existence, not a
 * volatile cursor or notification. Retries and concurrent readers are harmless. */
export class ReceiptOutbox {
  readonly writer='receipts';
  /**
   * Retain receipts-role storage for immutable publication recovery. Host-only construction; no
   * producer authentication/enqueue/query occurs here.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  constructor(readonly db:ChainDb) {}
  /**
   * Require exactly one durable publication, verify immutable payload/commitment binding and leaf,
   * and idempotently insert the receipts-owned item in a transaction. Receipts worker caller only;
   * ambiguous/missing/tampered/reused input or SQL failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async enqueue(id:string) {
    return this.db.tx(async tx=>{
      const archived=(await tx.sql.query<Publication & {leaf:Hex}>('SELECT * FROM receipt_items WHERE id=$1 AND data IS NULL',[id])).rows[0];
      if(archived) {
        if(archived.producer!=='engines' || archived.kind!=='verdict' || Number(archived.chain_id)!==4663)throw new Error('Archived receipt header integrity failure');
        const item:ReceiptItem={id:archived.id,kind:archived.kind,hash:archived.payload_hash};
        if(codec.encodeReceiptLeaf(item)!==archived.leaf)throw new Error('Archived receipt leaf integrity failure');
        return item;
      }
      await tx.sql.query('SELECT id FROM receipt_publications WHERE id=$1 FOR KEY SHARE',[id]);
      const rows=(await tx.sql.query<Publication>(`SELECT * FROM (${sources}) p WHERE id=$1`,[id])).rows;
      if (rows.length!==1) throw new Error('Exactly one durable receipt publication required');
      const row=rows[0]!;
      if (row.kind === 'harness_private') { privateItem(row); row.canonical_payload = canonicalize(row.data); } else if(row.data!=null)validateReceiptPublication(row);
      else if(row.producer!=='engines' || row.kind!=='verdict' || Number(row.chain_id)!==4663 || !/^0x[0-9a-f]{64}$/.test(row.payload_hash))throw new Error('Archived receipt header integrity failure');
      const item:ReceiptItem={id:row.id,kind:row.kind,hash:row.payload_hash},leaf=codec.encodeReceiptLeaf(item);
      await tx.sql.query(`INSERT INTO receipt_items(id,producer,kind,chain_id,revision_id,payload_hash,leaf,canonical_payload,data,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [row.id,row.producer,row.kind,row.chain_id,row.revision_id,row.payload_hash,leaf,row.canonical_payload,row.data==null ? null : JSON.stringify(row.data),row.recorded_at]);
      const stored=(await tx.sql.query<Publication & {leaf:Hex}>('SELECT * FROM receipt_items WHERE id=$1',[id])).rows[0];
      if (!stored || !same(stored,row) || stored.leaf!==leaf) throw new Error('Receipt identity reused for different input');
      return item;
    });
  }
  /** Bounded replay includes pre-079 Guard payloads and every correction, even
   * at the same block. Failed rows remain pending; a retry cannot lose them.
   * @remarks
   * Bound replay to 1-10000 pending durable publications and enqueue each, including
   * corrections/private commitments. Receipts worker only; invalid limit or failed integrity/SQL
   * operation rejects; failed rows remain recoverable and prior individual item transactions may
   * already be committed.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async recover(limit=100) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>10000) throw new Error('Invalid receipt recovery limit');
    const rows=(await this.db.sql.query<{id:string}>(`SELECT p.id FROM (${sources}) p
      WHERE NOT EXISTS(SELECT 1 FROM receipt_items i WHERE i.id=p.id) ORDER BY p.recorded_at,p.id LIMIT $1`,[limit])).rows;
    for (const row of rows) await this.enqueue(row.id);
    return rows.length;
  }
  /**
   * Read a private receipt item and authenticate its public commitment/leaf/canonical envelope,
   * returning only the item or null. Receipts worker/internal read without user session auth;
   * integrity/SQL failure rejects and no journal keys/plaintext are accessed.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async getPrivate(id: string) {
    const row = (await this.db.sql.query<Publication & {leaf:Hex}>('SELECT * FROM receipt_items WHERE id=$1 AND kind=$2', [id,'harness_private'])).rows[0];
    if (!row) return null;
    const item = privateItem(row);
    if (row.canonical_payload !== canonicalize(item) || row.leaf !== codec.encodeReceiptLeaf(item)) throw new Error('Private receipt integrity failure');
    return item;
  }
  /**
   * Read the validated leaf representation for a selected receipt kind, including private
   * commitments without journal payloads or salts. Receipts worker only; missing items or kind
   * mismatches reject as integrity failures, and reader validation/SQL errors propagate.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async getItem(id: string, kind: ReceiptItem['kind']): Promise<ReceiptItem> {
    if(kind==='harness_private') {const item=await this.getPrivate(id);if(!item)throw new Error('Receipt item integrity failure: selected item missing');if(item.id!==id || item.kind!==kind)throw new Error('Receipt item integrity failure: selected kind mismatch');return item;}
    const archived=(await this.db.sql.query<Publication & {leaf:Hex}>('SELECT * FROM receipt_items WHERE id=$1 AND data IS NULL',[id])).rows[0];
    if(archived && archived.data==null) {
      if(archived.producer!=='engines' || archived.kind!=='verdict' || Number(archived.chain_id)!==4663)throw new Error('Archived receipt header integrity failure');
      const item:ReceiptItem={id,kind:archived.kind,hash:archived.payload_hash};
      if(item.kind!==kind || codec.encodeReceiptLeaf(item)!==archived.leaf)throw new Error('Archived receipt leaf integrity failure');
      return item;
    }
    const item = (await this.get(id))?.item;
    if (!item) throw new Error('Receipt item integrity failure: selected item missing');
    if (item.id !== id || item.kind !== kind) throw new Error('Receipt item integrity failure: selected kind mismatch');
    return item;
  }
  /**
   * Read/validate original public payload bytes, leaf, stored anchor references and revision events,
   * returning null for missing/private items. Internal receipt consumer, no wallet auth;
   * integrity/SQL errors reject. This read uses stored anchor facts; public live canonical
   * verification belongs to ReceiptApiStore.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  async get(id:string) {
    const row=(await this.db.sql.query<Publication & {leaf:Hex}>('SELECT * FROM receipt_items WHERE id=$1',[id])).rows[0];
    if (!row || row.kind === 'harness_private' || row.data == null) return null;
    const payload=validateReceiptPublication(row),item:ReceiptItem={id,kind:row.kind,hash:row.payload_hash};
    if (codec.encodeReceiptLeaf(item)!==row.leaf) throw new Error('Stored receipt leaf integrity failure');
    // Reuse authenticated Guard anchor facts; a prepared batch is never a public anchor.
    const anchor=await currentReceiptAnchor(this.db,id) ?? (row.producer==='guard' ? (await this.db.sql.query<{data:{root:Hex;batchId:number;proof:Hex[];txHash:Hex}}>(`SELECT a.data FROM guard_receipt_anchors a WHERE a.receipt_id=$1
      AND NOT EXISTS(SELECT 1 FROM guard_receipt_anchor_events e WHERE e.anchor_id=a.id) ORDER BY a.recorded_at,a.id LIMIT 1`,[id])).rows[0]?.data : undefined);
    const receipt=ReceiptRefV2Schema.parse(anchor ? {status:'anchored',id,payloadHash:row.payload_hash,root:anchor.root,batchId:anchor.batchId,proof:anchor.proof,txHash:anchor.txHash}
      : {status:'recorded',id,payloadHash:row.payload_hash});
    const events=row.producer==='guard'
      ? (await this.db.sql.query<{data:unknown}>('SELECT data FROM guard_verdict_events WHERE target_id=$1 ORDER BY known_position,acquisition_sequence,id',[row.revision_id])).rows.map(r=>r.data)
      : row.producer==='engines' ? (await this.db.sql.query<{kind:string;block:string;data:unknown}>('SELECT kind,block,data FROM verdict_events WHERE verdict_id=$1 ORDER BY block,id',[row.revision_id])).rows : [];
    return {payload,canonicalPayload:row.canonical_payload,item,leaf:row.leaf,receipt,events};
  }
}
