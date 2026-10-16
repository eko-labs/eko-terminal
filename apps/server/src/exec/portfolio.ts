import { and, desc, eq } from 'drizzle-orm';
import { PAPER_QUOTE_ASSET, PAPER_STARTING_CASH, type Balance, type Fill, type Position, type TradingMode } from '@eko/shared';
import type { Db } from '../db/client.js';
import { fills, paperBalances, positions } from '../db/schema.js';
import { accountSpotFill } from './position-accounting.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Applies a fill to a spot position (average-cost method). Selling never takes quantity below zero. */
export async function applyFillToPosition(
  tx: Tx | Db,
  accountId: string,
  mode: TradingMode,
  market: string,
  side: 'buy' | 'sell',
  baseQty: number,
  quoteQty: number,
  fee: number,
) {
  const [cur] = await tx.select().from(positions).where(and(eq(positions.accountId, accountId), eq(positions.mode, mode), eq(positions.market, market)));
  const { quantity, costBasis, realizedPnl: realized } = accountSpotFill({
    quantity: cur?.quantity ?? 0, costBasis: cur?.costBasis ?? 0, realizedPnl: cur?.realizedPnl ?? 0,
  }, side, baseQty, quoteQty, fee);
  const avgCost = quantity > 0 ? costBasis / quantity : 0;
  await tx
    .insert(positions)
    .values({ accountId, mode, market, quantity, avgCost, costBasis, realizedPnl: realized })
    .onConflictDoUpdate({
      target: [positions.accountId, positions.mode, positions.market],
      set: { quantity, avgCost, costBasis, realizedPnl: realized, updatedAt: new Date() },
    });
}

export class PortfolioService {
  /**
   * Retain database for account-scoped simulated balances and position/fill reads. Host-only
   * construction; no account authentication/query occurs here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(private db: Db) {}

  /**
   * Idempotently provision initial simulated quote balance for the supplied account. Caller
   * authenticates account; SQL failures reject. No real funds are created.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async ensurePaperAccount(accountId: string) {
    await this.db.insert(paperBalances).values({ accountId, asset: PAPER_QUOTE_ASSET, amount: PAPER_STARTING_CASH }).onConflictDoNothing();
  }

  /**
   * Provision then read only this account's simulated balances. Caller authenticates account;
   * database failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async paperBalances(accountId: string): Promise<Balance[]> {
    await this.ensurePaperAccount(accountId);
    const rows = await this.db.select().from(paperBalances).where(eq(paperBalances.accountId, accountId));
    return rows.map((r) => ({ asset: r.asset, amount: r.amount }));
  }

  /**
   * Read account/mode positions and derive optional unrealized PnL using caller-supplied marks.
   * Caller authenticates account and trusts the mark provider; SQL or mark callback failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async positions(accountId: string, mode: TradingMode, marks: (market: string) => number | null): Promise<Position[]> {
    const rows = await this.db.select().from(positions).where(and(eq(positions.accountId, accountId), eq(positions.mode, mode)));
    return rows
      .filter((r) => r.quantity > 0 || r.realizedPnl !== 0)
      .map((r) => {
        const mark = marks(r.market);
        return {
          mode: r.mode,
          market: r.market,
          asset: r.market.split('-')[0]!,
          quantity: r.quantity,
          avgCost: r.avgCost,
          costBasis: r.costBasis,
          realizedPnl: r.realizedPnl,
          markPrice: mark,
          unrealizedPnl: mark !== null && r.quantity > 0 ? r.quantity * mark - r.costBasis : null,
          updatedAt: r.updatedAt.getTime(),
        };
      });
  }

  /**
   * Read account/mode fill history newest first with the supplied limit. Caller authenticates
   * account; SQL failures reject and the limit is not independently validated.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async fills(accountId: string, mode: TradingMode, limit = 200): Promise<Fill[]> {
    const rows = await this.db
      .select()
      .from(fills)
      .where(and(eq(fills.accountId, accountId), eq(fills.mode, mode)))
      .orderBy(desc(fills.at))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      mode: r.mode,
      market: r.market,
      side: r.side,
      price: r.price,
      baseQty: r.baseQty,
      quoteQty: r.quoteQty,
      fee: r.fee,
      feeAsset: r.feeAsset,
      txHash: r.txHash,
      at: r.at.getTime(),
    }));
  }

  /** Resets the PAPER account only. Order and fill history is kept (and remains labelled paper).
   * @remarks
   * Transactionally reset only simulated balances/positions, retaining order/fill history. Caller
   * authenticates account; SQL failures reject without a partial transaction commit.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async resetPaper(accountId: string) {
    await this.db.transaction(async (tx) => {
      await tx.delete(paperBalances).where(eq(paperBalances.accountId, accountId));
      await tx.delete(positions).where(and(eq(positions.accountId, accountId), eq(positions.mode, 'paper')));
      await tx.insert(paperBalances).values({ accountId, asset: PAPER_QUOTE_ASSET, amount: PAPER_STARTING_CASH });
    });
  }
}
