import { expect, it } from 'vitest';
import { ratingPriceMove, ratingPriceFact } from '../src/rating-price.js';

it('triggers at a halving or the first 20%-of-peak observation, never for an acknowledged small fall',()=>{
  expect(ratingPriceMove(50,100,100)).toMatchObject({force:true,fact:{downSinceRatedPct:50}});
  expect(ratingPriceMove(50.01,100,100).force).toBe(false);
  expect(ratingPriceMove(15,20,100)).toMatchObject({force:true,fact:{downFromPeakPct:85}});
  expect(ratingPriceFact(ratingPriceMove(15,20,100).fact)).toBe('Down 85% from peak');
  expect(ratingPriceMove(14,15,100,true).force).toBe(false);
  expect(ratingPriceMove(7.5,15,100,true).force).toBe(true);
  expect(ratingPriceMove(null,100,100).force).toBe(false);
});
