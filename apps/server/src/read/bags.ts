import { withRpcOrigin } from '@eko/chain';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { binary, hex, maintainedBalance, ScanJobs, ScanQueueFull, type ScanJob } from '@eko/db';
import { BagReportSchema, PublicBagReportSchema, findingsFirst, type Address, type BagReport, type CoinCard, type CoinSummary, type PublicBagReport } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import { erc20Abi, formatUnits, type PublicClient } from 'viem';
import type { Db } from '../db/client.js';
import { bagShares } from '../db/schema.js';
import type { ReadStore } from './store.js';

// TODO(spec): CA-6 does not set bounds/paging/retry semantics. Use 100 indexed candidates
// per page, four concurrent balance reads, ten scan admissions per request, and an
// explicit ?retry=true to rearm failed jobs within the existing queue capacity.
const PAGE_SIZE = 100, SCANS_PER_REQUEST = 10;
type Holding = BagReport['holdings'][number];
interface Candidate { token: Uint8Array; name: string | null; symbol: string | null; decimals: number | null;
  launchpad: string | null; curve: Uint8Array | null; graduated_block: string | null; price: number | null }

/** Decimal string arithmetic keeps rounding correct even above Number.MAX_SAFE_INTEGER. */
export function roundSharedBalance(balance: string): string {
  if (!/^\d+(\.\d+)?$/.test(balance)) throw new Error('Invalid balance');
  const [whole, fraction = ''] = balance.split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  let rounded = digits;
  if (digits.length > 2) rounded = String(Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0)) + '0'.repeat(digits.length - 2);
  rounded = rounded.padStart(fraction.length + 1, '0');
  const at = rounded.length - fraction.length;
  return fraction.length ? `${rounded.slice(0, at)}.${rounded.slice(at)}`.replace(/\.?0+$/, '') : rounded;
}

/** An allowlist prevents future private/card fields entering public responses or storage. */
export function redactBagReport(report: BagReport, options: { includeValues: boolean; includeWallet: boolean }): PublicBagReport {
  return PublicBagReportSchema.parse({
    ...(options.includeWallet ? { wallet: report.wallet } : {}), asOfBlock: report.asOfBlock,
    coverage: report.coverage, cursor: report.cursor,
    holdings: report.holdings.map(row => {
      const c = row.coin;
      return {
        coin: { address: c.address, name: c.name, symbol: c.symbol, launchpad: c.launchpad, stage: c.stage,
          curvePct: c.curvePct, change1hPct: c.change1hPct, verdict: c.verdict, verdictPending: c.verdictPending,
          topPlaybook: c.topPlaybook, ageSec: c.ageSec, evaluatedPlaybooks: c.evaluatedPlaybooks,
          unavailable: c.unavailable, priceUnavailable: c.priceUnavailable,
          ...(options.includeValues ? { priceUsd: c.priceUsd, liquidityUsd: c.liquidityUsd, marketCapUsd: c.marketCapUsd } : {}) },
        balance: row.balance === null ? null : roundSharedBalance(row.balance), balanceStatus: row.balanceStatus,
        status: row.status, unavailable: row.unavailable, error: row.error,
        playbooks: row.playbooks, exitCost1kPct: row.exitCost1kPct,
        ...(options.includeValues && row.valueUsd !== undefined ? { valueUsd: row.valueUsd } : {}),
      };
    }),
    summary: { coins: report.summary.coins, flagged: report.summary.flagged, danger: report.summary.danger,
      ...(options.includeValues && report.summary.valueUsd !== undefined ? { valueUsd: report.summary.valueUsd } : {}) },
  });
}

