import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, type Address } from 'viem';
import type { HistoryView, PriorLaunch } from '@eko/playbooks';
import type { Level, PlaybookId, Verdict } from '@eko/shared';

type VerdictLevel = Verdict['level'];

/**
 * EKO's memory on Elysium: one SQLite file (Node's built-in driver, no server). It keeps what outlives the tracker's
 * 24-hour window and nothing heavier: one row per launch (deployer, pool, first and strongest verdict), outcomes at
 * 1 h and 24 h, a few measured features per launch (for calibration), and who funded each wallet we looked at.
 * Trades and transfers are never stored; a coin's history is re-read from the explorer when it is needed again.
 */
export type Horizon = '1h' | '24h';
export type Outcome = 'rugged' | 'honeypot' | 'dumped' | 'survived';
export interface LaunchRow {
  token: Address; launchpad: string; deployer: Address; poolId: string | null; createdBlock: number; createdTs: number;
  tx: string | null; name: string | null; symbol: string | null; supply: string | null;
}
export interface StoredLaunch extends LaunchRow {
  swaps: number | null; firstLevel: VerdictLevel | null; firstAt: number | null; level: VerdictLevel | null;
  matches: { id: PlaybookId; level: Level }[]; source: 'live' | 'replay' | null;
}
export interface FunderRow { wallet: Address; funder: Address | null; fundedTs: number | null; fundedBlock: number | null; tx: string | null }

const LEVEL_RANK: Record<string, number> = { clear: 0, pending: 0, info: 1, monitor: 2, danger: 3 };
/** A funder that paid this many of the wallets we traced is a hub (a bridge relayer, a market maker): it ties no one together. */
export const HUB_FUNDEES = 25;

const lc = (a: string) => a.toLowerCase();

