import { randomUUID } from 'node:crypto';
import { binary, hex, type ChainDb, type EngineBus } from '@eko/db';
import { AddressSchema, AlertSchema, AlertSettingsSchema, FeedItemSchema, VerdictSchema,
  type Address, type Alert, type AlertSettings, type Level, type WatchBody } from '@eko/shared';
import type { Hub } from '../ws/hub.js';
import { InputError } from '../http/v1/helpers.js';
import { metrics } from '../obs/metrics.js';
import { reportError } from '../obs/errors.js';

// TODO(spec): CA-28 freezes neither defaults nor response wrappers. Default to web
// verdict/playbook alerts at every level, with external notifications and trades off.
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  telegram: false, push: false, minLevel: 'info', kinds: ['verdict_change', 'playbook'],
};
const severity: Record<Level, number> = { info: 0, clear: 0, monitor: 1, danger: 2 };
const MeasuredTradeSchema = FeedItemSchema.pick({ wallet: true, label: true, sizeUsd: true });
export function quiet(settings: AlertSettings, now: number) {
  if (!settings.quietHoursUtc) return false;
  const [from, to] = settings.quietHoursUtc, hour = new Date(now).getUTCHours();
  // TODO(spec): equal quiet-hour endpoints mean no quiet period; overnight ranges wrap UTC midnight.
  return from < to ? hour >= from && hour < to : from > to && (hour >= from || hour < to);
}
interface Source { seq: string; source_key: string; source_kind: 'feed' | 'correction'; source_id: string; received_at: Date; attempts: number }
interface Candidate { alert: Omit<Alert, 'id' | 'ts' | 'read'>; coin: Address; wallet?: Address; correction: boolean }
export interface Delivery { account_id: string; seq: string; data: Alert; watch_kind: 'coin' | 'wallet'; watch_target: string; telegram_attempts: number }

/** API-owned durable consumer. Source ids are read from committed engine projections;
 * no labels, trades, playbook logic or Guard decisions are computed here. */
