import { createHmac } from 'node:crypto';
import type { DbHandle } from '../../server/src/db/client.js';

export interface RateLimits {
  consume(subject: string, maxPerMinute: number): Promise<{ allowed: boolean; retryAfterSec: number }>;
}

/** Atomic shared counters; no sessions or secrets are stored, and replicas share budgets. */
export class SqlRateLimits implements RateLimits {
  /**
   * Retain SQL connection and HMAC pepper for shared counters. Host-only construction; caller
   * provisions credentials/pepper, no validation/query/authentication occurs here.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  constructor(private sql: DbHandle['chain']['sql'], private pepper: string) {}
  /**
   * Atomically consume an HMAC-subject minute counter shared across replicas, saturating at max+1
   * and returning allowance/retry time. Trusted transport chooses subject/max; no caller
   * authentication occurs here. SQL failures reject and do not grant an allowance.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async consume(subject: string, max: number) {
    const hash = createHmac('sha256', this.pepper).update(subject).digest('hex');
    const result = await this.sql.query<{ hits: number; retry: number }>(`
      INSERT INTO mcp_rate_limits (subject_hash, window_start, hits)
      VALUES ($1, date_trunc('minute', now()), 1)
      ON CONFLICT (subject_hash) DO UPDATE SET
        hits = CASE WHEN mcp_rate_limits.window_start < date_trunc('minute', now()) THEN 1
          ELSE LEAST(mcp_rate_limits.hits + 1, $2::int + 1) END,
        window_start = date_trunc('minute', now())
      RETURNING hits, GREATEST(1, CEIL(EXTRACT(EPOCH FROM window_start + interval '1 minute' - now())))::int AS retry
    `, [hash, max]);
    return { allowed: result.rows[0]!.hits <= max, retryAfterSec: result.rows[0]!.retry };
  }
  /**
   * Delete counters older than the previous minute. Host housekeeping call without wallet auth; SQL
   * failures reject.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async prune() {
    await this.sql.query("DELETE FROM mcp_rate_limits WHERE window_start < date_trunc('minute', now()) - interval '1 minute'");
  }
}
