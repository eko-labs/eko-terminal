import { createHash, randomBytes } from 'node:crypto';
import type { ChainDb } from '@eko/db';
import type { TelegramLinkRedeemer, TelegramLinkResult } from '@eko/shared';

const hash = (code: string) => createHash('sha256').update(code).digest('hex');
// TODO(spec): CA-22 omits code TTL/reissue/relink policy. Use ten minutes, one current
// bearer code per SIWE account, and cancel old queued notices when changing identity.
export const TELEGRAM_LINK_TTL_MS = 10 * 60_000;

/** API-side storage. Only redeem(code, senderId) is exposed to the bot adapter. */
export class TelegramLinkService implements TelegramLinkRedeemer {
  /**
   * Validate the optional bot handle and wire link storage/clock. No listener or platform client
   * starts; missing handle disables link issuance.
   */
  constructor(readonly db: ChainDb, private readonly botHandle: string | undefined, private readonly now = Date.now) {
    if (botHandle !== undefined && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botHandle)) throw new Error('Invalid Telegram bot configuration');
  }
  /**
   * Require a wallet account under the watch lock, replace existing/expired codes and return a
   * ten-minute deep-link bearer, retaining only its hash. Caller authenticates the account;
   * missing bot configuration returns null and SQL failures reject.
   */
  async issue(accountId: string): Promise<{ url: string; expiresAt: string } | null> {
    if (!this.botHandle) return null;
    const code = randomBytes(32).toString('base64url'), expiresAt = new Date(this.now() + TELEGRAM_LINK_TTL_MS);
    return this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      const owner = (await tx.sql.query("SELECT 1 FROM accounts WHERE id=$1 AND kind='wallet'", [accountId])).rows.length;
      if (!owner) throw new Error('Wallet account required');
      await tx.sql.query('DELETE FROM telegram_link_codes WHERE account_id=$1 OR expires_at<=$2', [accountId, new Date(this.now())]);
      await tx.sql.query('INSERT INTO telegram_link_codes(code_hash,account_id,expires_at) VALUES($1,$2,$3)', [hash(code), accountId, expiresAt]);
      return { url: `https://t.me/${this.botHandle}?start=${code}`, expiresAt: expiresAt.toISOString() };
    });
  }
  /**
   * Validate the one-time code and verified private-DM sender ID, then atomically bind the
   * Telegram identity under the watch lock. Reject expired/used codes or foreign-account identity
   * conflicts with finite results; changing identity cancels old notices. Caller verifies the
   * sender; SQL failures reject.
   */
  async redeem(code: string, senderId: number): Promise<TelegramLinkResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !Number.isSafeInteger(senderId) || senderId <= 0) return 'invalid_code';
    return this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      const link = (await tx.sql.query<{ account_id: string }>(`SELECT c.account_id FROM telegram_link_codes c
        JOIN accounts a ON a.id=c.account_id AND a.kind='wallet'
        WHERE c.code_hash=$1 AND c.used_at IS NULL AND c.expires_at>$2 FOR UPDATE OF c`, [hash(code), new Date(this.now())])).rows[0];
      if (!link) return 'invalid_code';
      const identity = String(senderId);
      const foreign = (await tx.sql.query(`SELECT 1 FROM linked_identities
        WHERE provider='telegram' AND external_id=$1 AND account_id<>$2`, [identity, link.account_id])).rows.length;
      if (foreign) return 'identity_conflict';
      const previous = (await tx.sql.query<{ external_id: string }>(
        "SELECT external_id FROM linked_identities WHERE account_id=$1 AND provider='telegram'", [link.account_id])).rows[0];
      if (previous && previous.external_id !== identity) await cancelTelegram(tx, link.account_id);
      await tx.sql.query(`INSERT INTO linked_identities(account_id,provider,external_id) VALUES($1,'telegram',$2)
        ON CONFLICT(account_id,provider) DO UPDATE SET external_id=excluded.external_id,created_at=now()`, [link.account_id, identity]);
      await tx.sql.query('UPDATE telegram_link_codes SET used_at=$2 WHERE code_hash=$1', [hash(code), new Date(this.now())]);
      return 'linked';
    });
  }
  /**
   * Under the watch lock, remove the account identity/codes, cancel pending notices and advance
   * its consumer cursor. Caller supplies authenticated owner identity; idempotent when absent and
   * SQL failures reject.
   */
  async unlink(accountId: string) {
    await this.db.tx(async tx => {
      // Same lock order as watch claims/changes and final dispatch: queued and claimed
      // notices cannot cross an unlink or move to the replacement identity.
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      await tx.sql.query("DELETE FROM linked_identities WHERE account_id=$1 AND provider='telegram'", [accountId]);
      await tx.sql.query('DELETE FROM telegram_link_codes WHERE account_id=$1', [accountId]);
      await cancelTelegram(tx, accountId);
    });
  }
}

/**
 * Advance an account Telegram cursor only through deliveries preceding the earliest pending
 * notice. Caller supplies the enclosing transaction and owner context; SQL failure rolls back with
 * that transaction.
 */
export async function advanceTelegramCursor(tx: ChainDb, accountId: string) {
  await tx.sql.query(`INSERT INTO alert_consumer_cursors(account_id,consumer,seq)
    SELECT $1,'telegram',coalesce(max(seq),0) FROM alert_deliveries
    WHERE account_id=$1 AND seq<coalesce((SELECT min(seq) FROM alert_deliveries WHERE account_id=$1 AND telegram_status='pending'),9223372036854775807)
    ON CONFLICT(account_id,consumer) DO UPDATE SET seq=greatest(alert_consumer_cursors.seq,excluded.seq),updated_at=now()`, [accountId]);
}
async function cancelTelegram(tx: ChainDb, accountId: string) {
  await tx.sql.query(`UPDATE alert_deliveries SET telegram_status='disabled',telegram_lease_until=NULL,telegram_error=NULL
    WHERE account_id=$1 AND telegram_status='pending'`, [accountId]);
  await advanceTelegramCursor(tx, accountId);
}
