import type { RadarRow } from '@eko/shared';
import type { FeatureDemo } from '../../features';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { MOCK_HEAD_BLOCK } from '../../mocks/head';
import { GROUP_IDS, type Dump, type Figure, type GroupId, type Summary } from './model';

/**
 * Data for mock mode (VITE_MOCKS=1 VITE_FLAGS=dump_test), shown in update films once the feature is live, so nothing on
 * screen may read as made up. For each mock radar coin it works out the dump test the edge's way from the coin's own
 * card: the dev's share and the bundles' share as the card states them, dev-funded wallets from the wallets the card
 * names as exempt, snipers from how concentrated the top holders are, a few early buyers still holding; then the
 * venue's depth, constant product as on a Pons curve or a full-range pool, set so the all-insiders fall agrees with the
 * coin's verdict (Danger 62-90%, Monitor 30-56%, Clear 7-22%). Each group's own fall then follows from the same depth.
 * Coins in pools quoted in a token get no figure, as on the edge. It answers GET /v2/coins/:address/dump and adds each
 * coin's figure to the radar list's rows (RadarRow.extras.dump_test). Loaded only in mock mode (features.ts `demo`).
 */
const SUPPLY = 1_000_000_000;
const PONS_HOOK_FEE = 0.0295, CURVE_FEE = 0.01;

/** A stable number in [0, 1) for a coin and a salt. */
function unit(address: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (const ch of address.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}
const r1 = (n: number) => Math.round(n * 10) / 10, r2 = (n: number) => Math.round(n * 100) / 100;
const tokens = (sharePct: number) => (BigInt(Math.round(sharePct / 100 * SUPPLY * 1000)) * 10n ** 15n).toString();

export function dumpFor(address: string): Dump | undefined {
  const row = createRadarRows().find(r => r.address.toLowerCase() === address.toLowerCase()), card = createRadarCard(address);
  if (!row || !card || row.quoteSymbol) return undefined;
  const base = { version: 1 as const, coin: row.address, at: new Date().toISOString(), asOfBlock: MOCK_HEAD_BLOCK };
  const s = card.supply, u = (salt: number) => unit(row.address, salt), danger = row.verdict === 'danger', clear = row.verdict === 'clear';
  const share: Record<GroupId, number> = {
    dev: r2(s.devPct ?? 0),
    linked: r2(danger ? Math.min(30, (s.exemptWalletsHeldPct ?? 0) * 0.6) + u(1) * 2 : (s.exemptWalletsHeldPct ?? 0) * 0.3),
    bundle: r2(Math.min(25, s.bundlesHeldPct ?? 0)),
    sniper: r2(Math.max(0.4, Math.min(8, (s.top10Pct ?? 0) * (clear ? 0.03 : 0.07) + u(2) * 1.5))),
    early: r2(0.4 + u(3) * (clear ? 1 : 2.5)),
  };
  const all = GROUP_IDS.reduce((n, g) => n + share[g], 0);
  const fall = (danger ? 62 + u(4) * 28 : clear ? 7 + u(4) * 15 : 30 + u(4) * 26) / 100;
  // The venue's depth (in % of supply) at which all insiders selling gives that fall: 1 − (y/(y+X))² = fall.
  const k = Math.sqrt(1 - fall), depth = all * k / (1 - k);
  const venue: Extract<Dump, { measured: true }>['venue'] = row.stage === 'curve' ? 'curve' : row.launchpad === 'pons' ? 'pool' : 'quoter';
  const fee = venue === 'curve' ? CURVE_FEE + (card.tradeability.sellTaxPct ?? 0) / 100 : venue === 'pool' ? PONS_HOOK_FEE : 0.01;
  // A curve whose insiders could take more ETH than it holds runs dry: the sells stop there, and nothing is left for a holder.
  const drains = venue === 'curve' && fall >= 0.86;
  const figure = (id: GroupId | 'all', pct: number, wallets: number): Figure => {
    const f = 1 - (depth / (depth + pct)) ** 2, dry = drains && id === 'all';
    return { id, wallets: pct > 0 ? wallets : 0, tokens: tokens(pct), sharePct: r2(pct), changePct: pct > 0 ? -r1(f * 100) : 0,
      usd100: dry ? 0 : r2(100 * (1 - f) * (1 - fee)), ...(dry ? { drains: true as const } : {}) };
  };
  const wallets: Record<GroupId, number> = { dev: 1, linked: 1 + Math.round(share.linked / 1.6), bundle: 3 + Math.round(u(5) * 9), sniper: 2 + Math.round(u(6) * 6), early: 3 + Math.round(u(7) * 12) };
  const groups = GROUP_IDS.map(g => figure(g, share[g], wallets[g]));
  return { ...base, measured: true, venue, groups, all: figure('all', all, groups.reduce((n, g) => n + g.wallets, 0)),
    sellFeePct: venue === 'quoter' ? null : r2(fee * 100), funding: true };
}

/** The radar row's figure, as the edge adds it. */
export function summaryFor(row: Pick<RadarRow, 'address'>): Summary | undefined {
  const d = dumpFor(row.address);
  return d?.measured && d.all.changePct !== null && d.all.usd100 !== null ? { changePct: d.all.changePct, usd100: d.all.usd100, sharePct: d.all.sharePct } : undefined;
}

const demo: FeatureDemo = {
  fetch({ method, route }) {
    const m = /^\/v2\/coins\/(0x[0-9a-fA-F]{40})\/dump$/.exec(route);
    if (!m || method !== 'GET') return undefined;
    const reply = dumpFor(m[1]!);
    return reply ? { body: reply } : { status: 404, body: { error: 'not_found', message: 'EKO does not follow this coin yet.' } };
  },
  amend({ method, route }, body) {
    if (method !== 'GET' || (route !== '/radar' && route !== '/v2/radar')) return undefined;
    const b = body as { rows?: RadarRow[] };
    if (!Array.isArray(b?.rows)) return undefined;
    return { ...b, rows: b.rows.map(r => { const s = summaryFor(r); return s ? { ...r, extras: { ...r.extras, dump_test: s } } : r; }) };
  },
};
export default demo;
