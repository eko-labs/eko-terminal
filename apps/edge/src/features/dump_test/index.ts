import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import type { FastifyReply } from 'fastify';
import type { Alert } from '@eko/shared';
import { toUntrusted, UNTRUSTED_LIMITS } from '@eko/untrusted';
import { limiter } from '../../accounts.js';
import { transferCoverage } from '../../coverage.js';
import { balancesOf, type FundingLookup, type InsiderOptions } from '../../insiders.js';
import { budgetedRpc } from '../../trade.js';
import { loadRobinhoodTradeAddresses, type RobinhoodTradeAddresses } from '../../chains/robinhood/trade.js';
import type { CoinState, Rpc } from '../../tracker.js';
import type { Feature, FeatureContext } from '../index.js';
import { curveDump, fullRangeReserves, GROUPS, insiderHoldings, poolDump, PONS_HOOK_SELL_FEE, quoterDelta, quoterDump, readCurve,
  type DumpOutcome, type GroupId, type Holdings } from './dump.js';

/**
 * Dump test (flag `dump_test`): for every coin EKO follows, what the price would do if the coin's insiders sold
 * everything they hold right now, per group (dump.ts) and all together, and what $100 held today would then be worth.
 * GET /v2/coins/:address/dump answers in full; each Radar row carries the all-insiders figure (RadarRow.extras.dump_test).
 *
 * When a figure is worked out: per coin at most every REFRESH_SEC while it trades, sooner (EARLY_GAP_SEC) when a transfer
 * touches one of its insiders, every IDLE_SEC while nothing changes (a coin that does not trade keeps its figure). The
 * background pass runs every TICK_MS over the coins that are due: those on the Radar list and those someone opened or
 * is alerted about first, then the rest by their last trade. One answer per coin, shared by every viewer.
 *
 * Cost: holdings are sums over the coin's transfers in memory (no RPC). A graduated Pons coin's full-range pool is
 * closed form from the cached check's pool reading and the tracker's live price (no RPC). A coin on its curve costs one
 * eth_call (Multicall3: the curve's state); a coin in another native-ETH v4 pool one eth_call (Multicall3: slot0 and the
 * V4Quoter's sells). All of these together stay within RPC_BUDGET; past it a coin keeps its last figure until the next
 * pass. No figure for a coin whose history does not start at launch (holdings would be partial), one quoted in a token,
 * or one off Robinhood Chain.
 *
 * Alerts: an account is alerted in-site, for the coins it watches and the coins its wallet holds, when the all-insiders
 * figure crosses ALERT.crossPct or rises by ALERT.risePts since the last alert-free reading; one per coin per
 * ALERT.cooldownSec and at most ALERT.perHour per account.
 */
export const REFRESH_SEC = 45, EARLY_GAP_SEC = 5, IDLE_SEC = 600, TICK_MS = 3000, PER_TICK = 60, CACHE_MAX = 3000, RATE_PER_MIN = 60;
export const RPC_BUDGET = { perMin: 90, inFlight: 3 } as const;
export const ALERT = { crossPct: 50, risePts: 20, cooldownSec: 1800, perHour: 10 } as const;
/** How often the watchlists and account wallets are read again. */
export const RELOAD_SEC = 30;
/** A coin opened or listed within this long is computed before the rest. */
const WANTED_SEC = 120;

export type Venue = 'curve' | 'pool' | 'quoter';
export type NotMeasured = 'partial_history' | 'unknown_venue' | 'unavailable';
export interface GroupFigure {
  id: GroupId | 'all'; wallets: number;
  /** Tokens held (base units, decimal string) and their share of supply (percent). */
  tokens: string; sharePct: number;
  /** The price change if the group sold everything at once (percent, ≤ 0), and what $100 held today would then be worth. */
  changePct: number | null; usd100: number | null;
  /** The venue would run out of ETH before the group sold it all. */
  drains?: true;
}
export type DumpReply = { version: 1; coin: Address; at: string; asOfBlock: number } & (
  | { measured: true; venue: Venue; groups: GroupFigure[]; all: GroupFigure; sellFeePct: number | null; funding: boolean }
  | { measured: false; reason: NotMeasured });
