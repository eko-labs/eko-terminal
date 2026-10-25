import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlueChipBadge, BlueChipDetails } from './BlueChip';
describe('factual optional Blue chip display',()=>{
  it('adds no markup when fields are absent or the coin is not a member',()=>{
    expect(renderToStaticMarkup(<BlueChipBadge />)).toBe('');expect(renderToStaticMarkup(<BlueChipDetails />)).toBe('');
    expect(renderToStaticMarkup(<BlueChipBadge value={{member:false,via:[]}} />)).toBe('');
  });
  it('credits the listing data and puts exact criteria one disclosure click away',()=>{
    const value={member:true,via:['coingecko','earned'] as ('coingecko'|'earned')[]};
    const badge=renderToStaticMarkup(<BlueChipBadge value={value} />),detail=renderToStaticMarkup(<BlueChipDetails value={value} criteria={{minAgeDays:3,minLiquidityUsd:25000,minHolders:250}} />);
    expect(badge).toContain('Listing data from CoinGecko');expect(detail).toContain('<summary>');expect(detail).toContain('3 days');expect(detail).toContain('$25,000');expect(detail).toContain('250 holders');expect(detail).toContain('Qualifying route:');expect(detail).toContain('no danger verdict ever observed');
  });
});
