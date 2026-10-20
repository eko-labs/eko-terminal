import { RadarResponseSchema, PairRowSchema, projectGuardLevelToV1, type CoinSummary, type FeedItem } from '@eko/shared';
import type { ReadServices } from '../http/v1/reads.js';

/** Explicit V2 compact reads; shadow data never changes the active V1 ranking. */
export class GuardConsumerReads {
  constructor(readonly services: ReadServices) {}
  private async row<T extends CoinSummary>(row: T): Promise<T> {
    const guardV2 = await this.services.guard.verdict(row.address);
    // Only a released assessment may replace the active transport grade.
    return { ...row, guardV2, ...(guardV2?.mode === 'active' ? { verdict: projectGuardLevelToV1(guardV2.level), verdictPending: false } : {}) };
  }
  async radar(cursor?: string,blueChipOnly=false) {
    const page = await this.services.radar.list(cursor,blueChipOnly);
    const rows = await Promise.all(page.rows.map(row => this.row(row)));
    const result=RadarResponseSchema.parse({ ...page, rows, guardTotals: await this.services.guard.totals() });
    // Validation clones nested objects. Retain the already validated static projection for fragment serialization.
    result.rows.forEach((row,i)=>{
      const source=page.rows[i]!;
      row.name=source.name;row.symbol=source.symbol;row.missingChecks=source.missingChecks;
      row.evaluatedPlaybooks=source.evaluatedPlaybooks;row.signal=source.signal;row.beta=source.beta;
    });
    return result;
  }
  async pairs(stage: 'new' | 'near_grad' | 'migrated', cursor?: string,blueChipOnly=false) {
    const page = await this.services.pairs.list(stage, cursor,blueChipOnly);
    const rows = await Promise.all(page.rows.map(row => this.row(row)));
    return { ...page, rows: rows.map(row => PairRowSchema.parse(row)) };
  }
  async feed(kinds?: FeedItem['kind'][], cursor?: string) {
    const page = await this.services.feed.list(kinds, cursor);
    // Feed events retain only their recorded typed fields. A later assessment,
    // even in the same block, is not the original event's availability cut.
    return page;
  }
}
