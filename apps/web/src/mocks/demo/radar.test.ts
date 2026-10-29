import { describe, expect, it } from 'vitest';
import { CoinCardSchema, RadarRowSchema } from '@eko/shared';
import { createRadarRows, createRadarCard } from './radar';
import { createApi } from '../../lib/api';
import { createMockTransport } from '../transport';
import { RadarResponseSchema } from '../../pages/terminal/radarModel';
describe('approved prototype Radar demo', () => {
  it('ports all 30 deterministic unique profiles into valid contracts', () => {
    const rows=createRadarRows(); expect(rows).toHaveLength(30); expect(new Set(rows.map(c=>c.address)).size).toBe(30); expect(createRadarRows()).toEqual(rows);
    for(const row of rows){ expect(RadarRowSchema.parse(row)).toEqual(row); expect(row.signal?.beta).toBe(true); expect(row.marketCapUsd).toBeGreaterThan(0); expect(row.spark8h).toHaveLength(40); expect(row.flow.agentPct).toBeCloseTo(row.flow.declaredAgentPct!+row.flow.likelyAgentPct!); const card=createRadarCard(row.address)!; expect(CoinCardSchema.parse(card)).toEqual(card); expect(card.identity.symbol).toEqual(row.symbol); }
    rows[0].symbol.text='changed'; expect(createRadarRows()[0].symbol.text).toBe('GHOST');
  });
  it('retains the EKOX clone and 79% fee-trap evidence', () => { const row=createRadarRows().find(c=>c.symbol.text==='EKOX')!; const card=createRadarCard(row.address)!; expect(row.verdict).toBe('danger'); expect(card.clone?.isClone).toBe(true); expect(card.liquidity.feeTiers).toContain(79); expect(card.verdict.reasons.join(' ')).toContain('79%'); });
  it('routes snapshots and each requested address to matching details', async () => { const api=createApi('/v1',createMockTransport()); const snapshot=await api.parse('/radar',RadarResponseSchema); expect(snapshot.rows).toEqual(createRadarRows()); for(const row of snapshot.rows) expect((await api.parse(`/coins/${row.address}`,CoinCardSchema)).identity.address).toBe(row.address); await expect(api.request('/coins/0x1111111111111111111111111111111111111111')).rejects.toMatchObject({status:404}); });
});
