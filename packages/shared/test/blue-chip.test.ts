import { describe, expect, it } from 'vitest';
import { BlueChipSchema, CoinCardSchema, PolicySchema, PublicConfigSchema } from '../src/index.js';
import fixture from './fixtures/contracts/v1.json';
describe('additive Blue chip contracts',()=>{
  it('supports either qualification route and both together',()=>{
    for(const via of [['coingecko'],['earned'],['coingecko','earned']])expect(BlueChipSchema.parse({member:true,via})).toEqual({member:true,via});
    expect(BlueChipSchema.safeParse({member:true,via:['unknown']}).success).toBe(false);
  });
  it('leaves original card and policy serializations unchanged',()=>{
    const card=CoinCardSchema.parse(fixture.CoinCard);
    expect(JSON.stringify(CoinCardSchema.parse({...card,blueChip:undefined}))).toBe(JSON.stringify(card));
    const policy={mode:'balanced',blockPlaybookLevel:'danger',killed:false,version:1};
    expect(PolicySchema.parse(policy)).toEqual(policy);
    expect(PolicySchema.parse({...policy,blueChipsOnly:true}).blueChipsOnly).toBe(true);
    expect(PublicConfigSchema.shape.blueChip.isOptional()).toBe(true);
  });
});
