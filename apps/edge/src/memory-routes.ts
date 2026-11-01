import type { FastifyInstance } from 'fastify';
import { getAddress, isAddress, type Address } from 'viem';
import { toUntrusted, UNTRUSTED_LIMITS } from '@eko/untrusted';
import type { DeployerHistory, ScoreboardResponse, ScoreboardRow } from '@eko/shared';
import type { FunderTracer } from './funders.js';
import type { Historian } from './historian.js';
import type { HistoryStore, StoredLaunch } from './history.js';
import type { Edge } from './service.js';

const iso = (sec: number | null | undefined) => sec ? new Date(sec * 1000).toISOString() : null;
const RANK: Record<string, number> = { danger: 3, monitor: 2, info: 1, clear: 0 };
const BAD = new Set(['rugged', 'honeypot', 'dumped']);

/**
 * Routes over EKO's memory: a deployer's record (and its crew's), the public scoreboard, and the calibration table the
 * thresholds are refit from. All read-only.
 */
export function registerMemoryRoutes(app: FastifyInstance, edge: Edge, m: { store: HistoryStore; historian?: Historian; funders?: FunderTracer }) {
  const { store } = m;

  app.get('/v1/memory', async () => ({
    launches: store.query<{ n: number }>('SELECT count(*) AS n FROM launches')[0]!.n,
    traded: store.query<{ n: number }>('SELECT count(*) AS n FROM launches WHERE swaps >= 2')[0]!.n,
    outcomes: Object.fromEntries(store.query<{ horizon: string; outcome: string; n: number }>('SELECT horizon, outcome, count(*) AS n FROM outcomes GROUP BY 1, 2').map(r => [`${r.horizon}:${r.outcome}`, r.n])),
    funders: store.query<{ n: number }>('SELECT count(*) AS n FROM funders')[0]!.n,
    historian: m.historian?.status() ?? null, funderQueue: m.funders?.pending ?? null, funderCounters: m.funders?.counters ?? null,
  }));

  app.get<{ Params: { address: string } }>('/v1/deployers/:address', async (req, reply) => {
    if (!isAddress(req.params.address, { strict: false })) return reply.code(400).send({ error: 'bad_request', message: 'Not an address.' });
    const deployer = getAddress(req.params.address);
    const own = store.launchesBy(deployer, 200);
    const traced = store.funder(deployer), funder = traced?.funder ?? null, hub = funder ? store.isHub(funder) : false;
    const crewDeployers = funder && !hub ? store.query<{ d: string }>(`SELECT DISTINCT l.deployer AS d FROM funders f JOIN launches l ON l.deployer = f.wallet WHERE f.funder = ? AND f.wallet <> ? LIMIT 50`,
      funder.toLowerCase(), deployer.toLowerCase()).map(r => getAddress(r.d)) : [];
    const crew = crewDeployers.flatMap(d => store.launchesBy(d, 50)).sort((a, b) => b.createdTs - a.createdTs).slice(0, 200);
    const counts = store.query<{ n: number; traded: number; first: number | null; last: number | null }>(
      'SELECT count(*) AS n, sum(CASE WHEN swaps >= 2 THEN 1 ELSE 0 END) AS traded, min(created_ts) AS first, max(created_ts) AS last FROM launches WHERE deployer = ?', deployer.toLowerCase())[0]!;
    const outcomes = { rugged: 0, honeypot: 0, dumped: 0, survived: 0 };
    for (const r of store.query<{ outcome: keyof typeof outcomes; n: number }>(`SELECT o.outcome, count(*) AS n FROM outcomes o JOIN launches l ON l.token = o.token WHERE l.deployer = ? AND o.horizon = '24h' GROUP BY 1`, deployer.toLowerCase())) outcomes[r.outcome] = r.n;
    const flagged = store.query<{ n: number }>(`SELECT count(*) AS n FROM launches WHERE deployer = ? AND level = 'danger'`, deployer.toLowerCase())[0]!.n;
    const row = (l: StoredLaunch, relation: 'deployer' | 'crew') => {
      const o = store.outcomes(l.token);
      return { address: l.token, deployer: l.deployer, relation, name: toUntrusted(l.name ?? '', UNTRUSTED_LIMITS.name), symbol: toUntrusted(l.symbol ?? '', UNTRUSTED_LIMITS.symbol),
        createdAt: iso(l.createdTs)!, block: l.createdBlock, swaps: l.swaps, level: l.level, firstLevel: l.firstLevel,
        flags: l.matches.filter(x => x.level === 'monitor' || x.level === 'danger').sort((a, b) => RANK[b.level]! - RANK[a.level]!),
        outcome1h: o.find(x => x.horizon === '1h')?.outcome ?? null, outcome24h: o.find(x => x.horizon === '24h')?.outcome ?? null, source: l.source };
    };
    const since = store.query<{ t: number | null }>('SELECT min(created_ts) AS t FROM launches')[0]!.t;
    const body: DeployerHistory = {
      deployer, funder: funder ? { address: funder, fundedAt: iso(traced?.fundedTs), hub, tx: traced?.tx ?? null } : null,
      funderStatus: traced ? (funder ? 'traced' : 'none') : 'pending',
      crew: crewDeployers.length ? { id: funder!, deployers: crewDeployers } : null,
      summary: { launches: counts.n, traded: counts.traded ?? 0, flagged, outcomes, firstLaunchAt: iso(counts.first), lastLaunchAt: iso(counts.last) },
      launches: [...own.map(l => row(l, 'deployer')), ...crew.map(l => row(l, 'crew'))],
      coverage: { since: iso(since), launchesThroughBlock: Number(store.meta('historian.launches.block') ?? 0) },
    };
    if (!traced) m.funders?.want([deployer]);
    return body;
  });

  /**
   * The public record. refused: coins whose live check found a honeypot. missed: coins whose first live check found none
   * and a later check did. calls: live first verdicts graded by the 24 h outcome (Danger and the coin went bad, or Clear
   * and it survived, is a hit; the reverse is a miss; Monitor and Info are not graded). cohort: per day, how launches with
   * no flags fared against all launches.
   */
  app.get<{ Querystring: { kind?: string; cursor?: string } }>('/v1/scoreboard', async (req) => {
    const kind = req.query.kind ?? 'calls', before = Number(req.query.cursor ?? Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;
    const since = store.query<{ t: number | null }>(`SELECT min(first_at) AS t FROM launches WHERE source = 'live'`)[0]!.t;
    const refused = store.query<{ n: number }>(`SELECT count(*) AS n FROM launches WHERE source = 'live' AND matches LIKE '%"honeypot","level":"danger"%'`)[0]!.n;
    const missed = store.query<{ n: number }>(`SELECT count(*) AS n FROM launches WHERE source = 'live' AND first_level IN ('clear','info','monitor') AND matches LIKE '%"honeypot","level":"danger"%'`)[0]!.n;
    const through = new Date().toISOString(), observed = { status: 'observed' as const, ...(since ? { since: iso(since)! } : {}), through };
    const page = 50;
    let rows: ScoreboardRow[] = [], cursor: string | null = null;
    const base = (l: Record<string, unknown>) => ({ id: `${kind}:${String(l.token)}`, ts: iso(Number(l.first_at ?? l.created_ts))!, coin: getAddress(String(l.token)) as Address });
    if (kind === 'honeypots_refused' || kind === 'honeypots_missed') {
      const extra = kind === 'honeypots_missed' ? `AND first_level IN ('clear','info','monitor')` : '';
      const found = store.query<Record<string, unknown>>(`SELECT * FROM launches WHERE source = 'live' AND matches LIKE '%"honeypot","level":"danger"%' ${extra} AND first_at < ? ORDER BY first_at DESC LIMIT ?`, before, page + 1);
      rows = found.slice(0, page).map(l => ({ ...base(l), kind, level: 'danger', detail: { event: kind === 'honeypots_refused' ? 'sell_check_failed' : 'honeypot_found_after_first_check', firstLevel: String(l.first_level) } }));
      cursor = found.length > page ? String(found[page - 1]!.first_at) : null;
    } else if (kind === 'calls') {
      const found = store.query<Record<string, unknown>>(`SELECT l.*, o.outcome, o.detail FROM launches l JOIN outcomes o ON o.token = l.token AND o.horizon = '24h'
        WHERE l.source = 'live' AND l.first_at < ? ORDER BY l.first_at DESC LIMIT ?`, before, page + 1);
      rows = found.slice(0, page).map(l => {
        const first = String(l.first_level), bad = BAD.has(String(l.outcome)), d = JSON.parse(String(l.detail ?? '{}')) as Record<string, number | null>;
        const grade = first === 'danger' ? (bad ? 'hit' : 'miss') : first === 'clear' ? (bad ? 'miss' : 'hit') : 'n/a';
        return { ...base(l), kind: 'calls' as const, level: (['clear', 'monitor', 'danger', 'info'].includes(first) ? first : 'info') as ScoreboardRow['level'], grade: grade as ScoreboardRow['grade'],
          detail: { outcome: String(l.outcome), ...(typeof d.dropFromPeak === 'number' ? { downFromPeakPct: Math.round(d.dropFromPeak * 1000) / 10 } : {}) } };
      });
      cursor = found.length > page ? String(found[page - 1]!.first_at) : null;
    } else if (kind === 'cohort') {
      const days = store.query<{ day: string; eligible: number; evaluated: number; clear: number; clearBad: number; bad: number; cut: number }>(`
        SELECT date(l.created_ts, 'unixepoch') AS day, count(*) AS eligible, count(o.token) AS evaluated,
          sum(CASE WHEN o.token IS NOT NULL AND l.first_level = 'clear' THEN 1 ELSE 0 END) AS clear,
          sum(CASE WHEN l.first_level = 'clear' AND o.outcome IN ('rugged','honeypot','dumped') THEN 1 ELSE 0 END) AS clearBad,
          sum(CASE WHEN o.outcome IN ('rugged','honeypot','dumped') THEN 1 ELSE 0 END) AS bad, max(l.created_block) AS cut
        FROM launches l LEFT JOIN outcomes o ON o.token = l.token AND o.horizon = '24h' WHERE l.swaps >= 10 GROUP BY 1 ORDER BY 1 DESC LIMIT 14`);
      rows = days.flatMap(d => (['clear', 'all'] as const).map(group => {
        const evaluated = group === 'clear' ? d.clear : d.evaluated, bad = group === 'clear' ? d.clearBad : d.bad;
        return { kind: 'cohort' as const, id: `cohort:${d.day}:${group}`, ts: `${d.day}T00:00:00.000Z`, detail: {
          week: d.day, group, eligible: d.eligible, evaluated, immature: Math.max(0, d.eligible - d.evaluated), censored: 0, ungraded: 0,
          rugRateStatus: evaluated ? 'observed' : 'unavailable', ...(evaluated ? { rugRatePct: (bad / evaluated) * 100 } : {}), rugDenominator: evaluated,
          medianStatus: 'unavailable', medianDenominator: 0, horizonSec: 86_400, membershipHash: `${d.day}:${group}:${evaluated}`, outcomeVersion: 'elysium-1', identityVersion: 'elysium-1', cutBlock: d.cut } };
      }));
    }
    const unavailable = { status: 'unavailable' as const, reason: 'monitoring_missing' as const };
    const body: ScoreboardResponse = { rows, cursor, counters: { refused, missed, since: iso(since) },
      availability: { refused: since ? observed : unavailable, missed: since ? observed : unavailable, grades: since ? observed : unavailable,
        forecasts: { status: 'unavailable', reason: 'd0_gated' }, cohort: observed, milestones: { status: 'unavailable', reason: 'd0_gated' } },
      snapshot: String(Number(edge.tracker.head)) };
    return body;
  });

  /**
   * The calibration table: for each measured feature at a point after launch, outcome rates by bucket. Thresholds are
   * refit from this (scripts/calibrate.ts prints it as a report).
   */
  app.get<{ Querystring: { at?: string; horizon?: string; target?: string } }>('/v1/memory/calibration', async (req) =>
    calibration(store, Number(req.query.at ?? 3600), req.query.horizon === '1h' ? '1h' : '24h', req.query.target === 'outcome' ? 'outcome' : 'halved'));
}

export const BUCKETS: Record<string, number[]> = {
  top10: [0.1, 0.2, 0.3, 0.5], largest: [0.05, 0.1, 0.2], devHeld: [0.01, 0.05, 0.1, 0.2], devSold: [0.01, 0.05, 0.2],
  cohortBought: [0.1, 0.2, 0.3, 0.5], cohortHeld: [0.05, 0.1, 0.15, 0.3], snipersBought: [0.02, 0.05, 0.1, 0.2, 0.3], snipersHeld: [0.02, 0.05, 0.1, 0.15, 0.25],
  snipers: [1, 3, 5, 10], buyers: [3, 10, 30, 100], peakMultiple: [2, 5, 10, 50], transferred: [0.01, 0.05, 0.1],
};

/**
 * target 'halved' (default): bad means the price at the feature point (`at`: 5 minutes or an hour in) had halved by the
 * horizon (24 h): a buyer then lost half. EKO's Robinhood Chain thresholds were fitted on the same kind of measure. target 'outcome': bad means rugged, honeypot or dumped (on Elysium most
 * traded launches are flipped within the hour, so this one says little on its own).
 */
export function calibration(store: HistoryStore, at: number, horizon: '1h' | '24h', target: 'halved' | 'outcome' = 'halved') {
  const rows = store.query<{ data: string; outcome: string; detail: string }>(`SELECT f.data, o.outcome, o.detail FROM features f JOIN outcomes o ON o.token = f.token AND o.horizon = ? WHERE f.at_sec = ?`, horizon, at)
    .map(r => ({ f: JSON.parse(r.data) as Record<string, number | null>, d: JSON.parse(r.detail ?? '{}') as Record<string, number | null>, outcome: r.outcome }))
    .filter(r => target === 'outcome' || typeof r.d[`halvedFrom${at}`] === 'number')
    .map(r => ({ ...r, bad: target === 'outcome' ? BAD.has(r.outcome) : r.d[`halvedFrom${at}`] === 1 }));
  const base = rows.length ? rows.filter(r => r.bad).length / rows.length : null;
  const features = Object.fromEntries(Object.entries(BUCKETS).map(([name, edges]) => {
    const bounds = [-Infinity, ...edges, Infinity];
    return [name, bounds.slice(0, -1).map((lo, i) => {
      const hi = bounds[i + 1]!, inBucket = rows.filter(r => typeof r.f[name] === 'number' && r.f[name]! >= lo && r.f[name]! < hi);
      return { from: Number.isFinite(lo) ? lo : null, to: Number.isFinite(hi) ? hi : null, n: inBucket.length,
        badRate: inBucket.length ? Math.round((inBucket.filter(r => r.bad).length / inBucket.length) * 1000) / 1000 : null };
    })];
  }));
  return { at, horizon, target, samples: rows.length, baseBadRate: base === null ? null : Math.round(base * 1000) / 1000,
    outcomes: rows.reduce<Record<string, number>>((o, r) => { o[r.outcome] = (o[r.outcome] ?? 0) + 1; return o; }, {}), features };
}
