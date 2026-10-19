import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { applyPreset, type PolicyInput } from '@eko/policy';
import { AgentDetailSchema, AgentSchema, ApiKeyCreatedSchema, ApiKeyInfoSchema, PolicySchema,
  type Agent, type ErrorCode, type Policy } from '@eko/shared';
import type { Db } from '../db/client.js';
import { accounts, agents, agentKeys, policies } from '../db/schema.js';

export class HarnessError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}
type AgentRow = typeof agents.$inferSelect;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
const asAgent = (row: AgentRow) => AgentSchema.parse({ ...row, wallet: row.wallet ?? undefined,
  lastSeen: row.lastSeen?.toISOString(), guardrails: 'advisory', uncheckedOrders24h: 0 });

/** Only the API writes agent, policy and key lifecycle state. */
export class HarnessService {
  /**
   * Wire API-owned lifecycle database, optional HMAC pepper, publisher and destruction-state reader.
   * Host-only construction; no caller auth/query occurs yet and missing pepper disables key
   * issuance/authentication.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  constructor(private db: Db, private pepper?: string,
    private publish: (accountId: string, agent: Agent) => void = () => {},
    private destroyed?: (accountId: string) => boolean) {}

  private async owned(tx: Db | Transaction, accountId: string, id: string, lock = false) {
    const query = tx.select().from(agents).where(and(eq(agents.id, id), eq(agents.accountId, accountId)));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new HarnessError('not_found', 'Not found');
    return row;
  }
  private async currentPolicy(tx: Db | Transaction, id: string) {
    const [row] = await tx.select().from(policies).where(eq(policies.agentId, id)).orderBy(desc(policies.version)).limit(1);
    if (!row) throw new Error('Agent policy missing');
    return PolicySchema.parse(row.policy);
  }
  private async admission(tx: Transaction, accountId: string, limit: number) {
    // TODO(spec): Agent quotas count active and paused connections; disconnected
    // records retain history and no longer occupy a slot. Reconnect rechecks admission.
    // Serialize admission across API instances using the owner row, including resume.
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(agents)
      .where(and(eq(agents.accountId, accountId), ne(agents.status, 'disconnected')));
    if (count!.n >= limit) throw new HarnessError('quota_exceeded', 'Agent limit reached');
  }
  /**
   * List only agents belonging to the caller-supplied account in creation/id order. Caller must
   * authenticate the account; database/schema failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async list(accountId: string) {
    return (await this.db.select().from(agents).where(eq(agents.accountId, accountId)).orderBy(agents.createdAt, agents.id)).map(asAgent);
  }
  /**
   * Return an owned agent and its latest policy. Caller supplies authenticated owner identity;
   * nonownership is not_found, missing policy or database/schema failure rejects.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async detail(accountId: string, id: string) {
    const row = await this.owned(this.db, accountId, id);
    return AgentDetailSchema.parse({ ...asAgent(row), policy: await this.currentPolicy(this.db, id) });
  }
  /**
   * Read the latest policy after verifying agent ownership. Caller supplies authenticated owner
   * identity; nonownership is not_found and missing/corrupt policy or database failure rejects.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async policy(accountId: string, id: string) {
    await this.owned(this.db, accountId, id);
    return this.currentPolicy(this.db, id);
  }
  /**
   * Serialize admission on the account row, enforce the supplied active/paused quota, insert the
   * agent and initial preset policy, then publish after commit. Caller authenticates
   * wallet/entitlement; quota_exceeded or schema/storage/publisher failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async create(accountId: string, input: { name: string; kind: Agent['kind']; wallet?: Agent['wallet']; preset: Policy['mode']; policy?: Partial<Policy> }, limit: number) {
    const agent = await this.db.transaction(tx => this.createInTransaction(tx, accountId, input, limit));
    this.publish(accountId, agent);
    return agent;
  }
  /**
   * Insert an agent and initial preset policy under the account admission lock in the caller's
   * transaction. Enforce the active/paused quota; caller authenticates owner/entitlement and owns
   * commit and publication. Quota, schema or storage failure rolls back with the transaction.
   */
  async createInTransaction(tx: Transaction, accountId: string, input: { name: string; kind: Agent['kind']; wallet?: Agent['wallet']; preset: Policy['mode']; policy?: Partial<Policy> }, limit: number) {
    await this.admission(tx, accountId, limit);
    const [row] = await tx.insert(agents).values({ accountId, name: input.name, kind: input.kind, wallet: input.wallet }).returning();
    const policy = PolicySchema.parse(applyPreset({ ...input.policy, mode: input.preset, killed: false, version: 1 }));
    await tx.insert(policies).values({ agentId: row!.id, version: 1, policy });
    return AgentDetailSchema.parse({ ...asAgent(row!), policy });
  }
  /**
   * Lock owner then owned agent; recheck quota on reconnect, revoke keys on disconnect, and version
   * the killed policy when status changes. Caller authenticates owner and gates mutation flags;
   * nonownership/quota or storage/publisher failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async update(accountId: string, id: string, input: { name?: string; status?: Agent['status'] }, limit: number) {
    const result = await this.db.transaction(async tx => {
      // Use owner-before-agent lock order, consistent with creation and reconnect.
      await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
      const row = await this.owned(tx, accountId, id, true);
      if (input.status === 'active' && row.status === 'disconnected') await this.admission(tx, accountId, limit);
      if (input.status === 'disconnected') await tx.update(agentKeys).set({ revokedAt: new Date() })
        .where(and(eq(agentKeys.agentId, id), isNull(agentKeys.revokedAt)));
      if (input.status && input.status !== row.status) {
        const policy = await this.currentPolicy(tx, id);
        await tx.insert(policies).values({ agentId: id, version: policy.version + 1,
          policy: { ...policy, version: policy.version + 1, killed: input.status !== 'active' } });
      }
      const [updated] = await tx.update(agents).set(input).where(eq(agents.id, id)).returning();
      return asAgent(updated!);
    });
    this.publish(accountId, result);
    return result;
  }
  /**
   * Lock the owned agent, require the current policy version, apply presets and agent-derived killed
   * state, and append the next version retaining the Guard version. Caller authenticates owner;
   * not_found/conflict or validation/storage failure rejects.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async savePolicy(accountId: string, id: string, input: Policy) {
    return this.db.transaction(async tx => {
      const agent = await this.owned(tx, accountId, id, true);
      const previous = await this.currentPolicy(tx, id);
      if (previous.version !== input.version) throw new HarnessError('conflict', 'Policy changed elsewhere');
      const policy = PolicySchema.parse(applyPreset({ ...input, killed: agent.status !== 'active',
        version: previous.version + 1, guardPolicyVersion: previous.guardPolicyVersion } as PolicyInput));
      await tx.insert(policies).values({ agentId: id, version: policy.version, policy });
      return policy;
    });
  }
  /**
   * Return owned key metadata without bearer secrets or hashes. Caller authenticates owner;
   * nonownership is not_found and storage/schema failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async keys(accountId: string, id: string) {
    await this.owned(this.db, accountId, id);
    return (await this.db.select().from(agentKeys).where(eq(agentKeys.agentId, id)).orderBy(agentKeys.createdAt, agentKeys.id))
      .map(row => ApiKeyInfoSchema.parse({ keyId: row.id, prefix: row.prefix, kind: row.kind,
        createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString(), revokedAt: row.revokedAt?.toISOString(),
        clientName: row.clientName ?? undefined, scopes: row.scopes ?? undefined }));
  }
  /**
   * Reject deleted harness data, failed destruction-state reads or missing HMAC pepper before key
   * issuance. Caller supplies authenticated account identity; this check neither verifies
   * ownership nor creates a key.
   */
  assertKeyIssuance(accountId: string) {
    try {
      if (this.destroyed?.(accountId)) throw new HarnessError('forbidden', 'Harness data was deleted');
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('internal_error', 'Harness key issuance is unavailable');
    }
    if (!this.pepper) throw new HarnessError('internal_error', 'Harness key issuance is unavailable');
  }
  /**
   * Return a random API bearer once and store only its HMAC under a random prefix while locking the
   * owned agent. Caller authenticates owner; missing pepper, failed destruction-state reads, deleted data,
   * nonownership or disconnection rejects issuance.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async createKey(accountId: string, id: string) {
    this.assertKeyIssuance(accountId);
    const prefix = randomBytes(8).toString('hex'), secret = randomBytes(32).toString('base64url');
    const hash = createHmac('sha256', this.pepper!).update(secret).digest('hex');
    const keyId = await this.db.transaction(async tx => {
      const agent = await this.owned(tx, accountId, id, true);
      if (agent.status === 'disconnected') throw new HarnessError('conflict', 'Agent is disconnected');
      const [row] = await tx.insert(agentKeys).values({ agentId: id, prefix, hash }).returning({ id: agentKeys.id });
      return row!.id;
    });
    return ApiKeyCreatedSchema.parse({ keyId, prefix, secret: `eko_live_${prefix}_${secret}` });
  }
  /**
   * Lock the owned agent and idempotently set the owned key's revocation timestamp. Caller
   * authenticates owner; unknown/nonowned agent or key yields not_found and database failures
   * reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async revokeKey(accountId: string, id: string, keyId: string) {
    await this.db.transaction(async tx => {
      await this.owned(tx, accountId, id, true);
      const [row] = await tx.select().from(agentKeys).where(and(eq(agentKeys.id, keyId), eq(agentKeys.agentId, id)));
      if (!row) throw new HarnessError('not_found', 'Not found');
      await tx.update(agentKeys).set({ revokedAt: row.revokedAt ?? new Date() }).where(eq(agentKeys.id, keyId));
    });
  }
  /** Resolve an API bearer for later MCP handlers. No cookie session grants harness access.
   * @remarks
   * Authenticate an API bearer by format and constant-time HMAC comparison, then check agent state,
   * destruction state and current revocation under an agent lock and record use.
   * Invalid/revoked/disconnected/deleted credentials return null; database failures reject. A paused
   * agent may resolve here; MCP separately requires active status.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  async authenticate(bearer: string): Promise<{ accountId: string; agent: Agent; keyId: string } | null> {
    if (!this.pepper) return null;
    const match = /^eko_live_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/.exec(bearer);
    if (!match) return null;
    const [key] = await this.db.select().from(agentKeys).where(eq(agentKeys.prefix, match[1]!));
    const expected = Buffer.from(key?.hash ?? '0'.repeat(64), 'hex');
    const supplied = createHmac('sha256', this.pepper).update(match[2]!).digest();
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied) || !key || key.kind !== 'api' || key.revokedAt) return null;
    return this.db.transaction(async tx => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, key.agentId)).for('update');
      if (!agent || agent.status === 'disconnected') return null;
      try { if (this.destroyed?.(agent.accountId)) return null; } catch { return null; }
      const [used] = await tx.update(agentKeys).set({ lastUsedAt: new Date() })
        .where(and(eq(agentKeys.id, key.id), isNull(agentKeys.revokedAt))).returning({ id: agentKeys.id });
      if (!used) return null;
      return { accountId: agent.accountId, agent: asAgent(agent), keyId: key.id };
    });
  }
}