export class WatchAlertsService {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => Promise<void>;
  private closed = false;
  constructor(readonly db: ChainDb, readonly hub: Hub, readonly now: () => number = Date.now) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  async start(bus: EngineBus, polling = true) {
    this.unsubscribe = await bus.subscribe(message => {
      if (['card_updated', 'verdict_created', 'chain_block', 'chain_reorg', 'swap'].includes(message.topic)) {
        void this.poll().catch(error => reportError(error, { where: 'watch alerts' }));
      }
    });
    if (polling) {
      await this.poll();
      this.timer = setInterval(() => { void this.poll().catch(error => reportError(error, { where: 'watch alerts polling' })); }, 250);
      this.timer.unref();
    }
  }
  async drain() { for (;;) { const queue = this.queue; await queue; if (queue === this.queue) return; } }
  async close() { this.closed = true; clearInterval(this.timer); await this.unsubscribe?.(); await this.drain(); }
  async settings(account: string, db = this.db): Promise<AlertSettings> {
    const row = (await db.sql.query<{ data: unknown }>('SELECT data FROM alert_settings WHERE account_id=$1', [account])).rows[0];
    return AlertSettingsSchema.parse(row?.data ?? DEFAULT_ALERT_SETTINGS);
  }
  async saveSettings(account: string, input: AlertSettings) {
    const data = AlertSettingsSchema.parse(input);
    if (data.kinds.includes('crew_active')) throw new InputError('Crew alerts are available from Drop 2.');
    await this.serial(() => this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      await tx.sql.query(`INSERT INTO alert_settings(account_id,data) VALUES($1,$2)
        ON CONFLICT(account_id) DO UPDATE SET data=excluded.data,updated_at=now()`, [account, data]);
    }));
    return data;
  }
  async watches(account: string) {
    return (await this.db.sql.query<WatchBody>('SELECT kind,target FROM watches WHERE account_id=$1 ORDER BY kind,target', [account])).rows;
  }
  normalize(input: WatchBody): WatchBody {
    if (input.kind === 'crew') throw new InputError('Crew watches are available from Drop 2.');
    const target = AddressSchema.safeParse(input.target);
    if (!target.success) throw new InputError('Watch target must be a coin or wallet address.');
    return { kind: input.kind, target: target.data };
  }
  async add(account: string, input: WatchBody) {
    const body = this.normalize(input);
    await this.serial(() => this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      // Capture existing source ids before the new watch. Re-adding does not replay history.
      await this.capture(tx, body);
      await tx.sql.query(`INSERT INTO watches(account_id,kind,target,after_source)
        VALUES($1,$2,$3,(SELECT coalesce(max(seq),0) FROM alert_sources)) ON CONFLICT DO NOTHING`, [account, body.kind, body.target]);
    }));
    return body;
  }
  async remove(account: string, input: WatchBody) {
    const body = this.normalize(input);
    await this.serial(() => this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      await tx.sql.query('DELETE FROM watches WHERE account_id=$1 AND kind=$2 AND target=$3', [account, body.kind, body.target]);
      await tx.sql.query(`UPDATE alert_deliveries SET telegram_status='disabled',telegram_lease_until=NULL
        WHERE account_id=$1 AND watch_kind=$2 AND watch_target=$3 AND telegram_status='pending'`, [account, body.kind, body.target]);
    }));
  }
  private async capture(tx: ChainDb, extra?: WatchBody) {
    const targets = (await tx.sql.query<WatchBody>('SELECT DISTINCT kind,target FROM watches')).rows;
    if (extra) targets.push(extra);
    const coins = targets.filter(w => w.kind === 'coin').map(w => binary(w.target));
    const wallets = targets.filter(w => w.kind === 'wallet').map(w => w.target);
    if (!targets.length) return;
    // TODO(spec): Task 102 has not shipped flow_events in this checkout. Consume
    // confirmed, measured agent_trade Feed projections when supplied; do not infer
    // labels from swaps or invent an agent_flow_spike threshold/event.
    await tx.sql.query(`INSERT INTO alert_sources(source_key,source_kind,source_id)
      SELECT 'feed:'||f.id,'feed',f.id FROM read_feed f
      WHERE f.kind IN ('verdict','playbook','wash','agent_trade')
      AND (f.coin=ANY($1::bytea[]) OR (f.kind='agent_trade' AND lower(f.data->>'wallet')=ANY($2::text[])))
      AND NOT EXISTS(SELECT 1 FROM alert_sources s WHERE s.source_key='feed:'||f.id)
      ORDER BY f.block,f.id ON CONFLICT DO NOTHING`, [coins, wallets]);
    await tx.sql.query(`INSERT INTO alert_sources(source_key,source_kind,source_id)
      SELECT 'correction:'||e.id,'correction',e.id FROM verdict_events e JOIN verdicts v ON v.id=e.verdict_id
      WHERE v.coin=ANY($1::bytea[]) AND e.kind IN ('corrected','orphaned')
      AND NOT EXISTS(SELECT 1 FROM alert_sources s WHERE s.source_key='correction:'||e.id)
      ORDER BY e.block,e.id ON CONFLICT DO NOTHING`, [coins]);
  }
  private async candidate(tx: ChainDb, source: Source): Promise<Candidate | 'gone' | null> {
    if (source.source_kind === 'correction') {
      const row = (await tx.sql.query<{ coin: Uint8Array; block: string; kind: string; data: unknown; confirmed: boolean }>(`SELECT v.coin,e.block,e.kind,v.data,
        EXISTS(SELECT 1 FROM chain_blocks b WHERE b.number=e.block) AS confirmed
        FROM verdict_events e JOIN verdicts v ON v.id=e.verdict_id WHERE e.id=$1`, [source.source_id])).rows[0];
      if (!row) return 'gone';
      if (!row.confirmed) return null;
      const parsed = VerdictSchema.safeParse(row.data);
      if (!parsed.success) return null;
      const coin = hex(row.coin), verdict = parsed.data;
      // Corrections retain the original severity so a Danger-only owner sees its retraction.
      // TODO(spec): no correction kind is frozen; use verdict_change with explicit templated copy.
      return { coin, correction: true, alert: { kind: 'verdict_change', coin, level: verdict.level === 'pending' ? undefined : verdict.level,
        title: 'Verdict correction', body: 'A prior verdict was corrected or withdrawn. Open the coin for the current assessment.', url: `/coin/${coin}` } };
    }
    const row = (await tx.sql.query<{ coin: Uint8Array; block: string; kind: string; data: unknown; confirmed: boolean }>(`SELECT f.coin,f.block,f.kind,f.data,
      EXISTS(SELECT 1 FROM chain_blocks b WHERE b.number=f.block) AS confirmed FROM read_feed f WHERE f.id=$1`, [source.source_id])).rows[0];
    if (!row) return 'gone';
    if (!row.confirmed) return null;
    const coin = hex(row.coin);
    if (row.kind === 'verdict') {
      const parsed = VerdictSchema.safeParse(row.data);
      if (!parsed.success) return null;
      const verdict = parsed.data;
      if (verdict.level === 'pending') return 'gone'; // Pending is unavailable, never Clear.
      // TODO(spec): the first confirmed verdict counts as a verdict change; CA-28 does not specify a baseline notification.
      return { coin, correction: false, alert: { kind: 'verdict_change', level: verdict.level, coin,
        title: 'Verdict changed', body: `The watched coin has a ${verdict.level} verdict.`, url: `/coin/${coin}` } };
    }
    if (row.kind === 'playbook' || row.kind === 'wash') {
      const parsed = VerdictSchema.shape.playbooks.element.safeParse(row.data);
      if (!parsed.success) return null;
      const match = parsed.data;
      return { coin, correction: false, alert: { kind: 'playbook', level: match.level, coin,
        title: 'Playbook alert', body: `The watched coin matched ${match.id}.`, url: `/coin/${coin}` } };
    }
    if (row.kind === 'agent_trade') {
      const parsed = MeasuredTradeSchema.safeParse(row.data);
      if (!parsed.success || !parsed.data.wallet || parsed.data.sizeUsd === undefined || !Number.isFinite(parsed.data.sizeUsd) || parsed.data.sizeUsd < 0) return null;
      const trade = parsed.data;
      if (!trade.label) return null;
      if (trade.label !== 'declared_agent' && trade.label !== 'likely_agent') return 'gone';
      return { coin, wallet: trade.wallet, correction: false, alert: { kind: 'agent_trade', coin, wallet: trade.wallet, sizeUsd: trade.sizeUsd,
        title: 'Agent trade', body: `An agent traded $${trade.sizeUsd} on a watched target.`, url: `/coin/${coin}` } };
    }
    return 'gone';
  }
  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.serial(async () => {
      const emitted: { account: string; seq: number; alert: Alert; receivedAt: number }[] = [];
      await this.db.tx(async tx => {
        await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
        await this.capture(tx);
        const sources = (await tx.sql.query<Source>(`SELECT * FROM alert_sources WHERE processed_at IS NULL AND next_attempt_at<=now() ORDER BY seq LIMIT 100`)).rows;
        for (const source of sources) {
          const candidate = await this.candidate(tx, source);
          if (candidate === null) {
            // Unknown/enrichment-pending sources cannot monopolize the front of the queue.
            await tx.sql.query(`UPDATE alert_sources SET attempts=attempts+1,
              next_attempt_at=now()+least(60,power(2,least(attempts,8)) * 0.25) * interval '1 second' WHERE seq=$1`, [source.seq]);
            continue;
          }
          if (candidate !== 'gone') {
            const watches = (await tx.sql.query<{ account_id: string; kind: 'coin' | 'wallet'; target: string }>(`SELECT DISTINCT ON(account_id) account_id,kind,target FROM watches
              WHERE after_source<$1 AND ((kind='coin' AND target=$2) OR (kind='wallet' AND target=$3)) ORDER BY account_id,kind,target`,
            [source.seq, candidate.coin, candidate.wallet ?? null])).rows;
            for (const watch of watches) {
              const settings = await this.settings(watch.account_id, tx), alert = candidate.alert;
              if (alert.kind === 'agent_trade') {
                if (settings.agentTradeAboveUsd === undefined || alert.sizeUsd! <= settings.agentTradeAboveUsd) continue;
              } else if (!settings.kinds.includes(alert.kind)) continue;
              if (alert.level && severity[alert.level] < severity[settings.minLevel]) continue;
              // Quiet hours suppress toast creation; Telegram retries independently honor the current quiet period.
              if (quiet(settings, this.now())) continue;
              const data = AlertSchema.parse({ ...alert, id: randomUUID(), ts: new Date(this.now()).toISOString(), read: false });
              const result = await tx.sql.query<{ seq: string }>(`INSERT INTO alert_deliveries(account_id,seq,source_key,data,watch_kind,watch_target,telegram_status)
                VALUES($1,(SELECT coalesce(max(seq),0)+1 FROM alert_deliveries WHERE account_id=$1),$2,$3,$4,$5,$6)
                ON CONFLICT(account_id,source_key) DO NOTHING RETURNING seq`,
              [watch.account_id, source.source_key, data, watch.kind, watch.target, settings.telegram ? 'pending' : 'disabled']);
              if (result.rows.length) emitted.push({ account: watch.account_id, seq: Number(result.rows[0].seq), alert: data, receivedAt: new Date(source.received_at).getTime() });
            }
          }
          await tx.sql.query('UPDATE alert_sources SET processed_at=now() WHERE seq=$1', [source.seq]);
        }
      });
      // Never publish uncommitted delivery records. Reconnect recovery reads the durable owner stream.
      for (const event of emitted) {
        const sent = this.hub.publishAlert(event.account, event.seq, event.alert);
        if (sent) metrics.observe('alerts.discovery_to_ws_ms', Math.max(0, this.now() - event.receivedAt));
      }
      // Another API process can create the delivery. Each hub tails its own subscribers.
      for (const subscription of this.hub.alertSubscriptions()) {
        const rows = (await this.db.sql.query<{seq:string;data:Alert}>(`SELECT seq,data FROM alert_deliveries
          WHERE account_id=$1 AND seq>$2 ORDER BY seq LIMIT 100`, [subscription.accountId, subscription.seq])).rows;
        for (const row of rows) this.hub.publishAlert(subscription.accountId, Number(row.seq), AlertSchema.parse(row.data));
      }
    });
  }
  async history(account: string, after = 0) {
    const rows = (await this.db.sql.query<{ seq: string; data: unknown }>(`SELECT seq,data FROM alert_deliveries WHERE account_id=$1 AND seq>$2 ORDER BY seq LIMIT 101`, [account, after])).rows;
    const page = rows.slice(0, 100);
    return { rows: page.map(r => AlertSchema.parse(r.data)), cursor: rows.length > 100 ? Number(page.at(-1)!.seq) : null,
      seq: Number(page.at(-1)?.seq ?? after) };
  }
  async latestSeq(account: string) {
    return Number((await this.db.sql.query<{ seq: string }>('SELECT coalesce(max(seq),0) AS seq FROM alert_deliveries WHERE account_id=$1', [account])).rows[0].seq);
  }
  /** Notification consumers claim leases; only successful acknowledgements advance the durable cursor. */
  async claimTelegram(limit = 50): Promise<Delivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError('Invalid delivery limit');
    return this.serial(() => this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE watches IN SHARE ROW EXCLUSIVE MODE');
      const rows = (await tx.sql.query<Delivery>(`SELECT * FROM alert_deliveries WHERE telegram_status='pending'
        AND telegram_next_at<=now() AND (telegram_lease_until IS NULL OR telegram_lease_until<now())
        ORDER BY created_at,account_id,seq LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      const claimed: Delivery[] = [];
      for (const row of rows) {
        const settings = await this.settings(row.account_id, tx);
        const watch = (await tx.sql.query('SELECT 1 FROM watches WHERE account_id=$1 AND kind=$2 AND target=$3', [row.account_id, row.watch_kind, row.watch_target])).rows.length;
        const enabled = row.data.kind === 'agent_trade' ? settings.agentTradeAboveUsd !== undefined && row.data.sizeUsd! > settings.agentTradeAboveUsd : settings.kinds.includes(row.data.kind);
        if (!watch || !settings.telegram || !enabled || row.data.level && severity[row.data.level] < severity[settings.minLevel]) {
          await tx.sql.query(`UPDATE alert_deliveries SET telegram_status='disabled' WHERE account_id=$1 AND seq=$2`, [row.account_id, row.seq]);
        } else if (!quiet(settings, this.now())) {
          await tx.sql.query(`UPDATE alert_deliveries SET telegram_attempts=telegram_attempts+1,telegram_lease_until=now()+interval '30 seconds' WHERE account_id=$1 AND seq=$2`, [row.account_id, row.seq]);
          claimed.push({ ...row, telegram_attempts: row.telegram_attempts + 1, data: AlertSchema.parse(row.data) });
        }
      }
      return claimed;
    }));
  }
  async settleTelegram(delivery: Delivery, success: boolean) {
    await this.db.tx(async tx => {
      await tx.sql.query(`UPDATE alert_deliveries SET telegram_status=$3,telegram_lease_until=NULL,
        telegram_error=$4,telegram_next_at=now()+least(3600,power(2,least(telegram_attempts,12))) * interval '1 second'
        WHERE account_id=$1 AND seq=$2 AND telegram_status='pending' AND telegram_attempts=$5 AND telegram_lease_until>now()`,
      [delivery.account_id, delivery.seq, success ? 'sent' : 'pending', success ? null : 'delivery_failed', delivery.telegram_attempts]);
      await tx.sql.query(`INSERT INTO alert_consumer_cursors(account_id,consumer,seq)
        SELECT $1,'telegram',coalesce(max(seq),0) FROM alert_deliveries
        WHERE account_id=$1 AND seq<coalesce((SELECT min(seq) FROM alert_deliveries WHERE account_id=$1 AND telegram_status='pending'),9223372036854775807)
        ON CONFLICT(account_id,consumer) DO UPDATE SET seq=greatest(alert_consumer_cursors.seq,excluded.seq),updated_at=now()`, [delivery.account_id]);
    });
  }
}
