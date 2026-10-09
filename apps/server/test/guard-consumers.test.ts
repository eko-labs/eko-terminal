import { describe, expect, it, vi } from 'vitest';
import { GuardAssessmentV2Schema, RadarRowSchema } from '@eko/shared';
import { GuardConsumerReads } from '../src/read/guard-consumers.js';
import { guardReadRoutes } from '../src/http/v2-guard.js';
import { assessment } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import v1 from '../../../packages/shared/test/fixtures/contracts/v1.json';
import Fastify from 'fastify';
import type { ReadServices } from '../src/http/v1/reads.js';

const guard = GuardAssessmentV2Schema.parse(assessment);
const row = RadarRowSchema.parse({...v1.RadarRow,address:guard.coin});
function fixture() {
  const legacyPage = {rows:[row],cursor:null,delayedSec:0,totals:v1.RadarTotals};
  const services = {
    guard:{verdict:vi.fn().mockResolvedValue(guard),totals:vi.fn().mockResolvedValue({status:'unavailable',activeVersion:'verdict-1',failureCode:'missing'})},
    radar:{list:vi.fn().mockResolvedValue(legacyPage)},
    pairs:{list:vi.fn().mockResolvedValue({rows:[{...v1.PairRow,address:guard.coin}],cursor:null,delayedSec:0})},
    feed:{list:vi.fn().mockResolvedValue({rows:[v1.FeedItem],cursor:null,delayedSec:0})},
  } as unknown as ReadServices;
  return {services,consumer:new GuardConsumerReads(services),legacyPage};
}
describe('037 negotiated compact reads (no RPC or publication)', () => {
  it('adds V2 coverage while preserving the active V1 server rank, metrics and omissions',async()=>{
    const {services,consumer,legacyPage}=fixture();
    const page=await consumer.radar();
    expect(page.rows[0]).toMatchObject({...row,guardV2:guard});
    expect(page.guardTotals).toEqual({status:'unavailable',activeVersion:'verdict-1',failureCode:'missing'});
    expect(page.rows[0].rank).toBe(row.rank);expect(page.totals).toEqual(legacyPage.totals);
    expect(legacyPage.rows[0]).not.toHaveProperty('guardV2');
    const pairs=await consumer.pairs('new');expect(pairs.rows[0]).toMatchObject({guardV2:guard});
    vi.mocked(services.guard.verdict).mockResolvedValue(null);
    const missing=await consumer.radar();expect(missing.rows[0].guardV2).toBeNull();
    expect(missing.rows[0].verdictPending).toBe(row.verdictPending);
  });
  it('does not enrich historical Feed events with later same-block or current V2 snapshots',async()=>{
    const {services,consumer}=fixture();
    expect((await consumer.feed()).rows).toEqual([v1.FeedItem]);
    expect(services.guard.verdict).not.toHaveBeenCalled();
  });
  it('exposes explicit V2 routes without modifying V1 or acquiring data',async()=>{
    const {services}=fixture(),app=Fastify();
    await guardReadRoutes(app,services.guard,services);
    try {
      const res=await app.inject('/v2/radar');expect(res.statusCode).toBe(200);expect(res.json().rows[0].guardV2).toEqual(guard);
      expect((await app.inject('/v2/pairs?stage=new')).statusCode).toBe(200);
      expect((await app.inject('/v2/feed?kinds=verdict')).statusCode).toBe(200);
      expect((await app.inject('/v2/feed?kinds=invalid')).statusCode).toBe(422);
      expect((await app.inject('/v1/radar')).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
