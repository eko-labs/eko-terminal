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
import { DumpSnapshot, dumpSnapshotPath, type SavedDump } from './snapshot.js';
import { curveDump, fullRangeReserves, GROUPS, insiderHoldings, poolDump, PONS_HOOK_SELL_FEE, quoterDelta, quoterDump, readCurve,
  type DumpOutcome, type GroupId, type Holdings } from './dump.js';

/**
 * Dump test (flag `dump_test`): for every coin EKO follows, what the price would do if the coin's insiders sold
 * everything they hold right now, per group (dump.ts) and all together, and what $100 bought now would then come back as.
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
 * One computation, two readers: the route and the Radar row read the same cache entry, and only while it is servable
 * (`servable`: worked out within SERVE_SEC, or for an unchanged coin within IDLE_SEC). The route works a figure out on
 * the spot only when none is servable; the row then shows that one. Nothing is worked out while the tracker is still
 * replaying its start-up hour (`caughtUp`): a coin restored from the coin snapshot has lost its transfers after the
 * replay's cursor until the replay reaches them, so a figure taken then counts insiders who have since sold.
 *
 * Restarts: the figures are saved beside the coin snapshot every SAVE_SEC and at shutdown (snapshot.ts) and put back at
 * start, so the lists show them during the replay; each is servable until RESTORED_SEC after it was worked out, and is
 * worked out again first once the tracker has caught up.
 *
 * Alerts: an account is alerted in-site, for the coins it watches and the coins its wallet holds, when the all-insiders
 * risk (`riskOf`: the price fall, or on a curve the insiders would drain, what a $100 buyer loses) crosses ALERT.crossPct
 * or rises by ALERT.risePts since the last alert-free reading; one per coin per ALERT.cooldownSec and at most
 * ALERT.perHour per account.
 */
export const REFRESH_SEC = 45, EARLY_GAP_SEC = 5, IDLE_SEC = 600, TICK_MS = 3000, PER_TICK = 60, CACHE_MAX = 3000, RATE_PER_MIN = 60;
/** How long a figure is served after it was worked out, by the route and the Radar row alike (the background pass
 *  refreshes a trading coin every REFRESH_SEC, so this is only reached when it falls behind). */
export const SERVE_SEC = 300;
/** How long a figure put back from the snapshot is served; it is worked out again first once the tracker has caught up. */
export const RESTORED_SEC = 900;
/** The tracker is caught up when its cursor is within this many blocks of the head (about a minute on Robinhood Chain). */
export const CAUGHT_UP_BLOCKS = 600;
/** How often the figures are saved (snapshot.ts). */
export const SAVE_SEC = 60;
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
  /** The price change if the group sold everything at once (percent, ≤ 0), and what $100 bought now would then come back as. */
  changePct: number | null; usd100: number | null;
  /** The venue would run out of ETH before the group sold it all. */
  drains?: true;
}
export type DumpReply = { version: 1; coin: Address; at: string; asOfBlock: number } & (
  | { measured: true; venue: Venue; groups: GroupFigure[]; all: GroupFigure; sellFeePct: number | null; funding: boolean }
  | { measured: false; reason: NotMeasured });
/** The Radar row's figure (RadarRow.extras.dump_test): the route's `all` for the same coin at the same time. */
export interface DumpSummary { changePct: number; usd100: number; sharePct: number; drains?: true }
/**
 * How bad one figure is, 0-100: the price fall, or on a curve the insiders would drain (whose price barely moves, as
 * most of its reserves are virtual) what a $100 buyer would lose. Alerts read it; the web sorts by the same.
 */
export const riskOf = (f: { changePct: number | null; usd100: number | null; drains?: true }): number | null =>
  f.drains ? (f.usd100 === null ? null : Math.max(0, 100 - f.usd100)) : f.changePct === null ? null : -f.changePct;

const fail = (reply: FastifyReply, status: number, error: string, message: string) => reply.code(status).send({ error, message });
const pct2 = (v: bigint, supply: bigint) => supply > 0n ? Number((v * 1_000_000n) / supply) / 10_000 : 0;

