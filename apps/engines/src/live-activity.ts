import { performance } from 'node:perf_hooks';
import { binary, hex, type ChainDb } from '@eko/db';
import type { Address } from '@eko/shared';
import { ACTIVITY_LOOKBACK_BLOCKS, CLOCK_LOOKBACK_BLOCKS, activityEvent, activityRows, activitySums, blockIndex, checkpoints, clockGaps, coinRevision,
  fillClockGaps, partHash, resolveClock, revisionPart, type Activity, type ActivityBase, type ActivityRow, type BlockReader, type BlockTime,
  type CadenceStart, type Checkpoint, type ClockCache, type CoinRanges } from './activity.js';
import { RULES_VERSION } from '@eko/playbooks';
import { digest } from './card.js';
import type { HistoryPrune } from './history-prunes.js';
import { seconds } from './sources.js';

/** Live polls plan coins active in the last seven days; the hour covers the wall clock moving during a poll. */
const IDLE_SEC = 7 * 86400, IDLE_MARGIN_SEC = 3600;
/** Block times held in memory: eight days, so that a resumed plan of any coin active in the last seven finds its points. */
const CLOCK_SEC = 8 * 86400;
/** Coins per batched read. */
const CHUNK = 500;
/** The change log keeps a day of rows: engine_activity_feed lapses after a day without a live engine. */
const COLLECT_EVERY_MS = 10 * 60_000;

/** A coin's activity, as the live poll needs it to decide whether and from where to plan it. */
export interface LiveCoin {
  coin: Address; firstBlock: number; createdSec: number;
  /** Newest event time, or the launch time without events (seconds). */
  lastSec: number;
  /** Revision as engine_activity_state stores it: the digest of coinRevision, equal to a full-history read's. */
  revision: string;
  /** Progress base for the state written at this poll's `to`, or null when it is not known yet. */
  base: ActivityBase | null;
  /** First swap or transfer block above the retention watermark, for pruned coins (through `to`). */
  revived?: number;
}
export interface LiveActivityOptions { readBlock?: BlockReader; cache: ClockCache; concurrency: number; stopped: () => boolean }
/**
 * What one refresh read, for logs and tests. `cold`: the first refresh of a process (or after a failed or stopped one).
 * `windowRows`: activity rows above `after`. `rangeRows`: rows read per coin below the window. `summedCoins`: coins whose
 * base was recomputed in the database. `clockPoints`: block times read.
 */
export interface LiveActivityStats { cold: boolean; to: number; after: number; coins: number; windowRows: number; rangeRows: number; summedCoins: number; clockPoints: number; ms: number; sumMs?: number; clockMs?: number }
interface Stored { revision: string; through: number; base: ActivityBase | null; lastSec: number | null }
interface Known { coin: Address; firstBlock: number; supplyBlock: string | null; graduatedBlock: string | null; createdSec?: number; stored?: Stored; live?: LiveCoin }
const revisionOf = (supplyBlock: string | null, graduatedBlock: string | null, sum: bigint) => digest({ activity: coinRevision(supplyBlock, graduatedBlock, sum), rulesVersion: RULES_VERSION });
interface RowSum { sum: bigint; sec: number | null }

const event = (row: ActivityRow) => activityEvent(hex(row.coin) as Address, row);
const MASK = (1n << 128n) - 1n;
function addRow(target: RowSum, row: ActivityRow) {
  target.sum = (target.sum + partHash(revisionPart(row))) & MASK;
  const sec = seconds(row.ts); target.sec = target.sec == null ? sec : Math.max(target.sec, sec);
}
/** First index whose block number is above `block`, in a clock ordered by number. */
function above(clock: readonly BlockTime[], block: number) {
  let low = 0, high = clock.length;
  while (low < high) { const mid = (low + high) >>> 1; if (clock[mid].number <= block) low = mid + 1; else high = mid; }
  return low;
}
const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));
const decodeBase = (block: string | null, sum: string | null, sec: number | null): ActivityBase | null =>
  block == null || sum == null ? null : { baseBlock: Number(block), baseSum: BigInt(`0x${sum}`), baseSec: sec };
/** engine_activity_state's progress columns for a base. */
export const baseColumns = (base: ActivityBase | null) => base ? [base.baseBlock, base.baseSum.toString(16).padStart(32, '0'), base.baseSec] : [null, null, null];

/**
 * Rows of engine_activity_changes committed since this reader's previous read. Each read takes a transaction snapshot
 * before selecting; the next read returns the rows that snapshot could not see. Rows are never consumed, so several
 * readers do not take changes from each other. `commit` keeps the snapshot once the caller has applied the rows.
 */
