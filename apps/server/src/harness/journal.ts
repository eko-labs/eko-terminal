import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalize, JournalEntrySchema, JournalWriteSchema, type JournalEntry, type JournalWrite } from '@eko/shared';
import { journalBytes, openEntry, publishPrivateReceipt, sealEntry, unwrapDek, wrapDek,
  type ChainDb, type JournalDestructionLedger } from '@eko/db';
import { HarnessError } from './service.js';
import { PointsService } from '../points/service.js';

type KeyRow = { version: number; kek_id: string; wrapped_dek: Uint8Array | null; destroyed_at: Date | null };
type EntryRow = { id: string; agent_id: string; ts: Date; kind: JournalEntry['kind']; preflight_id: string | null;
  key_version: number; iv: Uint8Array; ciphertext: Uint8Array; salt_ct: Uint8Array; commitment: `0x${string}`; share: boolean };
export type SharedGroundTruth = { kind: JournalEntry['kind']; side?: 'buy' | 'sell'; decision?: 'allow' | 'deny' | 'needs_approval';
  notionalBucket?: string; quantityBucket?: string };
/** MCP-owned writer; runs in the same transaction as its encrypted journal row. */
export interface GroundTruthWriter { readonly writer: 'mcp'; write(tx: ChainDb, data: SharedGroundTruth): Promise<void> }
export const groundTruthWriter: GroundTruthWriter = { writer: 'mcp', /**
   * Write the supplied canonical shared ground-truth object in the caller's transaction.
   * Authenticated journal callers must pass the filtered opt-in projection; this adapter itself does
   * not strip fields or authenticate. Canonicalization/SQL failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async write(tx, data) {
  await tx.sql.query('INSERT INTO ground_truth_shared(data) VALUES($1)', [canonicalize(data)]);
} };
function sharedData(input: JournalWrite): SharedGroundTruth {
  // TODO(spec): Shared ground-truth fields/buckets are unspecified. Keep only
  // enum facts and powers-of-ten magnitude buckets; drop all text, ids, times,
  // instruments, arbitrary nested fields and exact amounts.
  const bucket = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? value === 0 ? 'zero' : `${value < 0 ? 'negative' : 'positive'}:10^${Math.floor(Math.log10(Math.abs(value)))}` : undefined;
  const p = input.payload, data: SharedGroundTruth = { kind: input.kind };
  if (p.side === 'buy' || p.side === 'sell') data.side = p.side;
  if (p.decision === 'allow' || p.decision === 'deny' || p.decision === 'needs_approval') data.decision = p.decision;
  const notional = bucket(p.notionalUsd), qty = bucket(p.qty);
  if (notional) data.notionalBucket = notional;
  if (qty) data.quantityBucket = qty;
  return data;
}

/** API-owned lifecycle adapter. Future OAuth/harness writers extend this boundary
 * rather than bypassing the account lock or destruction-first transaction. */
export interface PrivateDataCleaner { cleanup(tx: ChainDb, accountId: string, deletedAt: string): Promise<void> }
const exists = async (tx: ChainDb, table: string) => !!(await tx.sql.query<{name:string|null}>('SELECT to_regclass($1)::text AS name', [table])).rows[0]?.name;
export const privateDataCleaner: PrivateDataCleaner = { /**
   * Revoke keys and any present OAuth state, then delete implemented private
   * harness/preferences/notes while retaining account/session and financial/public receipt records.
   * Caller must authorize deletion and record destruction first under the account lock; SQL failures
   * reject for retry.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async cleanup(tx, accountId, deletedAt) {
  await tx.sql.query('UPDATE agent_keys SET revoked_at=COALESCE(revoked_at,$2) WHERE agent_id IN (SELECT id FROM agents WHERE account_id=$1)', [accountId, deletedAt]);
  // These additive tables are owned by later packets; don't create substitutes.
  if (await exists(tx, 'oauth_grants')) {
    await tx.sql.query('UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE account_id=$1', [accountId, deletedAt]);
    if (await exists(tx, 'oauth_tokens')) await tx.sql.query('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE account_id=$1)', [accountId]);
    if (await exists(tx, 'oauth_codes')) await tx.sql.query('DELETE FROM oauth_codes WHERE account_id=$1', [accountId]);
    await tx.sql.query('DELETE FROM oauth_grants WHERE account_id=$1', [accountId]);
  }
  for (const table of ['approvals', 'reported_orders', 'preflights', 'kill_events']) {
    if (await exists(tx, table)) await tx.sql.query(`DELETE FROM ${table} WHERE agent_id IN (SELECT id FROM agents WHERE account_id=$1)`, [accountId]);
  }
  await tx.sql.query('DELETE FROM harness_journal WHERE account_id=$1', [accountId]);
  await tx.sql.query('DELETE FROM agents WHERE account_id=$1', [accountId]);
  // TODO(spec): CA-30 does not define account/session or financial-record
  // deletion. Retain login identity for authenticated retries and chain/trade
  // facts; erase the implemented private harness, notes and preference data.
  for (const table of ['journal_consent', 'preferences', 'workspace_layouts', 'journal_entries']) await tx.sql.query(`DELETE FROM ${table} WHERE account_id=$1`, [accountId]);
} };

/** Only this API-owned adapter writes user_keys, including MCP first-write calls. */
export const journalKeyWriter = {
  writer: 'api' as const,
  /**
   * Wrap a fresh 256-bit DEK at version one for the supplied account/KEK id, insert it in the caller
   * transaction and zero the temporary DEK. Caller must hold the account lock and validate
   * consent/destruction; crypto/SQL failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async provision(tx: ChainDb, accountId: string, key: { kek: Buffer; id: string }): Promise<KeyRow> {
    const dek = randomBytes(32);
    try {
      const wrapped = wrapDek(key.kek, accountId, 1, key.id, dek);
      await tx.sql.query('INSERT INTO user_keys(account_id,version,kek_id,wrapped_dek) VALUES($1,1,$2,$3)', [accountId,key.id,wrapped]);
      return { version: 1, kek_id: key.id, wrapped_dek: wrapped, destroyed_at: null };
    } finally { dek.fill(0); }
  },
  /**
   * Null wrapped DEKs and retain the first destruction timestamp for the supplied account. Caller
   * must authenticate ownership and persist the destruction ledger first; SQL failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async destroy(tx: ChainDb, accountId: string, deletedAt: string) {
    await tx.sql.query('UPDATE user_keys SET wrapped_dek=NULL,destroyed_at=COALESCE(destroyed_at,$2) WHERE account_id=$1', [accountId,deletedAt]);
  },
};

export class JournalService {
  /**
   * Wire storage, current destruction ledger, KEK/id and trusted sharing/cleanup/points adapters.
   * Host-only construction; no key provisioning or account authentication occurs. Missing optional
   * state is refused by operations that need it.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  constructor(private db: ChainDb, private ledger?: JournalDestructionLedger,
    private key?: { kek: Buffer; id: string }, private sharing: GroundTruthWriter = groundTruthWriter,
    private cleaner: PrivateDataCleaner = privateDataCleaner,
    private points: PointsService = new PointsService(db)) {}
  private destroyed(accountId: string) {
    if (!this.ledger) throw new HarnessError('internal_error', 'Journal storage is unavailable');
    return this.ledger.destroyedAt(accountId);
  }
  private readable(accountId: string) {
    // TODO(spec): Re-enrollment after deletion is undefined. Keep the account's
    // journal and old harness credentials disabled rather than reusing identity.
    if (this.destroyed(accountId)) throw new HarnessError('forbidden', 'Journal data was deleted');
    if (!this.key) throw new HarnessError('internal_error', 'Journal storage is unavailable');
    return this.key;
  }
  private async locked(tx: ChainDb, accountId: string) {
    const row = (await tx.sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!row) throw new HarnessError('not_found', 'Not found');
  }
  private async owned(tx: ChainDb, accountId: string, agentId: string) {
    const row = (await tx.sql.query('SELECT id FROM agents WHERE id=$1 AND account_id=$2', [agentId, accountId])).rows[0];
    if (!row) throw new HarnessError('not_found', 'Not found');
  }
  /**
   * Lock the account and require owned agent, readable encryption/destruction state and opt-in
   * within the caller's transaction. Caller supplies authenticated identities; missing owner/agent,
   * deleted data, missing keys/consent or storage failure rejects. Shared by writes and replay.
   */
  async authorizeInTransaction(tx: ChainDb, accountId: string, agentId: string) {
    await this.locked(tx, accountId); await this.owned(tx, accountId, agentId);
    this.readable(accountId);
    const consent = (await tx.sql.query<{opted_in:boolean}>('SELECT opted_in FROM journal_consent WHERE account_id=$1', [accountId])).rows[0];
    if (!consent?.opted_in) throw new HarnessError('forbidden', 'Journal opt-in is required');
  }
  /**
   * Return persisted opt-in only when the destruction ledger does not mark this account deleted.
   * Caller supplies authenticated account identity; an opted-in row triggers the destruction check.
   * Absent/malformed ledger when consulted, or SQL failure, rejects.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async consent(accountId: string) {
    const row = (await this.db.sql.query<{opted_in:boolean}>('SELECT opted_in FROM journal_consent WHERE account_id=$1', [accountId])).rows[0];
    return { optedIn: !!row?.opted_in && !this.destroyed(accountId) };
  }
  /**
   * Lock the account and upsert explicit opt-in; opting in also requires readable key/ledger state.
   * Caller authenticates owner; unknown/deleted account, unavailable journal state or SQL failure
   * rejects.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async setConsent(accountId: string, optedIn: boolean) {
    return this.db.tx(async tx => {
      await this.locked(tx, accountId);
      if (optedIn) this.readable(accountId);
      await tx.sql.query('INSERT INTO journal_consent(account_id,opted_in) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET opted_in=$2,updated_at=now()', [accountId,optedIn]);
      return { optedIn };
    });
  }
  /** Called by authenticated MCP handlers, with the resolved key's owner/agent.
   * No bearer-supplied account identity, no private WS/log/telemetry publishing.
   * @remarks
   * Validate an object payload capped at 16 KB, lock account/agent ownership, require consent and
   * readable keys, encrypt payload/salt and publish only its commitment atomically. Optional sharing
   * stores the filtered projection and points. MCP supplies authenticated owner/agent identity; bad
   * input, nonownership, missing consent/preflight or crypto/storage failure rejects with bounded
   * HarnessError text.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async append(accountId: string, agentId: string, raw: unknown) {
    try {
      return await this.db.tx(tx => this.appendInTransaction(tx, accountId, agentId, raw));
    } catch (error) { return this.failure(error); }
  }
  /**
   * Validate a JSON object payload capped at 16 KB, authorize owner/agent and encrypt the entry
   * with its account DEK. Provision a missing DEK, publish the private commitment and optionally
   * write filtered sharing/points in the caller's transaction. Caller supplies authenticated
   * identities and owns commit; preflight binding, crypto or SQL failures propagate so preflight,
   * journal, sharing and private receipt roll back together. Temporary DEK bytes are zeroed.
   */
  async appendInTransaction(tx: ChainDb, accountId: string, agentId: string, raw: unknown) {
    const parsed = JournalWriteSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessError('bad_request', 'Invalid journal input');
    let input: JournalWrite;
    try { input = { ...parsed.data, payload: JSON.parse(journalBytes(parsed.data.payload).toString()) }; }
    catch { throw new HarnessError('bad_request', 'Journal payload must be JSON and at most 16 KB'); }
    await this.authorizeInTransaction(tx, accountId, agentId);
    const key = this.readable(accountId);
    if (input.preflightId) {
      if (!await exists(tx, 'preflights') || !(await tx.sql.query('SELECT id FROM preflights WHERE id=$1 AND agent_id=$2', [input.preflightId,agentId])).rows.length)
        throw new HarnessError('not_found', 'Not found');
    }
    let row = (await tx.sql.query<KeyRow>('SELECT * FROM user_keys WHERE account_id=$1 ORDER BY version DESC LIMIT 1', [accountId])).rows[0];
    if (!row) row = await journalKeyWriter.provision(tx,accountId,key);
    const dek = this.openKey(accountId, row);
    try {
      const id = randomUUID(), ts = new Date().toISOString(), sealed = sealEntry(dek,id,agentId,input.payload);
      await tx.sql.query(`INSERT INTO harness_journal(id,account_id,agent_id,ts,kind,preflight_id,key_version,iv,ciphertext,salt_ct,commitment,share,receipt_item_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,accountId,agentId,ts,input.kind,input.preflightId ?? null,row.version,sealed.iv,sealed.ciphertext,sealed.saltCt,sealed.commitment,input.share,id]);
      await publishPrivateReceipt(tx,id,sealed.commitment,ts);
      if (input.share) {
        await this.sharing.write(tx,sharedData(input));
        await this.points.sharedJournal(tx,{accountId,sourceId:id,occurredAt:ts});
      }
      return JournalEntrySchema.parse({ id,agentId,ts,...input,commitment:sealed.commitment });
    } finally { dek.fill(0); }
  }
  private openKey(accountId: string, row: KeyRow) {
    const key = this.readable(accountId);
    if (!row.wrapped_dek || row.destroyed_at || row.kek_id !== key.id) throw new HarnessError('internal_error', 'Journal key is unavailable');
    return unwrapDek(key.kek,accountId,row.version,row.kek_id,Buffer.from(row.wrapped_dek));
  }
  /**
   * Read owned journal rows by descending timestamp/id using an owner-resolved UUID cursor, limit
   * 1-100 and optional kind; authenticate/decrypt each payload. Caller supplies authenticated owner
   * identity. Invalid cursor/page, deletion, missing key or crypto/storage failures reject without
   * forwarding private error details.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async page(accountId: string, agentId: string, input: { limit?: number; cursor?: string; kind?: JournalEntry['kind'] } = {}) {
    try {
      return await this.db.tx(async tx => {
        await this.locked(tx, accountId); await this.owned(tx,accountId,agentId); this.readable(accountId);
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HarnessError('bad_request', 'Invalid journal page size');
        // Cursor contains only the last UUID; resolve its timestamp under ownership.
        let after: EntryRow | undefined;
        if (input.cursor) {
          after = (await tx.sql.query<EntryRow>('SELECT * FROM harness_journal WHERE id=$1 AND account_id=$2 AND agent_id=$3 AND ($4::text IS NULL OR kind=$4)', [input.cursor,accountId,agentId,input.kind ?? null])).rows[0];
          if (!after) throw new HarnessError('bad_request', 'Invalid journal cursor');
        }
        const rows = (await tx.sql.query<EntryRow>(`SELECT * FROM harness_journal WHERE account_id=$1 AND agent_id=$2
          AND ($3::text IS NULL OR kind=$3) AND ($4::timestamptz IS NULL OR (ts,id)<($4::timestamptz,$5::uuid))
          ORDER BY ts DESC,id DESC LIMIT $6`, [accountId,agentId,input.kind ?? null,after?.ts ?? null,after?.id ?? null,limit+1])).rows;
        const result: JournalEntry[] = [];
        for (const row of rows.slice(0,limit)) {
          const keyRow = (await tx.sql.query<KeyRow>('SELECT * FROM user_keys WHERE account_id=$1 AND version=$2', [accountId,row.key_version])).rows[0];
          if (!keyRow) throw new Error('Journal key missing');
          const dek = this.openKey(accountId,keyRow);
          try {
            const opened = openEntry(dek,row.id,row.agent_id,{ iv:Buffer.from(row.iv),ciphertext:Buffer.from(row.ciphertext),saltCt:Buffer.from(row.salt_ct),commitment:row.commitment });
            opened.salt.fill(0);
            result.push(JournalEntrySchema.parse({ id:row.id,agentId:row.agent_id,ts:new Date(row.ts).toISOString(),kind:row.kind,
              payload:opened.payload,preflightId:row.preflight_id ?? undefined,share:row.share,commitment:row.commitment }));
          } finally { dek.fill(0); }
        }
        return { rows: result, cursor: rows.length > limit ? result.at(-1)!.id : null };
      });
    } catch (error) { return this.failure(error); }
  }
  /**
   * Lock the account and durably append destruction before key nulling and cleanup; retries retain
   * the original deletion timestamp. Caller authenticates owner. SQL rollback does not undo the file
   * ledger; ledger/cleanup failures reject with bounded errors and require retry.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  async deleteData(accountId: string) {
    try {
      return await this.db.tx(async tx => {
        await this.locked(tx,accountId);
        this.destroyed(accountId);
        // Durable destruction precedes SQL, so a rollback/crash cannot resurrect
        // a key; retry uses the original deletion timestamp and finishes cleanup.
        const deletedAt = this.ledger!.destroy(accountId,new Date().toISOString());
        await journalKeyWriter.destroy(tx,accountId,deletedAt);
        await this.cleaner.cleanup(tx,accountId,deletedAt);
        return { deletedAt };
      });
    } catch (error) { return this.failure(error); }
  }
  private failure(error: unknown): never {
    if (error instanceof HarnessError) throw error;
    // Never forward SQL parameters, crypto details, payloads or identifiers to
    // the shared error reporter (which can send errors to remote telemetry).
    throw new HarnessError('internal_error', 'Journal storage is unavailable');
  }
}
