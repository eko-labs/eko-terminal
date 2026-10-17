import { createHash } from 'node:crypto';
import { loadRegistry, type AddressRegistry } from '@eko/chain';
import type { ErrorCode, GuardCheck, TradeQuote } from '@eko/shared';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { auditLog, tradingAllowlist } from '../db/schema.js';
import type { FlagService } from '../flags/service.js';

export type AllowlistRow = typeof tradingAllowlist.$inferSelect;
export class TradeAccessError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

/** Access only. Route, sanctions and mandatory Guard checks keep their own ownership. */
export class TradeAccessService {
  /**
   * Retain host ceilings/flags, wallet lookup, clock and accepted-target manifest (loading default
   * registry if omitted). Host-only construction; manifest errors can throw; no wallet
   * authentication or admission occurs yet.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(
    private readonly cfg: Config,
    private readonly flags: FlagService,
    private readonly lookup: (wallet: string) => Promise<AllowlistRow | undefined>,
    private readonly clock: () => number = Date.now,
    private readonly registry: AddressRegistry = loadRegistry(),
  ) {}

  /**
   * Wire lowercased wallet allowlist lookup to the supplied database. Host construction only;
   * address-manifest loading can throw before any admission check.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  static fromDb(cfg: Config, flags: FlagService, db: Db): TradeAccessService {
    return new TradeAccessService(cfg, flags, async wallet => (await db.select().from(tradingAllowlist).where(eq(tradingAllowlist.wallet, wallet)))[0]);
  }

  /**
   * AND the host live ceiling with the uncached durable trading switch. No wallet authentication;
   * durable flag read failures return false.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async liveEnabled(): Promise<boolean> {
    return this.cfg.LIVE_TRADING_ENABLED && await this.flags.isOpsOn('trading_live');
  }

  /**
   * Project the current beta/public per-trade cap and absolute ceiling. This is informational, not
   * allowlist admission; caller supplies wallet identity. Allowlist read failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async cap(wallet?: string | null): Promise<number> {
    const row = this.cfg.TRADING_ALLOWLIST_ONLY && wallet ? await this.lookup(wallet.toLowerCase()) : undefined;
    return this.capFor(row);
  }

  private capFor(row?: AllowlistRow): number {
    let cap = 0;
    if (this.cfg.TRADING_ALLOWLIST_ONLY) {
      cap = row ? Math.min(row.capUsd, this.cfg.tradeCaps.beta.defaultCapUsd[row.role]) : Math.max(...Object.values(this.cfg.tradeCaps.beta.defaultCapUsd));
    } else if (this.cfg.TRADE_CAPS_FROM) {
      const hours = (this.clock() - Date.parse(this.cfg.TRADE_CAPS_FROM)) / 3_600_000;
      for (const step of this.cfg.tradeCaps.public) if (hours >= step.afterHours) cap = step.perTradeUsd;
    }
    return Number.isFinite(cap) && cap >= 0 ? Math.min(cap, this.cfg.TRADE_MAX_USD ?? Infinity) : 0;
  }

  /**
   * Return the verified routers and spenders the web may send to: the v3 router with accepted router02 wiring (router and
   * spender), and, when the v4 PoolManager, quoter, UniversalRouter and Permit2 are all verified, the UniversalRouter as a
   * router and Permit2 as a spender (its address too, for the Permit2 approval step). Public configuration read; it
   * neither checks deployed code nor authorizes a wallet. Ineligible manifests return empty lists.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  verifiedTargets(): { routers: string[]; spenders: string[]; permit2?: string } {
    // A Pons-curve quote's only other target is the curve it names (web tradeFlow); the v4 route re-checks its wiring per quote.
    const entry = this.registry.data.uniswapV3.swapRouter02;
    const routers: string[] = entry.verified && entry.check === 'router02_wiring' && entry.address !== 'TODO' ? [entry.address] : [];
    const spenders = [...routers];
    const v4 = this.registry.data.uniswapV4, ok = (e: typeof entry) => Boolean(e.verified) && e.check === 'code' && e.address !== 'TODO';
    if (ok(v4.poolManager) && ok(v4.v4Quoter) && ok(v4.universalRouter) && ok(v4.permit2)) {
      routers.push(v4.universalRouter.address); spenders.push(v4.permit2.address);
      return { routers, spenders, permit2: v4.permit2.address };
    }
    return { routers, spenders };
  }

  /**
   * Return a named refusal for demo, paused, unlisted, nonpositive/nonfinite or over-cap requests,
   * otherwise null. Caller must bind wallet to authenticated identity; this does not check routes,
   * sanctions or Guard. Allowlist failures reject; runtime flag failures close trading.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async refusal(wallet: string | null | undefined, amountUsd: number, demo = false): Promise<TradeAccessError | null> {
    if (demo) return new TradeAccessError('forbidden', 'Demo sessions cannot trade');
    if (!await this.liveEnabled()) return new TradeAccessError('trading_paused', 'Live trading paused');
    const row = this.cfg.TRADING_ALLOWLIST_ONLY && wallet ? await this.lookup(wallet.toLowerCase()) : undefined;
    if (this.cfg.TRADING_ALLOWLIST_ONLY && !row)
      return new TradeAccessError('not_allowlisted', 'Wallet is not on the trading allowlist');
    const cap = this.capFor(row);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || cap <= 0 || amountUsd > cap)
      return new TradeAccessError('trade_cap_exceeded', 'Trade exceeds the effective per-trade cap');
    return null;
  }

  /**
   * Throw the current admission refusal, checking demo, runtime ceiling/switch, membership and
   * amount cap. Caller supplies authenticated wallet identity; storage failures reject and no
   * transaction is signed.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async assertOrder(wallet: string | null | undefined, amountUsd: number, demo = false): Promise<void> {
    const refusal = await this.refusal(wallet, amountUsd, demo);
    if (refusal) throw refusal;
  }

  /** Packet 075 can preserve quote/verdict/fee data while removing binding on access refusal.
   * @remarks
   * Recheck admission and strip binding while appending a refusal check when access fails; preserve
   * other quote data. Caller binds identity; database failure rejects. Passing access alone does not
   * supply Guard/probe checks.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async informationalQuote(quote: TradeQuote, demo = false): Promise<TradeQuote> {
    const refusal = await this.refusal(quote.account, quote.amountUsd, demo);
    if (!refusal) return quote;
    const check: GuardCheck = { code: refusal.code, status: 'refuse', label: refusal.message };
    return { ...quote, binding: false, guard: { decision: 'refuse', checks: [...quote.guard.checks, check] } };
  }
}

/** Snapshot every process load/config release in existing append-only audit storage. No secrets or paths.
 * @remarks
 * Append a hash and nonsecret cap/ceiling snapshot on process configuration load. Host-only call,
 * no wallet authorization; database failures reject.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export async function auditTradeConfig(db: Db, cfg: Config) {
  const data = { caps: cfg.tradeCaps, from: cfg.TRADE_CAPS_FROM ?? null, ceiling: cfg.TRADE_MAX_USD ?? null,
    allowlistOnly: cfg.TRADING_ALLOWLIST_ONLY, liveCeiling: cfg.LIVE_TRADING_ENABLED };
  await db.insert(auditLog).values({ action: 'trading.config_loaded', data: { ...data, hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') } });
}