export interface DumpOptions {
  now?: () => number; trade?: RobinhoodTradeAddresses & { ponsHook?: Address };
  /** The figures' file (snapshot.ts); default from the environment (dumpSnapshotPath), null for none. */
  snapshotPath?: string | null;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface Entry {
  at: number; state: string; reply: DumpReply; insiders: Set<string>;
  /** The last transfer read for insiders, and whether one touched them since `at`. */
  lastFlow: CoinState['flows'][number] | undefined; dirty: boolean;
  /** The all-insiders change when last alerted on (or first seen), for the rise rule. */
  base: number | null;
  /** After a failed read (budget or provider): when to try again; the last figure stands meanwhile, while servable. */
  retryAt?: number;
  /** Put back from the snapshot: servable until RESTORED_SEC, and worked out again first. */
  restored?: true;
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
  /** Whether the tracker holds every transfer up to (about) the head: never during the start-up replay. */
  const caughtUp = () => { const { cursor, head } = edge.tracker; return cursor > 0n && head - cursor <= BigInt(CAUGHT_UP_BLOCKS); };
  /** Whether an entry may be shown, by the route and the Radar row alike. */
  const servable = (e: Entry | undefined, coin: CoinState, t: number): e is Entry => !!e && (e.restored ? t - e.at <= RESTORED_SEC
    : t - e.at <= SERVE_SEC || (e.state === stateOf(coin) && t - e.at <= IDLE_SEC));

  /** Whether the coin's figure should be worked out again now. */
  const due = (coin: CoinState, t: number) => {
    const e = cache.get(coin.token.toLowerCase());
    if (!e || e.restored) return true;
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
      // The budget or the provider: the last figure stands while servable (its time unchanged), and the coin is tried
      // again shortly. With none, nothing is kept: both readers show no figure.
      const prev = cache.get(k), t = now();
      if (prev) prev.retryAt = t + EARLY_GAP_SEC * 2;
      return servable(prev, coin, t) ? prev.reply : unavailable(coin, t);
    }).finally(() => jobs.delete(k));
    jobs.set(k, job);
    return job;
  };

  const unavailable = (coin: CoinState, t: number): DumpReply =>
    ({ version: 1, coin: getAddress(coin.token), at: new Date(t * 1000).toISOString(), asOfBlock: edge.ctx().head, measured: false, reason: 'unavailable' });

  // The figures across restarts (snapshot.ts): put back now, before the tracker restores its coins (the lists serve them
  // during the replay), saved every SAVE_SEC and at shutdown.
  const log = opts.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields })));
  const path = opts.snapshotPath === undefined ? dumpSnapshotPath(process.env, !!store) : opts.snapshotPath;
  const saved = (): SavedDump[] => {
    const t = now(), rows = [...cache].filter(([, e]) => !(e.reply.measured === false && e.reply.reason === 'unavailable') && (e.restored ? t - e.at <= RESTORED_SEC : t - e.at <= IDLE_SEC));
    // The coins on the Radar list (and those opened) first, then the most recent.
    rows.sort(([a, x], [b, y]) => Number(wanted.has(b)) - Number(wanted.has(a)) || y.at - x.at);
    return rows.map(([token, e]) => ({ token, at: e.at, reply: e.reply }));
  };
  const snapshot = path ? new DumpSnapshot(path, saved, log) : null;
  let savedAt = now();
  if (snapshot) {
    const back = snapshot.load(now(), RESTORED_SEC);
    for (const e of back) {
      const risk = e.reply.measured ? riskOf(e.reply.all) : null;
      cache.set(e.token, { at: e.at, state: '', reply: e.reply, insiders: new Set(), lastFlow: undefined, dirty: false, base: risk, restored: true });
    }
    log('dump_snapshot_restored', { figures: back.length });
  }

  let running = false;
  /**
   * One background pass, once the tracker has caught up: the due coins (figures put back from the snapshot first, then
   * the wanted ones: on the Radar list, opened or watched; then by their last trade). RPC coins stop at the budget.
   */
  const tick = async () => {
    if (running) return 0;
    running = true;
    try {
      const t = now();
      if (snapshot && t - savedAt >= SAVE_SEC) { savedAt = t; void snapshot.save(Math.floor(t)).catch(error => log('dump_snapshot_failed', { error: String((error as Error).message).slice(0, 160) })); }
      if (!caughtUp()) return 0;
      if (t - loadedAt >= RELOAD_SEC) reload();
      for (const [k, at] of wanted) if (t - at > WANTED_SEC) wanted.delete(k);
      for (const k of cache.keys()) if (!edge.tracker.coins.has(k)) cache.delete(k);
      const todo = [...edge.tracker.coins.values()].filter(c => due(c, t));
      const rank = (c: CoinState) => { const k = c.token.toLowerCase(); return (cache.get(k)?.restored ? 2 : 0) + (wanted.has(k) || watchers.has(k) ? 1 : 0); };
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
    const drop = riskOf(r.all);
    if (drop === null) return base;
    if (base === null) return drop;
    const crossed = base < ALERT.crossPct && drop >= ALERT.crossPct, rose = drop - base >= ALERT.risePts;
    if (!crossed && !rose) return Math.min(base, drop);
    // Agents watching EKO's public stream (MCP watch) hear of it too, whoever else is alerted.
    ctx.mcp?.event('dump_test', { kind: 'dump_risk', coin: coin.token, title: r.all.drains
      ? `Dump risk rose: insiders could now drain its curve ($100 bought now would come back as about $${Math.round(r.all.usd100 ?? 0)})`
      : `Dump risk rose: insiders could now drop it ${Math.round(drop)}%`,
      data: { dropPct: Math.round(drop), wasPct: Math.round(base), usd100: r.all.usd100 === null ? null : Math.round(r.all.usd100), sharePct: r.all.sharePct, ...(r.all.drains ? { drains: true } : {}) } });
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
      const { title, body } = alertText(name, drop, was, r.all.usd100, reason, !!r.all.drains);
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
    const k = coin.token.toLowerCase(), t = now(), hit = cache.get(k);
    wanted.set(k, t);
    // The servable entry is the answer, the same one the Radar row shows; with none, it is worked out now (never during
    // the start-up replay, when the coin's transfers are not all back).
    if (servable(hit, coin, t)) return hit.reply;
    return caughtUp() ? await refresh(coin) : unavailable(coin, t);
  });

  // The Radar row's figure: the servable entry's, exactly what the route answers (never computed while the list is built).
  ctx.rows?.add('dump_test', (coin) => {
    const k = coin.token.toLowerCase(), t = now(), e = cache.get(k);
    wanted.set(k, t);
    return servable(e, coin, t) && e.reply.measured && e.reply.all.changePct !== null && e.reply.all.usd100 !== null
      ? { changePct: e.reply.all.changePct, usd100: e.reply.all.usd100, sharePct: e.reply.all.sharePct, ...(e.reply.all.drains ? { drains: true as const } : {}) } satisfies DumpSummary : undefined;
  });

  // Agents (MCP, only while this flag is on): the same per-coin figure as GET /v2/coins/:address/dump, shared with it.
  ctx.mcp?.tool('dump_test', { name: 'dump_test',
    description: `EKO's dump test for a coin on ${edge.chain.profile.name}: what the price would do if its insiders (dev, dev-funded wallets, bundles, snipers, early buyers) sold everything they hold right now, per group and all together (changePct, at most 0), and what $100 bought now would come back as if you sold after them (usd100). drains: true means they could take nearly all the ETH in the curve; judge by usd100 then, not changePct. measured: false names why there is no figure (partial_history, unknown_venue, unavailable). An estimate, not a prediction. Read-only.`,
    inputSchema: { type: 'object', properties: { coin: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'Token address' } }, required: ['coin'], additionalProperties: false },
    run: async (args) => {
      if (typeof args.coin !== 'string' || !isAddress(args.coin, { strict: false }) || Object.keys(args).some(k => k !== 'coin')) throw new Error('coin (a token address) is the only argument.');
      const coin = edge.tracker.coin(args.coin);
      if (!coin) throw new Error(`EKO follows ${edge.chain.profile.text.launches} from the last 24 hours on ${edge.chain.profile.name}; this coin is not one of them yet.`);
      const k = coin.token.toLowerCase(), t = now(), hit = cache.get(k);
      wanted.set(k, t);
      // The same answer as the route and the Radar row: the servable entry, else worked out now (never mid-replay).
      if (servable(hit, coin, t)) return hit.reply;
      return caughtUp() ? await refresh(coin) : unavailable(coin, t);
    } });

  ctx.app.addHook('onClose', async () => {
    if (!snapshot) return;
    try { log('dump_snapshot_saved', { figures: snapshot.saveSync(Math.floor(now())) }); } catch (error) { log('dump_snapshot_failed', { error: String((error as Error).message).slice(0, 160) }); }
  });

  return { measure, refresh, tick, cache, reload, deliver, alertOn, caughtUp, snapshot };
}

/**
 * The alert's words: how far insiders could now drop the coin, as EKO estimates it, and why the account hears of it. On
 * a curve they would drain, `drop` is what a $100 buyer loses (riskOf), and the words say that instead of a price move.
 */
export function alertText(name: string, drop: number, was: number, usd100: number | null, reason: 'watched' | 'bag', drains = false): { title: string; body: string } {
  const why = reason === 'watched' ? 'You watch this coin.' : 'Your wallet holds this coin.';
  const keep = usd100 === null ? '' : ` $100 bought now would come back as about $${Math.round(usd100)} after.`;
  if (drains) return { title: `Dump risk rose on ${name}: insiders now hold enough to drain its curve`,
    body: `EKO estimates that if the coin's insiders sold everything at once they would take all the ETH in its curve, what new buyers pay in included: $100 bought now would come back as about $${Math.round(usd100 ?? 0)}. ${why}` };
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