/** The Radar row's figure (RadarRow.extras.dump_test). */
export interface DumpSummary { changePct: number; usd100: number; sharePct: number }

const fail = (reply: FastifyReply, status: number, error: string, message: string) => reply.code(status).send({ error, message });
const pct2 = (v: bigint, supply: bigint) => supply > 0n ? Number((v * 1_000_000n) / supply) / 10_000 : 0;

export interface DumpOptions { now?: () => number; trade?: RobinhoodTradeAddresses & { ponsHook?: Address } }

interface Entry {
  at: number; state: string; reply: DumpReply; insiders: Set<string>;
  /** The last transfer read for insiders, and whether one touched them since `at`. */
  lastFlow: CoinState['flows'][number] | undefined; dirty: boolean;
  /** The all-insiders change when last alerted on (or first seen), for the rise rule. */
  base: number | null;
  /** After a failed read (budget or provider): when to try again; the last figure stands meanwhile. */
  retryAt?: number;
}

export function setup(ctx: FeatureContext, opts: DumpOptions = {}) {
  const { app, edge, store } = ctx;
  const now = opts.now ?? (() => Date.now() / 1000);
  const rpc: Rpc | null = ctx.rpc ? budgetedRpc(ctx.rpc, RPC_BUDGET) : null;
  let trade: (RobinhoodTradeAddresses & { ponsHook?: Address }) | null = opts.trade ?? null;
  const addresses = () => trade ??= loadRobinhoodTradeAddresses();
  const funding: FundingLookup | undefined = store ? (w) => {
    const f = store.funder(w);
    return f ? { funder: f.funder, fundedTs: f.fundedTs, hub: f.funder ? store.isHub(f.funder) : false } : undefined;
  } : undefined;
  const options = (coin: CoinState): InsiderOptions => ({ excluded: edge.chain.excluded(coin), sniperBlocks: edge.chain.profile.sniperBlocks,
    bundle: edge.chain.profile.playbooks.bundle_dump, ...(funding ? { funding } : {}) });

  const cache = new Map<string, Entry>(), jobs = new Map<string, Promise<DumpReply>>(), wanted = new Map<string, number>();
  const stateOf = (c: CoinState) => `${c.trades.length}:${c.trades.at(-1)?.tx ?? ''}:${c.flows.length}:${c.flows.at(-1)?.tx ?? ''}`;

  /** Whether the coin's figure should be worked out again now. */
  const due = (coin: CoinState, t: number) => {
    const e = cache.get(coin.token.toLowerCase());
    if (!e) return true;
    const age = t - e.at;
    if (e.retryAt !== undefined) return t >= e.retryAt;
    if (e.state === stateOf(coin)) return age >= IDLE_SEC;
    return age >= (touched(coin, e) ? EARLY_GAP_SEC : REFRESH_SEC);
  };
  /** Whether a transfer since the last read touched an insider (read once per transfer). */
  const touched = (coin: CoinState, e: Entry) => {
    if (e.dirty) return true;
    const flows = coin.flows, at = e.lastFlow ? flows.lastIndexOf(e.lastFlow) : -1;
    for (let i = at + 1; i < flows.length; i++) { const f = flows[i]!; if (e.insiders.has(f.from) || e.insiders.has(f.to)) { e.dirty = true; break; } }
    e.lastFlow = flows.at(-1);
    return e.dirty;
  };

  /** Work out one coin's figure. Throws only when the RPC budget or provider failed (the caller keeps the last figure). */
  async function measure(coin: CoinState): Promise<{ reply: DumpReply; holdings: Holdings | null }> {
    try { return await measureNow(coin); } catch (error) {
      // A closed curve or a pool that will not quote has no venue to sell into; anything else is a miss to retry.
      if ((error as { code?: string }).code !== 'not_measured') throw error;
      const t = now();
      return { reply: { version: 1, coin: getAddress(coin.token), at: new Date(t * 1000).toISOString(), asOfBlock: edge.ctx().head, measured: false, reason: 'unknown_venue' }, holdings: null };
    }
  }
  async function measureNow(coin: CoinState): Promise<{ reply: DumpReply; holdings: Holdings | null }> {
    const t = now(), c = edge.ctx();
    const base = { version: 1 as const, coin: getAddress(coin.token), at: new Date(t * 1000).toISOString(), asOfBlock: c.head };
    const no = (reason: NotMeasured) => ({ reply: { ...base, measured: false as const, reason }, holdings: null });
    if (edge.chain.profile.key !== 'robinhood') return no('unknown_venue');
    if (!transferCoverage(coin, t).complete) return no('partial_history');
    const graduatedPool = !(coin.curve && !coin.graduated);
    let key = coin.key;
    if (graduatedPool) {
      let checked; try { checked = edge.assessment(coin.token); } catch { checked = undefined; }
      key ??= checked?.key ?? null;
      if (!key || key.currency0 !== zeroAddress) return no('unknown_venue');
    }
    const holdings = insiderHoldings(coin, options(coin));
    const amounts = [...GROUPS.map(g => holdings.groups[g].tokens), holdings.all.tokens], ethUsd = edge.hype.latest;
    let venue: Venue, sellFeePct: number | null, outcomes: (DumpOutcome | null)[];
    const a = addresses(), probe = edge.probes.get(coin.token.toLowerCase())?.poolReserve;
    if (!graduatedPool) {
      if (!rpc) return no('unavailable');
      const s = await readCurve(rpc, edge.chain.multicall3, { curve: coin.curve!.address, token: coin.token });
      venue = 'curve'; sellFeePct = Number(s.feeBps + s.snipeTaxBps + s.creatorTaxBps) / 100;
      outcomes = amounts.map(x => curveDump(s, x, ethUsd));
    } else if (coin.launchpad === 'pons' && a.ponsHook && key!.hooks.toLowerCase() === a.ponsHook.toLowerCase() && probe && fullRangeReserves(probe, coin.sqrtPriceX96)) {
      const pool = fullRangeReserves(probe, coin.sqrtPriceX96)!;
      venue = 'pool'; sellFeePct = PONS_HOOK_SELL_FEE * 100;
      outcomes = amounts.map(x => poolDump(pool, Number(x) / 1e18, PONS_HOOK_SELL_FEE, ethUsd));
    } else {
      if (!rpc) return no('unavailable');
      venue = 'quoter'; sellFeePct = null;
      outcomes = await quoterDump(rpc, edge.chain.multicall3, a.quoter, coin.manager, key!, amounts, quoterDelta(coin));
    }
    const figure = (id: GroupId | 'all', h: { wallets: number; tokens: bigint }, o: DumpOutcome | null): GroupFigure => ({
      id, wallets: h.wallets, tokens: h.tokens.toString(), sharePct: pct2(h.tokens, coin.supply),
      changePct: o?.changePct ?? null, usd100: o?.usd100 ?? null, ...(o?.drains ? { drains: true as const } : {}) });
    const groups = GROUPS.map((g, i) => figure(g, holdings.groups[g], outcomes[i] ?? null));
    return { reply: { ...base, measured: true, venue, groups, all: figure('all', holdings.all, outcomes[GROUPS.length] ?? null), sellFeePct, funding: !!funding }, holdings };
  }

  /** The coin's figure, worked out at most once at a time and kept in the cache. */
  const refresh = (coin: CoinState): Promise<DumpReply> => {
    const k = coin.token.toLowerCase(), running = jobs.get(k);
    if (running) return running;
    const state = stateOf(coin);
    const job = measure(coin).then(({ reply, holdings }) => {
      const prev = cache.get(k);
      const entry: Entry = { at: now(), state, reply, insiders: holdings?.insiders ?? prev?.insiders ?? new Set(), lastFlow: coin.flows.at(-1), dirty: false, base: prev?.base ?? null };
      if (reply.measured) entry.base = alertOn(coin, reply, entry.base);
      cache.delete(k); cache.set(k, entry);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return reply;
    }, () => {
      // The budget or the provider: the last figure stands, and the coin is tried again shortly.
      const prev = cache.get(k), t = now();
      const reply: DumpReply = prev?.reply ?? { version: 1, coin: getAddress(coin.token), at: new Date(t * 1000).toISOString(), asOfBlock: edge.ctx().head, measured: false, reason: 'unavailable' };
      cache.set(k, { at: t, state: '', insiders: new Set(), lastFlow: undefined, dirty: false, base: null, ...prev, reply, retryAt: t + EARLY_GAP_SEC * 2 });
      return reply;
    }).finally(() => jobs.delete(k));
    jobs.set(k, job);
    return job;
  };

  let running = false;
  /** One background pass: the due coins, wanted ones first, then by their last trade; RPC coins stop at the budget. */
  const tick = async () => {
    if (running) return 0;
    running = true;
    try {
      const t = now();
      if (t - loadedAt >= RELOAD_SEC) reload();
      for (const [k, at] of wanted) if (t - at > WANTED_SEC) wanted.delete(k);
      for (const k of cache.keys()) if (!edge.tracker.coins.has(k)) cache.delete(k);
      const todo = [...edge.tracker.coins.values()].filter(c => due(c, t));
      const rank = (c: CoinState) => wanted.has(c.token.toLowerCase()) || watchers.has(c.token.toLowerCase()) ? 1 : 0;
      todo.sort((a, b) => rank(b) - rank(a) || (b.trades.at(-1)?.ts ?? b.ts) - (a.trades.at(-1)?.ts ?? a.ts));
      let done = 0;
      for (const coin of todo.slice(0, PER_TICK)) { await refresh(coin); done++; }
      return done;
    } finally { running = false; }
  };

  // Alert recipients: accounts watching a coin, and accounts whose wallet holds it.
  const db = store?.db;
  let watchers = new Map<string, Set<string>>(), holders = new Map<string, string>(), loadedAt = -Infinity;
  const reload = () => {
    loadedAt = now();
    if (!db) return;
    try {
      const w = new Map<string, Set<string>>();
      for (const r of db.prepare(`SELECT account_id AS a, target AS t FROM watch WHERE kind = 'coin'`).all() as { a: string; t: string }[]) w.set(r.t.toLowerCase(), (w.get(r.t.toLowerCase()) ?? new Set()).add(r.a));
      const h = new Map<string, string>();
      for (const r of db.prepare('SELECT id AS a, wallet AS w FROM accounts').all() as { a: string; w: string }[]) if (r.w) h.set(r.w.toLowerCase(), r.a);
      watchers = w; holders = h;
    } catch { /* accounts are not set up on this edge: no one to alert */ }
  };
  const last = new Map<string, number>(), hourly = new Map<string, number[]>();
  const allow = (accountId: string, coin: string, t: number) => {
    const k = `${accountId}:${coin}`, prev = last.get(k);
    if (prev !== undefined && t - prev < ALERT.cooldownSec) return false;
    const times = (hourly.get(accountId) ?? []).filter(x => x > t - 3600);
    if (times.length >= ALERT.perHour) { hourly.set(accountId, times); return false; }
    times.push(t); hourly.set(accountId, times); last.set(k, t);
    if (last.size > 50_000) for (const [key, v] of last) if (v <= t - ALERT.cooldownSec) last.delete(key);
    return true;
  };
  /**
   * Alert when the all-insiders change crosses ALERT.crossPct or deepens by ALERT.risePts against `base`; returns the
   * new base (the figure alerted on, or the lower one seen since, so a slow climb still counts).
   */
  function alertOn(coin: CoinState, r: Extract<DumpReply, { measured: true }>, base: number | null): number | null {
    const drop = r.all.changePct === null ? null : -r.all.changePct;
    if (drop === null) return base;
    if (base === null) return drop;
    const crossed = base < ALERT.crossPct && drop >= ALERT.crossPct, rose = drop - base >= ALERT.risePts;
    if (!crossed && !rose) return Math.min(base, drop);
    deliver(coin, r, drop, base);
    return drop;
  }
  function deliver(coin: CoinState, r: Extract<DumpReply, { measured: true }>, drop: number, was: number): number {
    if (!ctx.alerts) return 0;
    const key = coin.token.toLowerCase(), to = new Map<string, 'watched' | 'bag'>();
    for (const a of watchers.get(key) ?? []) to.set(a, 'watched');
    if (holders.size) for (const [w, v] of balancesOf(coin, new Set(holders.keys()))) if (v > 0n && !to.has(holders.get(w)!)) to.set(holders.get(w)!, 'bag');
    if (!to.size) return 0;
    const symbol = toUntrusted(coin.symbol ?? '', UNTRUSTED_LIMITS.symbol), t = now(), name = symbol.text ? `$${symbol.text}` : 'a coin you follow';
    let sent = 0;
    for (const [accountId, reason] of to) {
      if (!allow(accountId, key, t)) continue;
      const { title, body } = alertText(name, drop, was, r.all.usd100, reason);
      const alert: Alert = { id: `dump_risk:${key}:${Math.floor(t)}`, ts: new Date(t * 1000).toISOString(), kind: 'dump_risk', level: drop >= 60 ? 'danger' : 'monitor',
        coin: getAddress(coin.token), ...(symbol.text ? { symbol } : {}), title, body, url: `/coin/${getAddress(coin.token)}`, read: false };
      ctx.alerts.post(accountId, alert);
      sent++;
    }
    return sent;
  }

  const perIp = limiter(RATE_PER_MIN, 60_000);
  app.get<{ Params: { address: string } }>('/v2/coins/:address/dump', async (req, reply) => {
    if (!perIp(req.ip)) return fail(reply, 429, 'rate_limited', 'Too many requests. Try again in a minute.');
    const { address } = req.params;
    if (!isAddress(address, { strict: false })) return fail(reply, 400, 'bad_request', 'Not an address.');
    const coin = edge.tracker.coin(address);
    if (!coin) return fail(reply, 404, 'not_found', `EKO follows ${edge.chain.profile.text.launches} from the last 24 hours on ${edge.chain.profile.name}; this coin is not one of them yet.`);
    const k = coin.token.toLowerCase(), t = now();
    wanted.set(k, t);
    const hit = cache.get(k);
    return hit && !due(coin, t) ? hit.reply : await refresh(coin);
  });

  // The Radar row's figure: what the cache holds now (never computed while the list is built).
  ctx.rows?.add('dump_test', (coin) => {
    const k = coin.token.toLowerCase(), e = cache.get(k);
    wanted.set(k, now());
    return e?.reply.measured && e.reply.all.changePct !== null && e.reply.all.usd100 !== null
      ? { changePct: e.reply.all.changePct, usd100: e.reply.all.usd100, sharePct: e.reply.all.sharePct } satisfies DumpSummary : undefined;
  });

  return { measure, refresh, tick, cache, reload, deliver, alertOn };
}

/** The alert's words: how far insiders could now drop the coin, as EKO estimates it, and why the account hears of it. */
export function alertText(name: string, drop: number, was: number, usd100: number | null, reason: 'watched' | 'bag'): { title: string; body: string } {
  const why = reason === 'watched' ? 'You watch this coin.' : 'Your wallet holds this coin.';
  const keep = usd100 === null ? '' : ` $100 held now would be worth about $${Math.round(usd100)} after.`;
  return { title: `Dump risk rose on ${name}: insiders now hold enough to drop it ${Math.round(drop)}%`,
    body: `EKO estimates the price would fall ${Math.round(drop)}% if the coin's insiders sold everything at once, up from ${Math.round(was)}%.${keep} ${why}` };
}

const feature: Feature = {
  register(ctx) {
    const { tick } = setup(ctx);
    const timer = setInterval(() => { void tick().catch(() => undefined); }, TICK_MS);
    timer.unref?.();
    ctx.app.addHook('onClose', async () => clearInterval(timer));
  },
};
export default feature;
