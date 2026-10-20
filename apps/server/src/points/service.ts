import type { ChainDb } from '@eko/db';
import { PointCategorySchema, PointsRatesSchema, type PointCategory, type PointsRates } from './config.js';

type Credit = { accountId: string; sourceId: string; occurredAt: string; category: PointCategory; units: number };
type LedgerRow = { id: string; account_id: string; category: PointCategory; source_id: string; points: number; occurred_at: Date; reversal_of: string | null };

/** Internal earning hooks only. Producers supply authoritative facts, never HTTP claims. */
export class PointsService {
  private readonly rates: PointsRates;
  constructor(readonly db: ChainDb, rates: PointsRates = {}, private readonly activeFrom?: string,
    private readonly now: () => number = Date.now) {
    this.rates = PointsRatesSchema.parse(rates);
    if (activeFrom && !Number.isFinite(Date.parse(activeFrom))) throw new Error('Invalid points activation');
  }
  private async credit(tx: ChainDb, event: Credit): Promise<LedgerRow | undefined> {
    const category = PointCategorySchema.parse(event.category), at = Date.parse(event.occurredAt);
    if (!event.sourceId || event.sourceId.length > 256 || !Number.isFinite(at) || at > this.now() ||
      !Number.isFinite(event.units) || event.units <= 0) throw new Error('Invalid points event');
    const rate = this.rates[category];
    if (!this.activeFrom || at < Date.parse(this.activeFrom) || !rate?.pointsPerUnit || !rate.dailyCapPoints) return;
    // The account row serializes cap checks across processes and earning hooks.
    const owner = (await tx.sql.query<{kind:string}>('SELECT kind FROM accounts WHERE id=$1 FOR UPDATE', [event.accountId])).rows[0];
    if (owner?.kind !== 'wallet') return;
    const duplicate = (await tx.sql.query<LedgerRow>('SELECT * FROM points_ledger WHERE category=$1 AND source_id=$2 AND reversal_of IS NULL', [category,event.sourceId])).rows[0];
    if (duplicate) return duplicate.account_id === event.accountId ? duplicate : undefined;
    const day = new Date(at).toISOString().slice(0,10);
    // Reversals do not replenish the earning cap, preventing reverse/recredit farming.
    const earned = (await tx.sql.query<{n:string}>('SELECT coalesce(sum(points),0)::text AS n FROM points_ledger WHERE account_id=$1 AND category=$2 AND earning_day=$3 AND reversal_of IS NULL', [event.accountId,category,day])).rows[0]!;
    const points = Math.min(Math.floor(event.units * rate.pointsPerUnit), rate.dailyCapPoints - Number(earned.n));
    if (points <= 0) return;
    return (await tx.sql.query<LedgerRow>(`INSERT INTO points_ledger(account_id,category,source_id,points,occurred_at,earning_day)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`, [event.accountId,category,event.sourceId,points,event.occurredAt,day])).rows[0];
  }
  /** Called inside the journal transaction, after the de-identified share is written. */
  sharedJournal(tx: ChainDb, event: Omit<Credit, 'category' | 'units'>) {
    return this.credit(tx, {...event, category:'shared_journal', units:1});
  }
  guardedVolume(event: Omit<Credit, 'category' | 'units'> & {
    volumeUsd: number; confirmed: boolean; guarded: boolean; roundTrip: boolean | null; crewWallet: boolean | null;
  }) {
    if (event.confirmed !== true || event.guarded !== true || event.roundTrip !== false || event.crewWallet !== false) return Promise.resolve(undefined);
    return this.db.tx(tx => this.credit(tx, {...event,category:'guarded_volume',units:event.volumeUsd}));
  }
  confirmedGhostTip(event: Omit<Credit, 'category' | 'units'> & { confirmed: boolean }) {
    if (event.confirmed !== true) return Promise.resolve(undefined);
    return this.db.tx(tx => this.credit(tx, {...event,category:'ghost_tip',units:1}));
  }
  async scanCreated(scanId: string, accountId: string, occurredAt: string) {
    // TODO(spec): Scan jobs deduplicate by target; creator attribution is unspecified.
    // Attribute the first authenticated creation request, never a subsequent open.
    await this.db.sql.query(`INSERT INTO points_scan_creators(scan_id,account_id,created_at)
      SELECT $1,id,$3 FROM accounts WHERE id=$2 AND kind='wallet' ON CONFLICT DO NOTHING`, [scanId,accountId,occurredAt]);
  }
  async scanOpened(scanId: string, viewerAccountId: string, occurredAt: string) {
    return this.db.tx(async tx => {
      const creator = (await tx.sql.query<{account_id:string;kind:string}>(`SELECT c.account_id,a.kind FROM points_scan_creators c
        JOIN accounts a ON a.id=$2 WHERE c.scan_id=$1`, [scanId,viewerAccountId])).rows[0];
      if (!creator || creator.kind !== 'wallet' || creator.account_id === viewerAccountId) return;
      // TODO(spec): Open frequency/anonymous eligibility is unspecified. Count one
      // open per verified account per scan; guests and creator opens earn nothing.
      return this.credit(tx, {accountId:creator.account_id,category:'opened_scan',sourceId:`${scanId}:${viewerAccountId}`,occurredAt,units:1});
    });
  }
  async reverse(creditId: string, sourceId: string, occurredAt: string) {
    if (!sourceId || sourceId.length > 256 || !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > this.now()) throw new Error('Invalid points reversal');
    return this.db.tx(async tx => {
      const original = (await tx.sql.query<LedgerRow>('SELECT * FROM points_ledger WHERE id=$1 AND reversal_of IS NULL', [creditId])).rows[0];
      if (!original) return;
      await tx.sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [original.account_id]);
      return (await tx.sql.query<LedgerRow>(`INSERT INTO points_ledger(account_id,category,source_id,points,occurred_at,earning_day,reversal_of)
        SELECT account_id,category,$2,-points,$3,earning_day,id FROM points_ledger WHERE id=$1
        ON CONFLICT DO NOTHING RETURNING *`, [creditId,sourceId,occurredAt])).rows[0];
    });
  }
}