export class BagsService {
  readonly jobs: ScanJobs;
  constructor(readonly store: ReadStore, readonly db: Db, readonly client: PublicClient) {
    this.jobs = new ScanJobs(store.db, () => store.now());
  }
  private async queue(coin: Address, retry: boolean): Promise<ScanJob> {
    const job = await this.jobs.ensure(coin, coin, 'pending');
    if (!retry || job.phase !== 'waiting' || !job.last_error) return job;
    return this.store.db.tx(async tx => {
      // Serialize with ScanJobs admission; owner retries cannot exceed its bound.
      await tx.sql.query('LOCK TABLE scan_jobs IN SHARE ROW EXCLUSIVE MODE');
      const current = (await tx.sql.query<ScanJob>('SELECT * FROM scan_jobs WHERE id=$1', [job.id])).rows[0];
      if (!current || current.phase !== 'waiting' || !current.last_error) return current ?? job;
      const active = (await tx.sql.query<{ n: string }>("SELECT count(*) AS n FROM scan_jobs WHERE phase IN ('queued','acquiring','evaluating','running')")).rows[0];
      if (Number(active.n) >= this.jobs.capacity) throw new ScanQueueFull();
      return (await tx.sql.query<ScanJob>(`UPDATE scan_jobs SET phase='queued',attempts=0,last_error=NULL,finished_at=NULL
        WHERE id=$1 AND phase='waiting' AND last_error IS NOT NULL RETURNING *`, [job.id])).rows[0] ?? job;
    });
  }
  async report(wallet: Address, input: { cursor?: Address; retry?: boolean } = {}): Promise<BagReport> {
    const chain = this.store.db;
    const pin = (await chain.sql.query<{ number: string; hash: Uint8Array }>('SELECT number,hash FROM chain_blocks ORDER BY number DESC LIMIT 1')).rows[0];
    const block = pin ? BigInt(pin.number) : 0n;
    const candidates = (await chain.sql.query<Candidate>(`SELECT b.token,t.name,t.symbol,t.decimals,t.launchpad,t.curve,t.graduated_block,p.close AS price
      FROM balances b LEFT JOIN tokens t ON t.address=b.token
      LEFT JOIN LATERAL (SELECT close FROM bars_1m WHERE coin=b.token AND last_block<=$2 ORDER BY minute DESC LIMIT 1) p ON true
      WHERE b.holder=$1 AND b.amount<>0 AND b.last_block<=$2 AND ($3::bytea IS NULL OR b.token>$3)
      ORDER BY b.token LIMIT 101`, [binary(wallet), block.toString(), input.cursor ? binary(input.cursor) : null])).rows;
    const page = candidates.slice(0, PAGE_SIZE);
    const holdings: Holding[] = [];
    // Queue admission stays sequential; RPC reads are performed in bounded batches.
    let admissions = 0;
    for (let offset = 0; offset < page.length; offset += 4) {
      const batch = await Promise.all(page.slice(offset, offset + 4).map(async candidate => {
        const address = hex(candidate.token) as Address;
        let card: CoinCard | null = null, cardError = false;
        try { card = await this.store.card(address); if (card && card.freshness.block > Number(block)) card = null; }
        catch { cardError = true; }
        const coin: CoinSummary = {
          address, name: toUntrusted(candidate.name ?? '', 120), symbol: toUntrusted(candidate.symbol ?? '', 32),
          launchpad: card?.identity.launchpad ?? (candidate.launchpad === 'pons' ? 'pons' : 'other'), stage: candidate.curve && !candidate.graduated_block ? 'curve' : 'graduated',
          priceUsd: candidate.price ?? 0, priceUnavailable: candidate.price === null,
          change1hPct: 0, liquidityUsd: 0, verdict: card?.verdict.level ?? 'pending', verdictPending: !card || card.verdict.level === 'pending',
          topPlaybook: card ? findingsFirst(card.verdict.playbooks)[0]?.id : undefined, ageSec: card?.freshness.ageSec ?? 0,
          evaluatedPlaybooks: card?.verdict.evaluatedPlaybooks, unavailable: ['liquidity', 'change', 'marketCap'],
        };
        let balance: string | null = null, balanceStatus: Holding['balanceStatus'] = 'unavailable';
        if (pin && candidate.decimals !== null && candidate.decimals >= 0 && candidate.decimals <= 255) {
          try {
            const raw = await maintainedBalance(chain,address,wallet,block) ?? await withRpcOrigin('server.bags.L105',()=>this.client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet], blockNumber: block }));
            balance = formatUnits(raw, candidate.decimals); balanceStatus = 'observed';
          } catch { balanceStatus = 'error'; }
        }
        if (balance === '0') return null;
        const meta = card?.meta?.tradeability;
        const exitCost = meta && meta.asOfBlock <= Number(block) && !meta.unavailable && !meta.missing?.includes('exitCostPct') && !meta.missing?.includes('exitCostPct.usd1k') ? card!.tradeability.exitCostPct.usd1k : null;
        const value = balance !== null && candidate.price !== null ? Number(balance) * candidate.price : undefined;
        const row: Holding = { coin, balance, balanceStatus, status: cardError ? 'error' : card ? 'ready' : 'pending',
          // Findings only, most severe first: an Info observation is not a flag on a holding.
          playbooks: card ? findingsFirst(card.verdict.playbooks).map(p => p.id) : [], exitCost1kPct: exitCost,
          unavailable: [...(balance === null ? ['balance' as const] : []), ...(value === undefined || !Number.isFinite(value) ? ['value' as const] : []),
            ...(!card ? ['card' as const] : []), ...(exitCost === null ? ['exitCost' as const] : [])],
          ...(value !== undefined && Number.isFinite(value) ? { valueUsd: value } : {}),
          ...(cardError ? { error: 'card_unavailable' as const } : balanceStatus === 'error' ? { error: 'balance_unavailable' as const } : {}) };
        if (exitCost === null) coin.unavailable!.push('exitCost');
        return row;
      }));
      for (const row of batch) {
        if (!row) continue;
        if (row.unavailable?.includes('card') && row.error !== 'card_unavailable') {
          // Existing jobs do not consume fresh admission slots, so later rows progress.
          const existing = (await chain.sql.query<ScanJob>('SELECT * FROM scan_jobs WHERE coin=$1', [binary(row.coin.address)])).rows[0];
          const needsAdmission = !existing || (input.retry && existing.phase === 'waiting' && !!existing.last_error);
          if (!needsAdmission || admissions < SCANS_PER_REQUEST) {
            try {
              const job = needsAdmission ? await this.queue(row.coin.address, !!input.retry) : existing;
              if (needsAdmission) admissions++;
              if (job.status === 'not_found') row.status = 'unavailable';
              else if (job.last_error) { row.status = 'error'; row.error = 'scan_failed'; }
            } catch (error) { row.status = 'error'; row.error = error instanceof ScanQueueFull ? 'scan_queue_full' : 'scan_failed'; }
          }
        }
        holdings.push(row);
      }
    }
    // Block-number reads are checked against the indexed hash after acquisition.
    const canonical = pin && (await chain.sql.query<{ hash: Uint8Array }>('SELECT hash FROM chain_blocks WHERE number=$1', [block.toString()])).rows[0];
    if (pin && (!canonical || hex(canonical.hash) !== hex(pin.hash))) for (const row of holdings) {
      row.balance = null; row.balanceStatus = 'unavailable'; delete row.valueUsd;
      row.unavailable = [...new Set([...(row.unavailable ?? []), 'balance' as const, 'value' as const])];
    }
    const total = holdings.every(r => r.valueUsd !== undefined) ? holdings.reduce((sum, r) => sum + r.valueUsd!, 0) : undefined;
    return BagReportSchema.parse({ wallet, asOfBlock: Number(block), holdings, coverage: 'indexed_candidates',
      cursor: candidates.length > PAGE_SIZE ? hex(page.at(-1)!.token) : null,
      summary: { coins: holdings.length, flagged: holdings.filter(r => r.playbooks.length > 0).length,
        danger: holdings.filter(r => r.coin.verdict === 'danger').length,
        ...(total !== undefined && Number.isFinite(total) ? { valueUsd: total } : {}) } });
  }
  async share(wallet: Address, options: { includeValues: boolean; includeWallet: boolean }) {
    const report = await this.report(wallet), id = randomUUID(), shareUrl = `/bags/r/${id}`;
    const snapshot = { ...redactBagReport(report, options), shareUrl };
    await this.db.insert(bagShares).values({ id, snapshot });
    return { id, shareUrl };
  }
  async publicReport(id: string) {
    const [row] = await this.db.select({ snapshot: bagShares.snapshot }).from(bagShares).where(eq(bagShares.id, id));
    return row ? PublicBagReportSchema.parse(row.snapshot) : null;
  }
}
