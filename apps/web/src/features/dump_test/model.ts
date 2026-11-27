import { z } from 'zod';
import { AddressSchema, type RadarRow } from '@eko/shared';
import type { GlanceTone } from '../../components/GlanceTile';
import { fetchParsed } from '../../lib/api';

/**
 * Mirrors apps/edge/src/features/dump_test: GET /v2/coins/:address/dump, and the Radar row's figure
 * (RadarRow.extras.dump_test). Pure helpers for the words and tones, shared by the coin page, the lists and the demo.
 */
export const GROUP_IDS = ['dev', 'linked', 'bundle', 'sniper', 'early'] as const;
export type GroupId = (typeof GROUP_IDS)[number];
export const FigureSchema = z.object({
  id: z.enum([...GROUP_IDS, 'all']), wallets: z.number().int().nonnegative(), tokens: z.string().regex(/^\d+$/), sharePct: z.number().min(0).max(100),
  changePct: z.number().min(-100).max(0).nullable(), usd100: z.number().min(0).max(100).nullable(), drains: z.literal(true).optional(),
});
const Base = { version: z.literal(1), coin: AddressSchema, at: z.string(), asOfBlock: z.number() };
export const DumpSchema = z.discriminatedUnion('measured', [
  z.object({ ...Base, measured: z.literal(true), venue: z.enum(['curve', 'pool', 'quoter']), groups: z.array(FigureSchema), all: FigureSchema,
    sellFeePct: z.number().nullable(), funding: z.boolean() }),
  z.object({ ...Base, measured: z.literal(false), reason: z.enum(['partial_history', 'unknown_venue', 'unavailable']) }),
]);
export type Dump = z.infer<typeof DumpSchema>;
export type Measured = Extract<Dump, { measured: true }>;
export type Figure = z.infer<typeof FigureSchema>;
export const SummarySchema = z.object({ changePct: z.number().min(-100).max(0), usd100: z.number().min(0).max(100), sharePct: z.number().min(0).max(100) });
export type Summary = z.infer<typeof SummarySchema>;

/** The Radar row's figure, or null when the row has none (or not in this shape). */
export function summaryOf(row: Pick<RadarRow, 'extras'>): Summary | null {
  const r = SummarySchema.safeParse(row.extras?.dump_test);
  return r.success ? r.data : null;
}

export const dumpPath = (coin: string) => `/v2/coins/${coin}/dump`;
/** One read per coin, shared by the tile, the section and the fact, kept for half a minute (the edge refreshes at most every 45 s). */
const cache = new Map<string, { at: number; value: Promise<Dump> }>();
export function loadDump(coin: string, now = Date.now()): Promise<Dump> {
  const key = coin.toLowerCase(), hit = cache.get(key);
  if (hit && now - hit.at < 30_000) return hit.value;
  const value = fetchParsed(dumpPath(coin), DumpSchema, { background: true });
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  return value;
}

/** How far the price falls, as a positive percent. */
export const fallOf = (changePct: number) => Math.max(0, -changePct);
/** Severity: a fall of 60% or more is coral (bad), 25-60% Monitor ice (watch), under 25% good. */
export function toneOf(changePct: number): Extract<GlanceTone, 'good' | 'watch' | 'bad'> {
  const f = fallOf(changePct);
  return f >= 60 ? 'bad' : f >= 25 ? 'watch' : 'good';
}
/** "−83%", "−0.4%" for a sliver, "0%" for none. */
export function changeText(changePct: number): string {
  const f = fallOf(changePct);
  if (f === 0) return '0%';
  return f < 1 ? `−${f.toFixed(1)}%` : `−${Math.round(f)}%`;
}
/** "$17"; "<$1" for a sliver; "$0" when nothing is left. */
export const dollarsText = (usd: number) => usd <= 0 ? '$0' : usd < 1 ? '<$1' : `$${Math.round(usd)}`;
export const keepLine = (usd100: number) => `$100 → ${dollarsText(usd100)}`;
/** A share of supply: "4.1%", "<0.1%". */
export const shareText = (pct: number) => pct <= 0 ? '0%' : pct < 0.1 ? '<0.1%' : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
/** Whole tokens from base units (18 decimals), short: "50M", "1.2B", "820K". */
export function tokensText(base: string): string {
  const n = Number(BigInt(base) / 10n ** 12n) / 1e6;
  const short = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toPrecision(2))}${unit}`;
  return n >= 1e9 ? short(n / 1e9, 'B') : n >= 1e6 ? short(n / 1e6, 'M') : n >= 1e3 ? short(n / 1e3, 'K') : n > 0 ? short(n, '') : '0';
}

export const GROUP_LABEL: Record<GroupId | 'all', string> = { dev: 'Dev', linked: 'Dev-funded', bundle: 'Bundles', sniper: 'Snipers', early: 'Early buyers', all: 'All insiders' };
const GROUP_WORD: Record<GroupId, string> = { dev: 'the dev', linked: 'wallets the dev funded', bundle: 'bundle wallets', sniper: 'launch snipers', early: 'early buyers' };

/** The one plain sentence: what the figure means for someone holding the coin. */
export function sentence(r: Measured): string {
  const a = r.all;
  if (a.wallets === 0) return 'EKO finds no insider still holding this coin, so there is nothing left for them to dump.';
  if (a.changePct === null || a.usd100 === null) return `Insiders hold ${shareText(a.sharePct)} of supply, but EKO could not price a sale that size in this coin's pool.`;
  const top = r.groups.filter(g => g.wallets > 0).sort((x, y) => y.sharePct - x.sharePct)[0];
  const most = top && r.groups.filter(g => g.wallets > 0).length > 1 ? ` The biggest part is with ${GROUP_WORD[top.id as GroupId]} (${shareText(top.sharePct)}).` : '';
  if (a.drains) return `EKO estimates insiders hold enough (${shareText(a.sharePct)} of supply) to take all the ETH in the curve if they sold at once: the price would fall ${Math.round(fallOf(a.changePct))}% and holders after them could not sell.${most}`;
  return `EKO estimates that if insiders sold everything they hold (${shareText(a.sharePct)} of supply) at once, the price would fall about ${Math.round(fallOf(a.changePct))}% and $100 held now would be worth about ${dollarsText(a.usd100)}.${most}`;
}

export const NOT_MEASURED: Record<Extract<Dump, { measured: false }>['reason'], string> = {
  partial_history: 'No figure for this coin: EKO started following it after launch, so it does not know every insider\'s balance.',
  unknown_venue: 'No figure for this coin: EKO cannot price a sale where it trades.',
  unavailable: 'Not worked out yet. EKO checks again within a minute.',
};
export const VENUE: Record<Measured['venue'], string> = { curve: 'its bonding curve', pool: 'its pool', quoter: 'its pool' };
