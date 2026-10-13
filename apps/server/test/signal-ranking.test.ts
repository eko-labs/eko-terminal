import { expect, it } from 'vitest';
import { CoinSignalSchema, CoinSignalV2Schema, RadarRowSchema } from '@eko/shared';
import v1 from '../../../packages/shared/test/fixtures/contracts/v1.json' with { type: 'json' };
import { guardSamples } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { rankRadar } from '../src/read/radar.js';

it('keeps Radar order when activity Signals and shadow adapter scores change', () => {
  const sample = RadarRowSchema.parse(v1.RadarRow);
  const legacy = CoinSignalSchema.parse(v1.CoinSignal);
  const signal = CoinSignalV2Schema.parse(guardSamples.CoinSignalV2);
  const address = (i:number) => `0x${i.toString(16).padStart(40,'0')}` as const;
  const rows = [1000,500].map((volume,i) => ({eligible:true,card:null,volume,activity:0,firstBlock:0,graduationBlock:0,
    row:{...sample,address:address(i+1),signal:{...legacy,composite:i?100:0},shadowSignal:signal}}));
  const original = rankRadar([...rows]).map(r=>r.address);
  expect(original).toEqual([address(1),address(2)]);
  for(const row of rows) {
    row.row.signal.composite = 100 - row.row.signal.composite;
    row.row.shadowSignal = {...signal,composite:row.row.signal.composite};
  }
  expect(rankRadar([...rows]).map(r=>r.address)).toEqual(original);
});