export class HistoryStore {
  readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private hubCache = new Map<string, { hub: boolean; at: number }>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    this.migrate();
    const p = (sql: string) => this.db.prepare(sql);
    this.st = {
      launch: p(`INSERT INTO launches(token,launchpad,deployer,pool_id,created_block,created_ts,tx,name,symbol,supply) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(token) DO UPDATE SET name=coalesce(excluded.name,name), symbol=coalesce(excluded.symbol,symbol), pool_id=coalesce(pool_id,excluded.pool_id)`),
      get: p('SELECT * FROM launches WHERE token=?'),
      verdict: p('UPDATE launches SET first_level=coalesce(first_level,?), first_at=coalesce(first_at,?), level=?, matches=?, source=? WHERE token=?'),
      swaps: p('UPDATE launches SET swaps=max(coalesce(swaps,0),?) WHERE token=?'),
      outcome: p('INSERT INTO outcomes(token,horizon,outcome,at,detail) VALUES(?,?,?,?,?) ON CONFLICT(token,horizon) DO UPDATE SET outcome=excluded.outcome, at=excluded.at, detail=excluded.detail'),
      outcomesOf: p('SELECT horizon,outcome,detail FROM outcomes WHERE token=?'),
      feature: p('INSERT INTO features(token,at_sec,data) VALUES(?,?,?) ON CONFLICT(token,at_sec) DO UPDATE SET data=excluded.data'),
      funder: p('INSERT INTO funders(wallet,funder,funded_ts,funded_block,tx,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET funder=excluded.funder, funded_ts=excluded.funded_ts, funded_block=excluded.funded_block, tx=excluded.tx, checked_at=excluded.checked_at'),
      funderOf: p('SELECT * FROM funders WHERE wallet=?'),
      fundees: p('SELECT count(*) AS n FROM funders WHERE funder=?'),
      byDeployer: p(`SELECT * FROM launches WHERE deployer=? AND created_ts<? ORDER BY created_ts DESC LIMIT ?`),
      crewDeployers: p(`SELECT DISTINCT l.deployer AS d FROM funders f JOIN launches l ON l.deployer=f.wallet WHERE f.funder=? AND f.wallet<>? LIMIT 50`),
      getMeta: p('SELECT value FROM meta WHERE key=?'),
      setMeta: p('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    };
  }

  private migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS launches(
          token TEXT PRIMARY KEY, launchpad TEXT NOT NULL, deployer TEXT NOT NULL, pool_id TEXT, created_block INTEGER NOT NULL, created_ts INTEGER NOT NULL,
          tx TEXT, name TEXT, symbol TEXT, supply TEXT, swaps INTEGER,
          first_level TEXT, first_at INTEGER, level TEXT, matches TEXT, source TEXT);
        CREATE INDEX IF NOT EXISTS launches_deployer ON launches(deployer, created_ts);
        CREATE INDEX IF NOT EXISTS launches_ts ON launches(created_ts);
        CREATE INDEX IF NOT EXISTS launches_pool ON launches(pool_id);
        CREATE TABLE IF NOT EXISTS outcomes(token TEXT NOT NULL, horizon TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT, PRIMARY KEY(token, horizon));
        CREATE TABLE IF NOT EXISTS features(token TEXT NOT NULL, at_sec INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(token, at_sec));
        CREATE TABLE IF NOT EXISTS funders(wallet TEXT PRIMARY KEY, funder TEXT, funded_ts INTEGER, funded_block INTEGER, tx TEXT, checked_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS funders_funder ON funders(funder);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version=1;`);
    }
    if (version < 3) {
      // Outcomes from before insiders meant the deployer's own wallets, or before the price change from each feature
      // point was recorded: dropped so the historian and the live service measure them again.
      this.db.exec(`DELETE FROM outcomes WHERE detail NOT LIKE '%changeFrom300%'; PRAGMA user_version=3;`);
    }
    if (version < 4) {
      // Dumps now need at least 1% of supply sold: measured again.
      this.db.exec(`DELETE FROM outcomes WHERE detail NOT LIKE '%insidersSoldShare%'; PRAGMA user_version=4;`);
    }
  }

  close() { this.db.close(); }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  meta(key: string): string | null { return (this.st.getMeta!.get(key) as { value: string } | undefined)?.value ?? null; }
  setMeta(key: string, value: string | number) { this.st.setMeta!.run(key, String(value)); }

  recordLaunch(l: LaunchRow) {
    this.st.launch!.run(lc(l.token), l.launchpad, lc(l.deployer), l.poolId ? lc(l.poolId) : null, l.createdBlock, l.createdTs, l.tx, l.name, l.symbol, l.supply);
  }
  setSwaps(token: string, swaps: number) { this.st.swaps!.run(swaps, lc(token)); }

  /** A verdict for the coin: the first one is kept, the level is the latest, matches keep each check's strongest level. */
  recordVerdict(token: string, level: VerdictLevel, matches: { id: PlaybookId; level: Level }[], atSec: number, source: 'live' | 'replay') {
    const prior = this.launch(token);
    if (!prior) return;
    const strongest = new Map(prior.matches.map(m => [m.id, m.level]));
    for (const m of matches) if ((LEVEL_RANK[m.level] ?? 0) > (LEVEL_RANK[strongest.get(m.id) ?? 'clear'] ?? 0)) strongest.set(m.id, m.level);
    this.st.verdict!.run(level, atSec, level, JSON.stringify([...strongest].map(([id, l]) => ({ id, level: l }))), prior.source === 'live' ? 'live' : source, lc(token));
  }

  launch(token: string): StoredLaunch | null {
    const r = this.st.get!.get(lc(token)) as Record<string, unknown> | undefined;
    return r ? row(r) : null;
  }

  recordOutcome(token: string, horizon: Horizon, outcome: Outcome, atSec: number, detail: Record<string, unknown>) {
    this.st.outcome!.run(lc(token), horizon, outcome, atSec, JSON.stringify(detail));
  }
  outcomes(token: string): { horizon: Horizon; outcome: Outcome; detail: Record<string, unknown> }[] {
    return (this.st.outcomesOf!.all(lc(token)) as { horizon: Horizon; outcome: Outcome; detail: string }[]).map(r => ({ horizon: r.horizon, outcome: r.outcome, detail: JSON.parse(r.detail ?? '{}') }));
  }
  recordFeatures(token: string, atSec: number, data: Record<string, number | null>) { this.st.feature!.run(lc(token), atSec, JSON.stringify(data)); }

  recordFunder(f: FunderRow, checkedAt: number) {
    this.st.funder!.run(lc(f.wallet), f.funder ? lc(f.funder) : null, f.fundedTs, f.fundedBlock, f.tx, checkedAt);
    if (f.funder) this.hubCache.delete(lc(f.funder));
  }
  /** The wallet's traced funder: undefined when never traced, funder null when traced and none was found. */
  funder(wallet: string): FunderRow | undefined {
    const r = this.st.funderOf!.get(lc(wallet)) as { wallet: string; funder: string | null; funded_ts: number | null; funded_block: number | null; tx: string | null } | undefined;
    return r ? { wallet: getAddress(r.wallet), funder: r.funder ? getAddress(r.funder) : null, fundedTs: r.funded_ts, fundedBlock: r.funded_block, tx: r.tx } : undefined;
  }
  /** A funder that paid HUB_FUNDEES or more traced wallets (cached for ten minutes). */
  isHub(funder: string): boolean {
    const k = lc(funder), now = Date.now(), hit = this.hubCache.get(k);
    if (hit && now - hit.at < 600_000) return hit.hub;
    const hub = Number((this.st.fundees!.get(k) as { n: number }).n) >= HUB_FUNDEES;
    this.hubCache.set(k, { hub, at: now });
    return hub;
  }
  /** The wallet's attributable funder: none when untraced, unfunded, or funded by a hub. */
  attributedFunder(wallet: string): FunderRow | undefined {
    const f = this.funder(wallet);
    return f?.funder && !this.isHub(f.funder) ? f : undefined;
  }

  /**
   * The deployer's earlier launches (and, when its funder is known and not a hub, launches by other deployers that
   * funder paid: its crew), newest first, launched before `beforeSec`. Each carries its strongest checks and outcomes.
   */
  historyFor(deployer: string, beforeSec: number, limit = 300): HistoryView {
    const own = (this.st.byDeployer!.all(lc(deployer), beforeSec, limit) as Record<string, unknown>[]).map(row);
    const funder = this.attributedFunder(deployer)?.funder ?? null;
    const crew: StoredLaunch[] = [];
    if (funder) for (const r of this.st.crewDeployers!.all(lc(funder), lc(deployer)) as { d: string }[]) {
      crew.push(...(this.st.byDeployer!.all(r.d, beforeSec, 50) as Record<string, unknown>[]).map(row));
      if (crew.length >= limit) break;
    }
    const prior = (l: StoredLaunch, relation: PriorLaunch['relation']): PriorLaunch => ({
      coin: l.token, createdAtSec: l.createdTs, relation, matches: l.matches,
      outcomes: this.outcomes(l.token).map(o => ({ horizon: o.horizon, outcome: o.outcome, validFromBlock: l.createdBlock,
        evidence: [{ kind: 'address' as const, ref: l.token, block: l.createdBlock, label: `Prior launch ${o.horizon} outcome: ${o.outcome}` }] })),
      evidence: [{ kind: 'address', ref: l.token, block: l.createdBlock, label: relation === 'crew' ? 'Prior launch by a wallet with the same funder' : 'Prior launch by this deployer' }],
    });
    return { ...(funder ? { crewId: funder.toLowerCase() } : {}), launches: [...own.map(l => prior(l, 'deployer')), ...crew.slice(0, limit).map(l => prior(l, 'crew'))] };
  }

  /** Every launch by a deployer, newest first (for its history page). */
  launchesBy(deployer: string, limit = 200): StoredLaunch[] {
    return (this.st.byDeployer!.all(lc(deployer), Number.MAX_SAFE_INTEGER, limit) as Record<string, unknown>[]).map(row);
  }

  query<T>(sql: string, ...params: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
}

function row(r: Record<string, unknown>): StoredLaunch {
  return {
    token: getAddress(String(r.token)), launchpad: String(r.launchpad), deployer: getAddress(String(r.deployer)), poolId: (r.pool_id as string | null) ?? null,
    createdBlock: Number(r.created_block), createdTs: Number(r.created_ts), tx: (r.tx as string | null) ?? null, name: (r.name as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null, supply: (r.supply as string | null) ?? null, swaps: r.swaps == null ? null : Number(r.swaps),
    firstLevel: (r.first_level as VerdictLevel | null) ?? null, firstAt: r.first_at == null ? null : Number(r.first_at), level: (r.level as VerdictLevel | null) ?? null,
    matches: r.matches ? JSON.parse(String(r.matches)) : [], source: (r.source as 'live' | 'replay' | null) ?? null,
  };
}