class ChangeFeed {
  private snapshots = new Map<'coins' | 'clock', string>();
  constructor(private db: ChainDb) {}
  private async snapshot() { return (await this.db.sql.query<{ s: string }>('SELECT pg_current_snapshot()::text AS s')).rows[0].s; }
  private async read<T>(kind: 'coins' | 'clock', sql: (since: string) => string) {
    const snapshot = await this.snapshot(), prior = this.snapshots.get(kind);
    const rows = (await this.db.sql.query<T>(sql(prior === undefined ? 'true'
      : 'e.xid>=pg_snapshot_xmin($1::pg_snapshot) AND NOT pg_visible_in_snapshot(e.xid,$1::pg_snapshot)'), prior === undefined ? [] : [prior])).rows;
    return { rows, commit: () => { this.snapshots.set(kind, snapshot); } };
  }
  /** Changed coins: the lowest block with a changed row, and whether a pool or launch row changed. */
  coins() {
    return this.read<{ coin: Uint8Array; block: string | null; pools: boolean; tokens: boolean }>('coins', since => `SELECT c.coin,
        min(c.block) FILTER(WHERE e.source NOT IN ('pools','tokens'))::text AS block,bool_or(e.source='pools') AS pools,bool_or(e.source='tokens') AS tokens
      FROM engine_activity_changes e CROSS JOIN LATERAL unnest(e.coins,e.blocks) AS c(coin,block) WHERE e.source<>'engine_block_times' AND ${since} GROUP BY c.coin`);
  }
  /** Blocks whose stored time was written. */
  clock() {
    return this.read<{ block: string }>('clock', since => `SELECT DISTINCT b::text AS block FROM engine_activity_changes e CROSS JOIN LATERAL unnest(e.blocks) AS b
      WHERE e.source='engine_block_times' AND ${since}`);
  }
  /** Follow from now on without reading: the caller reads the current state in full. */
  async skip(kind: 'coins' | 'clock') { const snapshot = await this.snapshot(); return () => { this.snapshots.set(kind, snapshot); }; }
  reset() { this.snapshots.clear(); }
}

/**
 * Live activity for EngineWorker polls. A poll reads what changed since the previous poll instead of aggregating every
 * swap, transfer, liquidity and Pons event of every coin (production 2026-10-08: minutes per poll, then out of memory),
 * and plans exactly the checkpoints a full-history poll plans. Memory holds one small record per coin active in the
 * last seven days and eight days of block times; everything else read in a poll is bounded by the new activity.
 *
 * - Every poll re-reads every coin's rows above the previous poll minus ACTIVITY_LOOKBACK_BLOCKS (the indexer's reorg
 *   window). engine_activity_changes (migration 0189) reports every other write: rows written or rewritten at older
 *   blocks, pool and launch changes, and block times.
 * - A coin's revision sums its rows' shares (partHash); engine_activity_state keeps the sum and newest event time of
 *   its rows at or below `to - ACTIVITY_LOOKBACK_BLOCKS`, so the next poll adds only the rows above. A base the log
 *   invalidated, or one never written, is recomputed in the database for coins that changed; until a coin changes,
 *   its stored revision stands (it would be recomputed to the same value).
 * - Plans resume after the coin's newest checkpoint that does not depend on the past (CadenceStart): its newest block at
 *   or below the previous plan with non-swap activity and a stored time. A coin with none (a new coin, or swaps only)
 *   is planned from its launch.
 * - A new process follows the persisted watermark (engine_activity_feed) and takes the coins active in the last seven
 *   days from engine_activity_state. Without a live log (first start, or a day without a live engine) it fills every
 *   missing block time once, as coinActivity does on every call, and takes recent coins from the activity tables by
 *   time.
 *
 * Block times are assumed not to decrease with height (as outcomes.ts and refreshClock do); a transfer row is assumed to
 * be timestamped no more than ten minutes before the newest stored block at or below the window unless the log names its
 * coin.
 */
export class LiveActivity {
  private known = new Map<Address, Known>();
  /** Block times from `clockFrom` through the previous `to`, ordered by number. */
  private clock: BlockTime[] = [];
  private clockFrom = 0;
  /** `to` of the previous completed refresh; undefined until one completes. */
  private covered: number | undefined;
  /** Coins whose base a block time written by another process may have changed: recomputed by the next refresh. */
  private pending = new Set<Address>();
  /** Rows above `after` read by the current refresh, by coin, for plans. */
  private window = new Map<Address, ActivityRow[]>();
  private after = -1;
  private trusted = false;
  private feed: ChangeFeed;
  private collectedAt = 0;
  stats: LiveActivityStats | undefined;
  constructor(readonly db: ChainDb) { this.feed = new ChangeFeed(db); }

  /**
   * Bring every coin that a live poll could plan up to `to`: launched coins active within seven days (and an hour) of
   * `now`, or changed now, in launch order, with the block clock through `to` (from eight days before `now`). Returns
   * undefined when stopped; a stopped or failed refresh leaves the next one cold.
   */
  async refresh(to: number, now: number, prunes: ReadonlyMap<Address, HistoryPrune>, options: LiveActivityOptions) {
    try {
      const result = await this.update(to, now, prunes, options);
      if (!result) this.reset();
      return result;
    } catch (error) { this.reset(); throw error; }
  }
  private reset() { this.known.clear(); this.clock = []; this.covered = undefined; this.window.clear(); this.feed.reset(); }

