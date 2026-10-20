import { binary, hex, type ChainDb } from '@eko/db';
import type { Address, BlueChip, BlueChipCriteria } from '@eko/shared';

export interface BlueChipConfig extends BlueChipCriteria { enabled: boolean }
export function blueChipConfig(cfg: { BLUE_CHIP_ENABLED: boolean; BLUE_CHIP_MIN_AGE_DAYS: number; BLUE_CHIP_MIN_LIQUIDITY_USD: number; BLUE_CHIP_MIN_HOLDERS: number }): BlueChipConfig {
  return { enabled:cfg.BLUE_CHIP_ENABLED,minAgeDays:cfg.BLUE_CHIP_MIN_AGE_DAYS,minLiquidityUsd:cfg.BLUE_CHIP_MIN_LIQUIDITY_USD,minHolders:cfg.BLUE_CHIP_MIN_HOLDERS };
}
/** Read-time membership over latest measurements only. Missing measurements cannot earn membership. */
export class BlueChipReader {
  constructor(readonly db: ChainDb, readonly config: BlueChipConfig, readonly now: () => number = Date.now) {}
  get criteria(): BlueChipCriteria { const { enabled: _enabled, ...criteria } = this.config; return criteria; }
  /** Parameters are appended so callers retain their existing cursor bindings and ordering. */
  predicate(coin: string, params: unknown[], tier?: string) {
    const start = params.length;
    params.push(new Date(this.now()-this.config.minAgeDays*86400000),this.config.minLiquidityUsd,this.config.minHolders);
    return `(EXISTS(SELECT 1 FROM coin_listings l WHERE l.coin=${coin} AND l.source='coingecko' AND l.active) OR
      EXISTS(SELECT 1 FROM read_blue_chip b JOIN coin_card_latest c ON c.coin=b.coin AND c.as_of_block=b.as_of_block
      WHERE b.coin=${coin} AND ${tier ? `${tier}=0` : `c.data->'verdict'->>'level'='clear'`} AND b.real_pool
      AND NOT EXISTS(SELECT 1 FROM read_blue_chip_danger d WHERE d.coin=b.coin)
      AND b.created_at<=$${start+1} AND b.liquidity_usd>=$${start+2} AND b.holders>=$${start+3}))`;
  }
  async members(coins: Address[]): Promise<Map<Address,BlueChip>> {
    if (!this.config.enabled || !coins.length) return new Map();
    const params: unknown[] = [coins.map(binary)];
    const predicate = this.predicate('t.address',params);
    const rows = (await this.db.sql.query<{coin:Uint8Array;member:boolean;listed:boolean;earned:boolean}>(`SELECT t.address AS coin,
      ${predicate} AS member,EXISTS(SELECT 1 FROM coin_listings l WHERE l.coin=t.address AND l.source='coingecko' AND l.active) AS listed,
      EXISTS(SELECT 1 FROM read_blue_chip b JOIN coin_card_latest c ON c.coin=b.coin AND c.as_of_block=b.as_of_block
      WHERE b.coin=t.address AND c.data->'verdict'->>'level'='clear' AND b.real_pool AND b.created_at<=$2 AND b.liquidity_usd>=$3 AND b.holders>=$4
      AND NOT EXISTS(SELECT 1 FROM read_blue_chip_danger d WHERE d.coin=b.coin)) AS earned
      FROM tokens t WHERE t.address=ANY($1::bytea[])`,params)).rows;
    return new Map(rows.map(r=>[hex(r.coin),{member:r.member,via:[...(r.listed ? ['coingecko' as const] : []),...(r.earned ? ['earned' as const] : [])]}]));
  }
}
