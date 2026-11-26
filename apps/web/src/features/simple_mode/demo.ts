import { FlowSchema, type FlowActivity, type RadarRow } from '@eko/shared';
import type { FeatureDemo } from '../../features';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { MOCK_HEAD_BLOCK } from '../../mocks/head';

/**
 * Data for mock mode (VITE_MOCKS=1 VITE_FLAGS=simple_mode), shown in update films once the feature is live, so nothing
 * on screen may read as made up. Loaded only in mock mode (features.ts `demo`).
 *
 * The mock radar's coins carry no trading counts, which the live edge measures for every coin: last hour's and the
 * day's volume and trades, the usual hour, and each window's buyers and sellers. This fills them in, the same for every
 * load, from each coin's own liquidity and price moves (a coin that rose had more buyers than sellers), so Simple's
 * "Busy right now", "Trading last hour" and "Who's buying" show as they do on the live site. Coins that already carry
 * them are left as they are.
 */
const AVG_TRADE_USD = 140;
const WINDOW_SEC = { '5m': 300, '1h': 3600, '24h': 86_400 } as const;
type Window = keyof typeof WINDOW_SEC;

/** A stable number in [0, 1) for a coin and a salt. */
function unit(address: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (const ch of address.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}
const round = (n: number) => Math.round(n * 100) / 100;

/** A coin's trading in a window, from its liquidity and how its price moved in that window. */
export function activityFor(row: Pick<RadarRow, 'address' | 'liquidityUsd' | 'change1hPct' | 'change24hPct'>, window: Window): FlowActivity {
  const move = window === '24h' ? row.change24hPct ?? row.change1hPct : row.change1hPct;
  const turnover = (0.03 + Math.min(0.6, Math.abs(move) / 60)) * (0.6 + unit(row.address, 1)) * (window === '24h' ? 9 : window === '5m' ? 0.12 : 1);
  const volume = Math.max(0, row.liquidityUsd * turnover);
  const trades = Math.max(volume > 0 ? 3 : 0, Math.round(volume / (AVG_TRADE_USD * (0.7 + unit(row.address, 2)))));
  const buyShare = Math.min(0.82, Math.max(0.18, 0.5 + move / 80 + (unit(row.address, 3) - 0.5) / 10));
  const buys = Math.round(trades * buyShare), sells = trades - buys;
  const buyUsd = round(volume * buyShare), sellUsd = round(volume - buyUsd);
  // Most wallets trade once or twice in a window.
  const buyers = Math.max(buys ? 1 : 0, Math.round(buys / (1.2 + unit(row.address, 4) * 0.6)));
  const sellers = Math.max(sells ? 1 : 0, Math.round(sells / (1.2 + unit(row.address, 5) * 0.6)));
  return { buyUsd, sellUsd, netUsd: round(buyUsd - sellUsd), buys, sells, buyers, sellers, unattributed: 0 };
}

/** A radar row with its trading counts filled in, when it has none. */
export function withTrading(row: RadarRow): RadarRow {
  if (row.volume1hUsd !== undefined || row.unavailable?.includes('volume')) return row;
  const hour = activityFor(row, '1h'), day = activityFor(row, '24h');
  return { ...row, volume1hUsd: round(hour.buyUsd + hour.sellUsd), trades1h: hour.buys + hour.sells,
    volumeBaselineUsd: round((day.buyUsd + day.sellUsd) / 24 * (0.5 + unit(row.address, 6))), volume24hUsd: round(day.buyUsd + day.sellUsd), trades24h: day.buys + day.sells };
}

const demo: FeatureDemo = {
  fetch({ method, route, query }) {
    if (method !== 'GET') return undefined;
    if (route === '/radar') return { body: { rows: createRadarRows().map(withTrading), cursor: null, delayedSec: 0 } };
    const flow = /^\/coins\/(0x[0-9a-fA-F]{40})\/flow$/.exec(route);
    if (!flow) return undefined;
    const address = flow[1]!, row = createRadarRows().find(r => r.address.toLowerCase() === address.toLowerCase()), card = createRadarCard(address);
    if (!row || !card || row.volume1hUsd !== undefined) return undefined;
    const window = (query.get('window') ?? '1h') as Window;
    if (!(window in WINDOW_SEC)) return undefined;
    return { body: FlowSchema.parse({ ...card.flow, window, activity: activityFor(row, window),
      meta: { confidence: 1, asOfBlock: MOCK_HEAD_BLOCK, flags: ['activity_measured'] } }) };
  },
};
export default demo;
