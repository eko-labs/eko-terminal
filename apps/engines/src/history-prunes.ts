import { binary, hex, type ChainDb } from '@eko/db';
import type { Address, AttributionCoverageGap } from '@eko/shared';

/**
 * Retention summary of a coin whose raw history was dropped (packages/db/src/retention.ts, `history_prunes`). Up to
 * `watermark` its transfers survive only as baselines (balances stay exact) and its liquidity, Pons events and, when
 * `swaps` is non-zero, swaps are gone. Such a coin was quiet: nothing about it changes until it trades or moves again.
 */
export interface HistoryPrune {
  preserved?:boolean;
  watermark: number; transfers: number; liquidity: number; pons: number; swaps: number;
  /** Set when the coin was rated Danger (by level or by a Danger playbook) when pruned, with those playbook ids. */
  dangerBeforePrune?: { playbooks: string[] };
}
interface Row { preserved?:boolean; watermark: string; transfers: string; liquidity: string; pons: string; swaps: string; verdict_level: string | null; danger_playbooks: unknown }
const columns = 'greatest(through_block,coalesce(swaps_through_block,0))::text AS watermark,transfers::text,liquidity::text,pons::text,swaps::text,verdict_level,danger_playbooks,EXISTS(SELECT 1 FROM coin_lifetime l WHERE l.coin=history_prunes.coin) AS preserved';
const parse = (r: Row): HistoryPrune => {
  const playbooks = Array.isArray(r.danger_playbooks) ? r.danger_playbooks.filter((id): id is string => typeof id === 'string') : [];
  return { ...(r.preserved ? {preserved:true}:{}),watermark: Number(r.watermark), transfers: Number(r.transfers), liquidity: Number(r.liquidity), pons: Number(r.pons), swaps: Number(r.swaps),
    ...(r.verdict_level === 'danger' || playbooks.length ? { dangerBeforePrune: { playbooks } } : {}) };
};

export async function historyPrune(db: ChainDb, coin: Address): Promise<HistoryPrune | undefined> {
  const row = (await db.sql.query<Row>(`SELECT ${columns} FROM history_prunes WHERE coin=$1`, [binary(coin)])).rows[0];
  return row ? parse(row) : undefined;
}
export async function historyPrunes(db: ChainDb): Promise<Map<Address, HistoryPrune>> {
  return new Map((await db.sql.query<Row & { coin: Uint8Array }>(`SELECT coin,${columns} FROM history_prunes`)).rows.map(r => [hex(r.coin) as Address, parse(r)]));
}
/** A swap or transfer of the coin after its watermark, at or before `block`: the coin came back to life. */
export async function revivedBy(db: ChainDb, coin: Address, prune: HistoryPrune, block: number): Promise<boolean> {
  return (await db.sql.query(`SELECT 1 FROM swaps WHERE coin=$1 AND block>$2 AND block<=$3
    UNION ALL SELECT 1 FROM token_transfers WHERE token=$1 AND block>$2 AND block<=$3
    UNION ALL SELECT 1 FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE $4::boolean AND (p.currency0=$1 OR p.currency1=$1) AND e.block>$2 AND e.block<=$3
    UNION ALL SELECT 1 FROM pons_events WHERE $4::boolean AND token=$1 AND block>$2 AND block<=$3
    UNION ALL SELECT 1 FROM pons_exemptions WHERE $4::boolean AND token=$1 AND block>$2 AND block<=$3
    UNION ALL SELECT 1 FROM pools WHERE $4::boolean AND (currency0=$1 OR currency1=$1) AND created_block>$2 AND created_block<=$3 LIMIT 1`, [binary(coin), prune.watermark, block,prune.preserved ?? false])).rows.length > 0;
}
/** A check that needs raw history retention removed: reported as not fully checked, never as a pass. */
export function prunedGap(pruned: number, kept: number): AttributionCoverageGap {
  const total = pruned + kept;
  return { reason: 'history_pruned', window: 'launch_to_checkpoint', status: 'incomplete', threshold: 0, totalCount: total, unattributedCount: pruned,
    countShare: total ? pruned / total : 0, totalVolumeUsd: null, unattributedVolumeUsd: null, volumeShare: null, unknownVolumeCount: pruned };
}