  private async update(to: number, now: number, prunes: ReadonlyMap<Address, HistoryPrune>, o: LiveActivityOptions) {
    const started = performance.now(), cold = this.covered === undefined;
    let rangeRows = 0, summedCoins = 0;
    let previous: number;
    if (cold) {
      const feed = (await this.db.sql.query<{ block: string; live: boolean }>(`SELECT block::text,seen_at>now()-interval '1 day' AND complete AS live FROM engine_activity_feed`)).rows[0];
      // Without a feed, the previous engine's cursor marks what it had read.
      const cursor = feed ? Number(feed.block) : Number((await this.db.sql.query<{ block: string }>("SELECT block::text FROM engine_cursors WHERE stream='engines'")).rows[0]?.block ?? -1);
      // Follow the change log from here on, before reading anything it would report.
      this.trusted = !!feed?.live;
      await this.follow(cursor, this.trusted);
      previous = cursor;
      this.known.clear();
    } else previous = this.covered!;
    // Rows above `after` are read for every coin; below it, per coin.
    const after = previous < 0 ? to : Math.min(previous, to) - ACTIVITY_LOOKBACK_BLOCKS;
    this.after = after;
    const changes = await this.feed.coins();
    const changed = new Map(changes.rows.map(row => [hex(row.coin) as Address, row]));
    const filled = new Set<number>(), fill = async (gaps: number[]) => {
      if (!await fillClockGaps(this.db, gaps, o.readBlock, o.cache, o.concurrency, o.stopped)) return false;
      for (const block of gaps) filled.add(block);
      return true;
    };
    // Missing block times above the window; everywhere when nothing reported older writes since the previous process.
    // Times filled below the window can turn launch, pool and Pons rows of any coin into activity.
    const missing = await clockGaps(this.db, to, this.trusted ? { after } : undefined);
    if (!await fill(missing)) return;
    for (const coin of await this.coinsAt(missing.filter(block => block <= after))) this.pending.add(coin);

    // Rows above the window, for every coin.
    const since = this.timeAtOrBelow(after) ?? (after >= to ? undefined : (await this.db.sql.query<{ ts: Date }>('SELECT ts FROM engine_block_times WHERE number<=$1 ORDER BY number DESC LIMIT 1', [after])).rows
      .map(row => seconds(row.ts))[0]);
    this.window.clear();
    for (const row of after >= to ? [] : await activityRows(this.db, to, { after, since: since === undefined ? null : new Date((since - 600) * 1000),
      transfers: [...changed].filter(([, change]) => change.block != null && Number(change.block) > after).map(([coin]) => coin) })) {
      const coin = hex(row.coin) as Address, list = this.window.get(coin) ?? []; list.push(row); this.window.set(coin, list);
    }
    let windowRows = 0;for (const rows of this.window.values()) windowRows += rows.length;

    // Coins a poll may plan.
    const candidates = new Set<Address>(this.known.keys());
    if (cold) for (const coin of await (this.trusted ? this.active(now - IDLE_SEC - IDLE_MARGIN_SEC, to) : this.recent(now - IDLE_SEC - IDLE_MARGIN_SEC, to))) candidates.add(coin);
    for (const coin of [...changed.keys(), ...this.window.keys(), ...this.pending]) candidates.add(coin);
    for (const row of (await this.db.sql.query<{ address: Uint8Array }>('SELECT address FROM tokens WHERE first_block>$1 AND first_block<=$2', [after, to])).rows) candidates.add(hex(row.address) as Address);
    // Launch rows and stored progress for coins not held, or whose launch row changed.
    const unread = [...candidates].filter(coin => !this.known.has(coin) || changed.get(coin)?.tokens);
    for (const chunk of chunks(unread)) {
      const params = [chunk.map(binary), to];
      // A token without a launch wallet (WETH, USDG, a coin not onboarded yet) never gets a card, so it is not held: WETH and
      // USDG are in most new pools, which invalidated their progress on every poll and re-summed their whole history
      // (2026-10-13: 57 of a poll's 60 seconds). It is read again on each poll it moves in, and held once it has one.
      const tokens = (await this.db.sql.query<{ address: Uint8Array; first_block: string; supply_block: string | null; graduated_block: string | null }>(
        'SELECT address,first_block,supply_block,graduated_block FROM tokens WHERE address=ANY($1) AND first_block<=$2 AND deployer IS NOT NULL', params)).rows;
      const states = new Map((await this.db.sql.query<{ coin: Uint8Array; revision: string; through_block: string; base_block: string | null; base_sum: string | null; base_sec: number | null; last_sec: number | null }>(
        'SELECT coin,revision,through_block::text,base_block::text,base_sum,base_sec,last_sec FROM engine_activity_state WHERE coin=ANY($1)', [chunk.map(binary)])).rows
        .map(row => [hex(row.coin) as Address, { revision: row.revision, through: Number(row.through_block), base: decodeBase(row.base_block, row.base_sum, row.base_sec), lastSec: row.last_sec } satisfies Stored]));
      const held = new Map(chunk.map(coin => [coin, this.known.get(coin)]));
      for (const coin of chunk) this.known.delete(coin);
      for (const token of tokens) {
        // A held coin whose launch row changed keeps its progress from the previous refresh.
        const coin = hex(token.address) as Address;
        this.known.set(coin, { coin, firstBlock: Number(token.first_block), supplyBlock: token.supply_block, graduatedBlock: token.graduated_block, stored: states.get(coin), live: held.get(coin)?.live });
      }
    }
    // Launch times: missing ones in one read, then resolveClock (as coinActivity resolves them).
    const firsts = [...new Set([...this.known.values()].map(entry => entry.firstBlock).filter(block => !o.cache.has(block)))];
    if (firsts.length) for (const row of (await this.db.sql.query<{ number: string; ts: Date; hash: Uint8Array | null }>(
      'SELECT number,ts,hash FROM engine_block_times WHERE number=ANY($1)', [firsts])).rows) o.cache.set(Number(row.number), { ts: row.ts, hash: row.hash });
    for (const entry of this.known.values()) {
      const time = await resolveClock(this.db, entry.firstBlock, o.readBlock, o.cache);
      if (!time) throw new Error(`Missing launch timestamp at block ${entry.firstBlock}; provide RPC_HTTP_URL for archive headers`);
      entry.createdSec = seconds(time.ts);
    }

    // Revisions. A coin's rows above its base come from the window and, below the window, from its own range.
    const nextBase = to - ACTIVITY_LOOKBACK_BLOCKS;
    // The base of the previous refresh (held coins), else the stored one; the log and foreign block times invalidate it.
    const baseOf = (entry: Known) => entry.live ? entry.live.base : entry.stored?.base ?? null;
    const invalid = (entry: Known) => {
      const change = changed.get(entry.coin), base = baseOf(entry);
      return !this.trusted || !base || this.pending.has(entry.coin) || !!change?.pools || (change?.block != null && Number(change.block) <= base.baseBlock);
    };
    const moved = (entry: Known) => !!changed.get(entry.coin) || this.pending.has(entry.coin)
      || (this.window.get(entry.coin) ?? []).some(row => Number(row.block) > (entry.stored?.through ?? -1));
    const resum: Known[] = [], reuse: Known[] = [], extend: Known[] = [];
    for (const entry of this.known.values()) {
      if (!invalid(entry)) extend.push(entry);
      else if (entry.stored && !moved(entry)) reuse.push(entry);
      else resum.push(entry);
    }
    // Bases recomputed in the database (whole history, one sum per coin); missing times of those rows are filled first.
    const bases = new Map<Address, ActivityBase>();
    const sumStarted = performance.now();
    for (const chunk of chunks(resum)) {
      const coins = chunk.map(entry => entry.coin);
      if (!await fill(await clockGaps(this.db, to, { coins }))) return;
      const sums = await activitySums(this.db, { coins, from: coins.map(() => -1), to: coins.map(() => nextBase) });
      for (const coin of coins) { const sum = sums.get(coin)!; bases.set(coin, { baseBlock: nextBase, baseSum: sum.sum, baseSec: sum.sec }); }
      summedCoins += coins.length;
    }
    const sumMs = performance.now() - sumStarted;
    for (const entry of extend) bases.set(entry.coin, baseOf(entry)!);
    // Rows between a base and the window.
    const gaps = [...bases].filter(([, base]) => base.baseBlock < after);
    const ranged = new Map<Address, ActivityRow[]>();
    for (const chunk of chunks(gaps)) {
      for (const row of await activityRows(this.db, to, { ranges: { coins: chunk.map(([coin]) => coin), from: chunk.map(([, base]) => base.baseBlock), to: chunk.map(() => after) } })) {
        const coin = hex(row.coin) as Address, list = ranged.get(coin) ?? []; list.push(row); ranged.set(coin, list); rangeRows++;
      }
    }
    const lastTimes = await this.lastTimes(reuse.filter(entry => entry.stored!.lastSec == null), to);
    const result: LiveCoin[] = [];
    for (const entry of this.known.values()) {
      let live: LiveCoin;
      const base = bases.get(entry.coin);
      if (base) {
        const rows = [...ranged.get(entry.coin) ?? [], ...(this.window.get(entry.coin) ?? []).filter(row => Number(row.block) > base.baseBlock)];
        const total: RowSum = { sum: base.baseSum, sec: base.baseSec }, kept: RowSum = { sum: base.baseSum, sec: base.baseSec };
        for (const row of rows) { addRow(total, row); if (Number(row.block) <= nextBase) addRow(kept, row); }
        live = { coin: entry.coin, firstBlock: entry.firstBlock, createdSec: entry.createdSec!, lastSec: Math.max(entry.createdSec!, total.sec ?? -Infinity),
          revision: revisionOf(entry.supplyBlock, entry.graduatedBlock, total.sum), base: { baseBlock: nextBase, baseSum: kept.sum, baseSec: kept.sec } };
      } else {
        // Unchanged since its state was written without a base: the stored revision stands until the coin changes.
        const stored = entry.stored!;
        live = { coin: entry.coin, firstBlock: entry.firstBlock, createdSec: entry.createdSec!, lastSec: stored.lastSec ?? lastTimes.get(entry.coin)!,
          revision: stored.revision, base: null };
      }
      entry.live = live;
      result.push(live);
    }
    // Preserved coins revive on any new indexed evidence, legacy gaps still require a swap or transfer.
    const pruned = result.filter(coin => prunes.has(coin.coin)), byCoin = new Map(result.map(coin => [coin.coin, coin]));
    for (const chunk of chunks(pruned)) for (const row of (await this.db.sql.query<{ coin: Uint8Array; block: string | null }>(`SELECT r.c AS coin,least(
        (SELECT min(block) FROM swaps WHERE coin=r.c AND block>r.w AND block<=$3),(SELECT min(block) FROM token_transfers WHERE token=r.c AND block>r.w AND block<=$3),
        CASE WHEN r.preserved THEN (SELECT min(e.block) FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE (p.currency0=r.c OR p.currency1=r.c) AND e.block>r.w AND e.block<=$3) END,
        CASE WHEN r.preserved THEN (SELECT min(block) FROM pons_events WHERE token=r.c AND block>r.w AND block<=$3) END,
        CASE WHEN r.preserved THEN (SELECT min(block) FROM pons_exemptions WHERE token=r.c AND block>r.w AND block<=$3) END,
        CASE WHEN r.preserved THEN (SELECT min(created_block) FROM pools WHERE (currency0=r.c OR currency1=r.c) AND created_block>r.w AND created_block<=$3) END)::text AS block
      FROM unnest($1::bytea[],$2::bigint[],$4::boolean[]) AS r(c,w,preserved)`, [chunk.map(coin => binary(coin.coin)), chunk.map(coin => prunes.get(coin.coin)!.watermark), to,chunk.map(coin=>prunes.get(coin.coin)!.preserved ?? false)])).rows) {
      const coin = byCoin.get(hex(row.coin) as Address);
      if (coin && row.block != null) coin.revived = Number(row.block);
    }
    this.pending.clear();
    const clockStarted = performance.now();
    const clockPoints = await this.updateClock(to, now, cold, filled);
    const clockMs = performance.now() - clockStarted;
    // Coins idle past the planning horizon are dropped; new rows bring them back.
    const held = result.filter(coin => {
      if (now - coin.lastSec < IDLE_SEC + IDLE_MARGIN_SEC) return true;
      this.known.delete(coin.coin); return false;
    }).sort((a, b) => a.firstBlock - b.firstBlock || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));
    changes.commit();
    this.covered = to;
    // What the log missed before this process followed it is made up for: later refreshes trust it.
    this.trusted = true;
    await this.follow(to, true);
    await this.collect();
    this.stats = { cold, to, after, coins: held.length, windowRows, rangeRows, summedCoins, clockPoints, ms: performance.now() - started, sumMs: Math.round(sumMs), clockMs: Math.round(clockMs) };
    return { coins: held, clock: this.clock };
  }

  /** Record a state write (EngineWorker), as the next cold refresh would read it. */
  written(coin: Address, revision: string, through: number) {
    const entry = this.known.get(coin);
    if (entry?.live) entry.stored = { revision, through, base: entry.live.base, lastSec: entry.live.lastSec };
  }

  /**
   * Checkpoints of each coin from its `from` block through `to`, as checkpoints() plans them over the coin's whole
   * history: resumed after the coin's newest independent checkpoint at or below `from - 1` (CadenceStart), or from its
   * launch. Call after refresh, with the same `to`.
   */
  async plans(requests: { coin: Address; from: number }[], to: number) {
    const plans = new Map<Address, Checkpoint[]>();
    if (!requests.length) return plans;
    const fromOf = new Map(requests.map(request => [request.coin, request.from]));
    const starts = new Map<Address, { after: number; state: CadenceStart['state']; ranged: boolean } | null>();
    const resumable = requests.filter(request => request.from > 0);
    // The newest liquidity event is read per pool of the coin: joined the other way, the planner walked the whole
    // liquidity_events block index for each coin without one (about 0.8 s per coin, most of a 35-minute cold start, 2026-10-11).
    for (const chunk of chunks(resumable)) for (const row of (await this.db.sql.query<{ coin: Uint8Array; forced: string | null; forced_ts: Date | null; swap_ts: Date | null; price: number | null; newest_swap: string | null }>(`
      SELECT r.c AS coin,l.block::text AS forced,k.ts AS forced_ts,s.ts AS swap_ts,s.price,n.block::text AS newest_swap
      FROM unnest($1::bytea[],$2::bigint[]) AS r(c,p)
      CROSS JOIN LATERAL (SELECT max(b) AS block FROM (
        (SELECT t.block AS b FROM token_transfers t WHERE t.token=r.c AND t.block<=r.p AND EXISTS(SELECT 1 FROM engine_block_times k WHERE k.number=t.block) ORDER BY t.block DESC LIMIT 1)
        UNION ALL (SELECT e.block FROM (SELECT q.id FROM pools q WHERE q.currency0=r.c UNION ALL SELECT q.id FROM pools q WHERE q.currency1=r.c) q
          CROSS JOIN LATERAL (SELECT e.block FROM liquidity_events e WHERE e.pool_id=q.id AND e.block<=r.p
            AND EXISTS(SELECT 1 FROM engine_block_times k WHERE k.number=e.block) ORDER BY e.block DESC LIMIT 1) e ORDER BY e.block DESC LIMIT 1)
        UNION ALL (SELECT e.block FROM pons_events e WHERE e.token=r.c AND e.block<=r.p AND EXISTS(SELECT 1 FROM engine_block_times k WHERE k.number=e.block) ORDER BY e.block DESC LIMIT 1)
        UNION ALL (SELECT e.block FROM pons_exemptions e WHERE e.token=r.c AND e.block<=r.p AND EXISTS(SELECT 1 FROM engine_block_times k WHERE k.number=e.block) ORDER BY e.block DESC LIMIT 1)
        UNION ALL (SELECT q.created_block FROM pools q WHERE (q.currency0=r.c OR q.currency1=r.c) AND q.created_block<=r.p
          AND EXISTS(SELECT 1 FROM engine_block_times k WHERE k.number=q.created_block) ORDER BY q.created_block DESC LIMIT 1)) x) l
      LEFT JOIN engine_block_times k ON k.number=l.block
      LEFT JOIN LATERAL (SELECT b.ts,s.price_quote AS price FROM swaps s JOIN engine_block_times b ON b.number=s.block WHERE s.coin=r.c AND s.block<=l.block
        ORDER BY s.block DESC,s.log_index DESC,s.tx_hash DESC LIMIT 1) s ON true
      LEFT JOIN LATERAL (SELECT s.block FROM swaps s WHERE s.coin=r.c AND s.block<=r.p AND EXISTS(SELECT 1 FROM engine_block_times b WHERE b.number=s.block)
        ORDER BY s.block DESC LIMIT 1) n ON true`, [chunk.map(request => binary(request.coin)), chunk.map(request => request.from - 1)])).rows) {
      const coin = hex(row.coin) as Address, entry = this.known.get(coin), previous = fromOf.get(coin)! - 1;
      if (!entry || row.forced == null || !row.forced_ts) { starts.set(coin, null); continue; }
      const sec = seconds(row.forced_ts), price = row.swap_ts ? row.price : null;
      // Below the window only swaps after the resume block can matter (its non-swap rows with times are the newest up to
      // the previous plan), and rows between the previous plan and the window.
      const ranged = (row.newest_swap != null && Number(row.newest_swap) > Number(row.forced)) || previous < this.after;
      starts.set(coin, { after: Number(row.forced), ranged, state: { lastRun: sec, lastActivity: sec, lastTrade: row.swap_ts ? seconds(row.swap_ts) : -Infinity, lastPrice: price, lastObservedPrice: price } });
    }
    // Events after each plan's start: the window's rows and, below the window, the coin's own range.
    const lows = new Map(requests.map(request => [request.coin, starts.get(request.coin)?.after ?? -1]));
    const below = requests.filter(request => { const start = starts.get(request.coin); return lows.get(request.coin)! < this.after && (!start || start.ranged); });
    const rows = new Map<Address, Activity[]>();
    for (const chunk of chunks(below)) for (const row of await activityRows(this.db, to, { ranges: { coins: chunk.map(request => request.coin),
      from: chunk.map(request => lows.get(request.coin)!), to: chunk.map(() => this.after) } })) {
      const coin = hex(row.coin) as Address, list = rows.get(coin) ?? []; list.push(event(row)); rows.set(coin, list);
    }
    const eventsOf = (coin: Address) => [...(rows.get(coin) ?? []), ...(this.window.get(coin) ?? []).filter(row => Number(row.block) > lows.get(coin)!).map(event)];
    // Block times a plan needs before the held ones: those after a resume block or, for a plan from the launch, those from
    // the earliest of the launch time and the coin's events on (block times do not decrease with height).
    let earliest = Infinity;
    for (const request of requests) {
      const start = starts.get(request.coin);
      if (start) { earliest = Math.min(earliest, start.after + 1); continue; }
      const entry = this.known.get(request.coin)!, events = eventsOf(request.coin);
      const time = events.reduce((least, item) => Math.min(least, item.sec), entry.createdSec!);
      if (this.clock.length && time > this.clock[0].sec) continue;
      const row = (await this.db.sql.query<{ number: string }>('SELECT number::text FROM engine_block_times WHERE ts>=to_timestamp($1) ORDER BY ts,number LIMIT 1', [time])).rows[0];
      earliest = events.reduce((least, item) => Math.min(least, item.block), Math.min(earliest, row ? Number(row.number) : Infinity));
    }
    let clock = this.clock;
    if (earliest < this.clockFrom) clock = [...(await this.db.sql.query<{ number: string; ts: Date }>('SELECT number,ts FROM engine_block_times WHERE number>=$1 AND number<$2 ORDER BY number',
      [earliest, this.clockFrom])).rows.map(row => ({ number: Number(row.number), sec: seconds(row.ts) })), ...clock];
    const index = blockIndex(clock);
    for (const request of requests) {
      const entry = this.known.get(request.coin)!, start = starts.get(request.coin);
      const coin = { coin: request.coin, firstBlock: entry.firstBlock, createdSec: entry.createdSec!, events: eventsOf(request.coin), revision: '' };
      plans.set(request.coin, checkpoints(coin, clock, request.from, to, index, start ? { after: start.after, index: above(clock, start.after), state: start.state } : undefined));
    }
    return plans;
  }

  /**
   * Coins whose stored state was active at or after `cutoff` (seconds), and coins launched since then that have no stored
   * state: a process that stopped before their first state write (a yielded poll, a restart, a crash) left them behind,
   * and nothing else names them once the watermark passed their launch. Tokens without a deployer never get a card.
   */
  private async active(cutoff: number, to: number) {
    return (await this.db.sql.query<{ coin: Uint8Array }>(`SELECT coin FROM engine_activity_state WHERE last_sec>=$1
      UNION SELECT t.address FROM tokens t WHERE t.deployer IS NOT NULL AND t.first_block<=$2 AND t.first_block>coalesce((SELECT number FROM engine_block_times
          WHERE ts<to_timestamp($1) ORDER BY ts DESC,number DESC LIMIT 1),-1)
        AND NOT EXISTS (SELECT 1 FROM engine_activity_state s WHERE s.coin=t.address)`, [cutoff, to])).rows.map(row => hex(row.coin) as Address);
  }
  /** Launched coins with any activity at or after `cutoff` (seconds), or launched then: the first start's candidates. */
  private async recent(cutoff: number, to: number) {
    // Rows without a time column are bounded by block: the newest stored block time before the cutoff.
    return (await this.db.sql.query<{ address: Uint8Array }>(`WITH bound AS (SELECT coalesce((SELECT number FROM engine_block_times
        WHERE ts<to_timestamp($1) ORDER BY ts DESC,number DESC LIMIT 1),-1) AS b)
      SELECT address FROM tokens WHERE first_block<=$2 AND address IN (
        SELECT coin FROM swaps WHERE ts>=to_timestamp($1) AND block<=$2
        UNION SELECT token FROM token_transfers WHERE ts>=to_timestamp($1) AND block<=$2
        UNION SELECT c FROM liquidity_events e JOIN pools p ON p.id=e.pool_id CROSS JOIN LATERAL (VALUES (p.currency0),(p.currency1)) v(c)
          WHERE e.block>(SELECT b FROM bound) AND e.block<=$2
        UNION SELECT token FROM pons_events WHERE block>(SELECT b FROM bound) AND block<=$2
        UNION SELECT token FROM pons_exemptions WHERE block>(SELECT b FROM bound) AND block<=$2
        UNION SELECT c FROM pools p CROSS JOIN LATERAL (VALUES (p.currency0),(p.currency1)) v(c) WHERE p.created_block>(SELECT b FROM bound) AND p.created_block<=$2
        UNION SELECT address FROM tokens WHERE first_block>(SELECT b FROM bound) AND first_block<=$2)`, [cutoff, to])).rows.map(row => hex(row.address) as Address);
  }
  /**
   * Newest event time of coins written before progress bases existed: the earliest row of the newest block of each
   * kind (block times do not decrease with height), or the launch time.
   */
  private async lastTimes(entries: Known[], to: number) {
    const times = new Map<Address, number>();
    for (const chunk of chunks(entries)) for (const row of (await this.db.sql.query<{ coin: Uint8Array; last: Date | null }>(`SELECT r.c AS coin,greatest(
      (SELECT min(ts) FROM swaps WHERE coin=r.c AND block=(SELECT max(block) FROM swaps WHERE coin=r.c AND block<=$2)),
      (SELECT min(ts) FROM token_transfers WHERE token=r.c AND block=(SELECT max(block) FROM token_transfers WHERE token=r.c AND block<=$2)),
      (SELECT min(e.ts) FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE (p.currency0=r.c OR p.currency1=r.c) AND e.block=(SELECT max(e2.block)
        FROM liquidity_events e2 JOIN pools p2 ON p2.id=e2.pool_id WHERE (p2.currency0=r.c OR p2.currency1=r.c) AND e2.block<=$2)),
      (SELECT b.ts FROM pons_events e JOIN engine_block_times b ON b.number=e.block WHERE e.token=r.c AND e.block<=$2 ORDER BY e.block DESC LIMIT 1),
      (SELECT b.ts FROM pons_exemptions e JOIN engine_block_times b ON b.number=e.block WHERE e.token=r.c AND e.block<=$2 ORDER BY e.block DESC LIMIT 1),
      (SELECT b.ts FROM pools p JOIN engine_block_times b ON b.number=p.created_block WHERE (p.currency0=r.c OR p.currency1=r.c) AND p.created_block<=$2
        ORDER BY p.created_block DESC LIMIT 1)) AS last FROM unnest($1::bytea[]) AS r(c)`, [chunk.map(entry => binary(entry.coin)), to])).rows) {
      const entry = this.known.get(hex(row.coin) as Address)!;
      times.set(entry.coin, Math.max(entry.createdSec!, row.last ? seconds(row.last) : -Infinity));
    }
    return times;
  }

  /** Keep the held block times equal to the stored ones from eight days before `now` through `to`; returns how many were read. */
  private async updateClock(to: number, now: number, cold: boolean, filled: Set<number>) {
    const read = (sql: string, params: unknown[]) => this.db.sql.query<{ number: string; ts: Date }>(sql, params)
      .then(result => result.rows.map(row => ({ number: Number(row.number), sec: seconds(row.ts) })));
    // The held range starts at the earliest stored time at or after the cutoff (a block range, so lookups match the full clock).
    const startAt = Number((await this.db.sql.query<{ number: string | null }>('SELECT number::text FROM engine_block_times WHERE ts>=to_timestamp($1) ORDER BY ts,number LIMIT 1',
      [now - CLOCK_SEC])).rows[0]?.number ?? to + 1);
    if (cold) {
      const commit = await this.feed.skip('clock');
      this.clock = await read('SELECT number,ts FROM engine_block_times WHERE number>=$1 AND number<=$2 ORDER BY number', [startAt, to]);
      this.clockFrom = startAt;
      commit();
      return this.clock.length;
    }
    // A time stored later for a block below the held range moves its start down. Only that range is read: reloading
    // the whole eight-day clock on each such poll (about 610,000 points on 2026-10-11) took minutes of every poll.
    let prepended = 0;
    if (startAt < this.clockFrom) {
      const lower = await read('SELECT number,ts FROM engine_block_times WHERE number>=$1 AND number<$2 ORDER BY number', [startAt, this.clockFrom]);
      this.clock = [...lower, ...this.clock]; this.clockFrom = startAt; prepended = lower.length;
    }
    const written = await this.feed.clock(), floor = Math.min(this.covered!, to) - CLOCK_LOOKBACK_BLOCKS;
    const older = written.rows.map(row => Number(row.block)).filter(block => block <= floor);
    let count = 0;
    if (older.length) {
      for (const point of await read('SELECT number,ts FROM engine_block_times WHERE number=ANY($1) AND number>=$2', [older, this.clockFrom])) {
        const at = above(this.clock, point.number);
        if (at > 0 && this.clock[at - 1].number === point.number) this.clock[at - 1] = point; else this.clock.splice(at, 0, point);
        count++;
      }
      // Another process wrote these times: launch, pool and Pons rows at those blocks may only now be activity.
      for (const coin of await this.coinsAt(older.filter(block => !filled.has(block)))) this.pending.add(coin);
    }
    const tail = await read('SELECT number,ts FROM engine_block_times WHERE number>$1 AND number<=$2 ORDER BY number', [Math.max(floor, this.clockFrom - 1), to]);
    this.clock.length = above(this.clock, floor);
    for (const point of tail) this.clock.push(point);
    if (startAt > this.clockFrom) { this.clock = this.clock.slice(above(this.clock, startAt - 1)); this.clockFrom = startAt; }
    written.commit();
    return prepended + count + tail.length;
  }

  /** Coins with launch, pool or Pons rows at these blocks: their activity there depends on the blocks' stored times. */
  private async coinsAt(blocks: number[]) {
    if (!blocks.length) return [];
    return (await this.db.sql.query<{ coin: Uint8Array }>(`SELECT token AS coin FROM pons_events WHERE block=ANY($1)
      UNION SELECT token FROM pons_exemptions WHERE block=ANY($1) UNION SELECT currency0 FROM pools WHERE created_block=ANY($1)
      UNION SELECT currency1 FROM pools WHERE created_block=ANY($1) UNION SELECT address FROM tokens WHERE first_block=ANY($1)`, [blocks])).rows.map(row => hex(row.coin) as Address);
  }
  /** Time (seconds) of the newest held block time at or below `block`. */
  private timeAtOrBelow(block: number) {
    const at = above(this.clock, block);
    return at > 0 ? this.clock[at - 1].sec : undefined;
  }
  /**
   * Mark the change log as followed (its triggers write while this is under a day old) and record the newest block read.
   * A start without a live log marks it incomplete until its refresh has filled what the log missed.
   */
  private async follow(block: number, complete: boolean) {
    await this.db.sql.query(`INSERT INTO engine_activity_feed(id,block,seen_at,complete) VALUES(true,$1,now(),$2)
      ON CONFLICT(id) DO UPDATE SET block=excluded.block,seen_at=excluded.seen_at,complete=excluded.complete`, [block, complete]);
  }
  private async collect() {
    if (Date.now() - this.collectedAt < COLLECT_EVERY_MS) return;
    await this.db.sql.query(`DELETE FROM engine_activity_changes WHERE at<now()-interval '1 day'`);
    this.collectedAt = Date.now();
  }
}
/** Stop following the change log: a live engine reading full history (ENGINE_LIVE_ACTIVITY=full) does not use it. */
export async function leaveActivityFeed(db: ChainDb) {
  await db.sql.query('DELETE FROM engine_activity_feed');
  await db.sql.query('DELETE FROM engine_activity_changes');
}
