import { formatGuardReason, GUARD_REASON_LABELS, GuardReasonV2Schema, GuardReasonCodeSchema, GuardFactorIdSchema, guardName } from '@eko/shared';
import { z } from 'zod';
import { FeedItemSchema, PairRowSchema, type FeedItem, type PairRow, type Untrusted } from '@eko/shared';
import type { ChannelEvent } from '../../lib/realtime';
import { launchedAt, PLAYBOOK_NAMES, receivedAt, refused, type ReceivedAt, type RiskMode } from './radarModel';
import { PLAYBOOK_DESCRIPTIONS } from '../../copy/playbooks';
import { WALLET_LABEL_WORD } from '../../components/ui';

export const COLUMNS = ['new', 'near_grad', 'migrated'] as const;
export const PairResponseSchema = z.object({ rows: z.array(PairRowSchema), cursor: z.string().nullable(), delayedSec: z.number(), unavailable:z.array(z.string()).optional(),
  today: z.object({ launches: z.number(), medianFirstScanSec: z.number().nullable(), refused: z.number() }).optional() });
export type PairsToday = NonNullable<z.infer<typeof PairResponseSchema>['today']>;
/** "35 s" under two minutes, then whole minutes. */
export const firstScanText = (sec: number) => sec < 10 ? `${sec.toFixed(1)} s` : sec < 120 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`;
export const FeedResponseSchema = z.object({ rows: z.array(FeedItemSchema), cursor: z.string().nullable(), delayedSec: z.number(), unavailable:z.array(z.string()).optional() });
export { launchedAt, receivedAt, type ReceivedAt };
export function pairColumns(rows: readonly PairRow[], received?: ReceivedAt) {
  // TODO(spec): PairRow has no migration timestamp. Keep the server's migrated order; WS migrations prepend the row.
  const newest = (a: PairRow, b: PairRow) => launchedAt(b, received) - launchedAt(a, received) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  return Object.fromEntries(COLUMNS.map((column) => [column, rows.filter((r) => r.column === column).sort((a, b) => column === 'migrated' ? 0 : column === 'near_grad' ? (b.graduationPct ?? b.curvePct ?? 0) - (a.graduationPct ?? a.curvePct ?? 0) : newest(a, b)).slice(0, 100)])) as Record<PairRow['column'], PairRow[]>;
}
export function applyPairEvents(rows: readonly PairRow[], events: readonly ChannelEvent<'pairs'>[], received?: ReceivedAt) {
  let next = [...rows];
  for (const event of events) {
    if (event.kind === 'pair_remove') next = next.filter((r) => r.address !== event.data.address || r.column !== event.data.column);
    else {
      const previous = next.find(r => r.address === event.data.address);
      const row = { ...event.data, ...(event.data.guardV2 === undefined && previous?.guardV2 !== undefined ? {guardV2:previous.guardV2,guardRefreshFailed:previous.guardRefreshFailed} : {}) };
      // Migrated keeps the order it arrived in, so only a coin coming from a curve column is a new migration and goes
      // first. A coin already listed there keeps its place when it trades or is re-rated, and a graduated coin not listed
      // (an older one) goes last: every re-rating sent older coins to the top on 2026-10-12.
      if (row.column === 'migrated' && previous?.column === 'migrated') next = next.map((r) => r.address === row.address ? row : r);
      else if (row.column === 'migrated' && !previous) next.push(row);
      else { next = next.filter((r) => r.address !== row.address); next.unshift(row); }
    }
  }
  const columns = pairColumns(next, received);
  return COLUMNS.flatMap((column) => columns[column]);
}
export function antiSnipeLeft(endsInSec: number, receivedAt: number, now: number) {
  return Math.max(0, Math.ceil(endsInSec - Math.max(0, now - receivedAt) / 1000));
}
// TODO(spec): antiSnipe has no decay curve. Interpolate linearly from the supplied tax to zero, matching the prototype, until a new reading arrives.
export function antiSnipeTax(taxPct: number, endsInSec: number, receivedAt: number, now: number) {
  if (endsInSec <= 0) return 0;
  return Math.max(0, Math.round(taxPct * Math.max(0, endsInSec - Math.max(0, now - receivedAt) / 1000) / endsInSec));
}
export const pairTradeDisabled = (row: PairRow, stale = false, tradingLive = true, mode: RiskMode = 'balanced') => row.verdictPending || refused(row, mode) || stale || !tradingLive;
export const FEED_RING = 500;
export interface FeedBuffer { items: FeedItem[]; waiting: FeedItem[] }
export function feedRing(rows: readonly FeedItem[]) {
  const unique = new Map<string, FeedItem>();
  rows.forEach((item) => { if (!unique.has(item.id)) unique.set(item.id, item); });
  // A launch is announced a moment before its name is indexed, so its live row has no ticker. A later row for the same
  // coin (its first scan) carries one: earlier rows take it instead of showing a bare address until the next reload.
  const named = new Map<string, FeedItem['symbol']>();
  for (const item of unique.values()) if (item.symbol.text.trim() && !named.has(item.coin)) named.set(item.coin, item.symbol);
  return [...unique.values()].map((item) => item.symbol.text.trim() || !named.has(item.coin) ? item : { ...item, symbol: named.get(item.coin)! })
    .sort((a, b) => b.ts - a.ts).slice(0, FEED_RING);
}
export function receiveFeed(buffer: FeedBuffer, rows: readonly FeedItem[], paused: boolean): FeedBuffer {
  return paused ? { items: buffer.items, waiting: feedRing([...rows.filter((r) => !buffer.items.some((i) => i.id === r.id)), ...buffer.waiting]) }
    : { items: feedRing([...rows, ...buffer.waiting, ...buffer.items]), waiting: [] };
}
export const flushFeed = (buffer: FeedBuffer): FeedBuffer => ({ items: feedRing([...buffer.waiting, ...buffer.items]), waiting: [] });
/** A verdict row within this long of the coin's launch is its first scan; later ones are re-grades. */
export const FIRST_VERDICT_MAX_MS = 600_000;
export const FEED_GROUPS = ['trade', 'scan', 'alert', 'ghost', 'swarm', 'launch', 'burn'] as const;
export type FeedGroup = typeof FEED_GROUPS[number];
export const feedGroup = (kind: FeedItem['kind']): FeedGroup => ({ trade: 'trade', agent_trade: 'trade', crew_trade: 'trade', verdict: 'scan', playbook: 'alert', clone: 'ghost', wash: 'alert', swarm: 'swarm', new_pair: 'launch', graduation: 'launch', burn: 'burn' })[kind] as FeedGroup;
// CA-32: each optional field contributes only its own part of the description.
export type DescriptionStyle = 'label' | 'name' | 'address' | 'muted' | 'buy' | 'sell' | 'ghost';
export type DescriptionPart = { text: string; style?: DescriptionStyle } | { value: Untrusted; prefix?: string; style?: DescriptionStyle };
export function feedDescriptionParts(item: FeedItem): DescriptionPart[] {
  if (item.guardReason) return [{ text: formatGuardReason(GuardReasonV2Schema.parse(item.guardReason)) }];
  if (item.guardReasonCode) return [{ text: GUARD_REASON_LABELS[GuardReasonCodeSchema.parse(item.guardReasonCode)] }];
  if (item.guardFactorId) return [{ text: guardName(GuardFactorIdSchema.parse(item.guardFactorId)) }];
  const parts: DescriptionPart[] = [];
  const text = (value: string, style?: DescriptionStyle) => parts.push({ text: value, style });
  const separator = () => text('·', 'muted');
  switch (item.kind) {
    case 'trade':
      if (item.wallet) text(`${item.wallet.slice(0, 6)}…${item.wallet.slice(-4)}`, 'address');
      if (item.side) text(item.side === 'buy' ? 'bought' : 'sold', item.side);
      break;
    case 'agent_trade': case 'crew_trade':
      if (item.label) text(WALLET_LABEL_WORD[item.label], 'label');
      if (item.agentName) parts.push({ value: item.agentName, style: 'name' });
      else if (item.crewName) text(item.crewName, 'name');
      else if (item.wallet) text(`${item.wallet.slice(0, 6)}…${item.wallet.slice(-4)}`, 'address');
      if (item.crewWallets !== undefined) text(`${item.crewWallets} wallets`, 'muted');
      if (item.side) text(item.side === 'buy' ? 'bought' : 'sold', item.side);
      break;
    case 'verdict':
      // A first scan lands within minutes of launch. A longer gap is a coin graded again or first graded long after
      // its launch, which read "First verdict in 276119.0 s".
      text(item.firstVerdictMs === undefined ? 'First verdict' : item.firstVerdictMs <= FIRST_VERDICT_MAX_MS ? `First verdict in ${(item.firstVerdictMs / 1000).toFixed(1)} s` : 'Grade updated');
      // A verdict row names no playbook of its own: "no playbook matched" is said only of a grade without one, never
      // beside Monitor or Danger (the row's grade chip and the alert rows carry the finding).
      if (item.playbookId) { separator(); text(PLAYBOOK_NAMES[item.playbookId], 'muted'); }
      else if (item.level === undefined || item.level === 'clear') { separator(); text('no playbook matched', 'muted'); }
      break;
    case 'playbook':
      if (item.playbookId) text(PLAYBOOK_NAMES[item.playbookId], 'name');
      text(item.matchPct === undefined ? 'matched' : `matched at ${Math.round(item.matchPct)}%`, 'muted');
      if (item.playbookId) { separator(); text(PLAYBOOK_DESCRIPTIONS[item.playbookId]); }
      break;
    case 'clone':
      text('Ghost Report', 'ghost');
      if (item.cloneOf) { separator(); text('Clone of'); parts.push({ value: item.cloneOf, prefix: '$', style: 'name' }); }
      if (item.clones7d !== undefined) { separator(); text(`${item.clones7d} clones from this crew this week`, 'muted'); }
      break;
    case 'wash': text('Playbook alert'); separator(); text('Wash trading'); break;
    case 'swarm':
      if (item.swarm) { text(`${item.swarm.pass} of ${item.swarm.of} personas pass`); separator(); }
      text('graded against all launches', 'muted');
      break;
    case 'new_pair': text('New pair created'); break;
    case 'graduation': text('Graduated to a pool'); break;
    case 'burn': text('Burn recorded'); break;
  }
  return parts;
}
export function feedDescription(item: FeedItem): string {
  return feedDescriptionParts(item).map((part) => 'text' in part ? part.text : `${part.prefix ?? ''}${part.value.text}`).join(' ');
}
