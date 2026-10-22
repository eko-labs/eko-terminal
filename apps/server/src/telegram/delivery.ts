import { createHash } from 'node:crypto';
import type { ChainDb } from '@eko/db';
import { AlertSchema, DYOR, NON_AFFILIATION, type Alert, type TelegramNoticeSend } from '@eko/shared';
import { quiet, type Delivery, type WatchAlertsService } from '../alerts/service.js';
import { advanceTelegramCursor } from './link.js';

const titles = { verdict_change: 'Watchlist verdict changed. Open the record for current evidence.',
  playbook: 'Watchlist playbook update. Open the record for current evidence.',
  agent_trade: 'Watched agent trade recorded. Open the record for details.' } as const;
const severity = { clear: 0, info: 0, monitor: 1, danger: 2 };

/** Ignore source prose, names and URLs. Alert notices are fixed templates with first-party links. */
export function telegramAlertText(alert: Alert, publicOrigin: string): string | null {
  const url = new URL(publicOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid notification origin');
  if (!(alert.kind in titles)) return null; // D0 approval/order actions remain dark.
  const path = alert.coin ? `/coin/${alert.coin}` : '/watch';
  return [titles[alert.kind as keyof typeof titles], `Record: ${url.origin}${path}`, DYOR, NON_AFFILIATION].join('\n');
}

/** Prepared consumer only. No timer, credentials, provider client or live send is registered. */
export class TelegramDeliveryWorker {
  /**
   * Wire durable alert claims, injected sender, HTTPS-origin input and clock. Host construction
   * starts no timer, credentials or platform transport.
   */
  constructor(private readonly db: ChainDb, private readonly alerts: WatchAlertsService,
    private readonly send: TelegramNoticeSend, private readonly publicOrigin: string, private readonly now = Date.now) {}
  /**
   * Claim at most limit pending Telegram notices and dispatch them through the injected sender,
   * returning the claimed count. Host schedules calls; storage/dispatch failures propagate and no
   * automatic worker starts.
   */
  async runOnce(limit = 50) {
    const deliveries = await this.alerts.claimTelegram(limit);
    for (const delivery of deliveries) await this.dispatch(delivery);
    return deliveries.length;
  }
  /**
   * Recheck the pending lease, owner identity, watch and preferences under the watch lock before
   * injected delivery. Cancel withdrawn/unsupported notices, defer quiet hours, or
   * acknowledge/retry with bounded state and cursor updates. Return stale for invalid claims;
   * ambiguous sends may duplicate on retry and SQL failures reject.
   */
  async dispatch(delivery: Delivery): Promise<'sent' | 'retry' | 'disabled' | 'stale'> {
    return this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      const row = (await tx.sql.query<Delivery>(`SELECT * FROM alert_deliveries
        WHERE account_id=$1 AND seq=$2 AND telegram_status='pending' AND telegram_attempts=$3
        AND telegram_lease_until>now() FOR UPDATE`, [delivery.account_id, delivery.seq, delivery.telegram_attempts])).rows[0];
      if (!row) return 'stale';
      const alert = AlertSchema.parse(row.data), text = telegramAlertText(alert, this.publicOrigin);
      const identity = (await tx.sql.query<{ external_id: string }>(
        "SELECT external_id FROM linked_identities WHERE account_id=$1 AND provider='telegram'", [row.account_id])).rows[0];
      const settings = await this.alerts.settings(row.account_id, tx);
      const watch = (await tx.sql.query('SELECT 1 FROM watches WHERE account_id=$1 AND kind=$2 AND target=$3', [row.account_id, row.watch_kind, row.watch_target])).rows.length;
      const enabled = alert.kind === 'agent_trade' ? settings.agentTradeAboveUsd !== undefined &&
        Number.isFinite(alert.sizeUsd) && alert.sizeUsd! > settings.agentTradeAboveUsd : settings.kinds.includes(alert.kind);
      // TODO(spec): no linked identity means no backlog replay. Quiet hours defer;
      // absent identity, unsupported kinds and withdrawn preferences cancel the notice.
      if (!identity || !/^[1-9][0-9]*$/.test(identity.external_id) || !Number.isSafeInteger(Number(identity.external_id)) ||
        !text || !watch || !settings.telegram || !enabled || alert.level && severity[alert.level] < severity[settings.minLevel]) {
        await tx.sql.query("UPDATE alert_deliveries SET telegram_status='disabled',telegram_lease_until=NULL WHERE account_id=$1 AND seq=$2", [row.account_id, row.seq]);
        await advanceTelegramCursor(tx, row.account_id);
        return 'disabled';
      }
      let success = false;
      const deferred = quiet(settings, this.now());
      if (!deferred) {
        try {
          // Keep cancellation/identity changes serialized through acceptance and acknowledgement.
          // TODO(spec): Telegram has no send idempotency guarantee. Confirmed sends dedupe
          // durably; an ambiguous provider acknowledgement/crash may duplicate on retry.
          const deliveryKey = createHash('sha256').update(`telegram:${row.account_id}:${row.seq}`).digest('hex');
          await this.send({ chatId: Number(identity.external_id), text, deliveryKey });
          success = true;
        } catch { /* Never persist provider exceptions, message text or credential-bearing URLs. */ }
      }
      await tx.sql.query(`UPDATE alert_deliveries SET telegram_status=$3,telegram_lease_until=NULL,telegram_error=$4,
        telegram_next_at=now()+least(3600,power(2,least(telegram_attempts,12))) * interval '1 second'
        WHERE account_id=$1 AND seq=$2`, [row.account_id, row.seq, success ? 'sent' : 'pending', success || deferred ? null : 'delivery_failed']);
      await advanceTelegramCursor(tx, row.account_id);
      return success ? 'sent' : 'retry';
    });
  }
}
