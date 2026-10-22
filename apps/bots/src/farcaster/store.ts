import type { ChainDb } from '@eko/db';
import { CastHashSchema, FidSchema } from './verify.js';

export type FarcasterState = 'claimed' | 'sent' | 'failed' | 'rate_limited' | 'flag_off';

export class FarcasterStore {
  /**
   * Wire durable interaction storage and the host clock. Construction performs no author
   * authentication or platform operation.
   */
  constructor(readonly db: ChainDb, readonly now = Date.now) {}
  /**
   * Validate identifiers, HMAC-shaped author key and clock, then serialize the rolling three-per-
   * hour author quota and deduplicate each bot/cast. Return claimed, duplicate or rate_limited;
   * SQL failures reject. Caller verifies webhook identity before claiming.
   */
  async claim(botFid: number, castHash: string, authorKey: string): Promise<'claimed' | 'duplicate' | 'rate_limited'> {
    FidSchema.parse(botFid); castHash = CastHashSchema.parse(castHash);
    if (!/^[0-9a-f]{64}$/.test(authorKey)) throw new Error('Invalid Farcaster rate key');
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid Farcaster clock');
    return this.db.tx(async db => {
      // Serialize the rolling-hour quota across replicas, not just handlers in one process.
      await db.sql.query(`INSERT INTO farcaster_summon_locks(bot_fid,author_key) VALUES($1,$2)
        ON CONFLICT DO NOTHING`, [botFid, authorKey]);
      await db.sql.query('SELECT author_key FROM farcaster_summon_locks WHERE bot_fid=$1 AND author_key=$2 FOR UPDATE', [botFid, authorKey]);
      const rows = (await db.sql.query(`INSERT INTO farcaster_interactions(bot_fid,cast_hash,author_key,state,created_at)
        VALUES($1,$2,$3,'claimed',$4) ON CONFLICT DO NOTHING RETURNING cast_hash`, [botFid, castHash, authorKey, new Date(at)])).rows;
      if (!rows.length) return 'duplicate';
      const count = (await db.sql.query<{ hits: string }>(`SELECT count(*) AS hits FROM farcaster_interactions
        WHERE bot_fid=$1 AND author_key=$2 AND created_at > $3 AND state <> 'rate_limited'`,
      [botFid, authorKey, new Date(at - 3600000)])).rows[0];
      if (Number(count?.hits) > 3) {
        await db.sql.query("UPDATE farcaster_interactions SET state='rate_limited' WHERE bot_fid=$1 AND cast_hash=$2", [botFid, castHash]);
        return 'rate_limited';
      }
      return 'claimed';
    });
  }
  /**
   * Update only a claimed bot/cast interaction to the supplied finite completion state. Host
   * caller supplies the verified identifiers; SQL failures reject and no send is retried.
   */
  async finish(botFid: number, castHash: string, state: Exclude<FarcasterState, 'claimed' | 'rate_limited'>) {
    await this.db.sql.query("UPDATE farcaster_interactions SET state=$3 WHERE bot_fid=$1 AND cast_hash=$2 AND state='claimed'", [botFid, castHash, state]);
  }
}
