import { describe, expect, it } from 'vitest';
import { coinElsewhere } from './coinLinks';

const coin = '0x5D992fa5B7Da8EFde5FD36d24e81097Ed6aD4351';

describe('open a coin elsewhere', () => {
  it('sends a graduated Robinhood coin to DexScreener on the robinhood chain id', () => {
    expect(coinElsewhere(coin, 'graduated', 'robinhood')).toEqual({ label: 'DexScreener', href: `https://dexscreener.com/robinhood/${coin}` });
  });
  it('sends a Robinhood curve coin, or one whose stage is not checked, to the explorer token page', () => {
    for (const stage of ['curve', 'unknown', undefined]) {
      expect(coinElsewhere(coin, stage, 'robinhood')).toEqual({ label: 'Explorer', href: `https://robinhoodchain.blockscout.com/token/${coin}` });
    }
  });
  it('uses the build network explorer on Elysium, graduated or not', () => {
    for (const stage of ['graduated', 'curve']) {
      expect(coinElsewhere(coin, stage, 'elysium')).toEqual({ label: 'Explorer', href: `https://elysium.kinetiq.xyz/explorer/token/${coin}` });
    }
  });
  it('makes no link from anything but a well-formed address', () => {
    for (const bad of ['0x123', `${coin}/../x`, 'javascript:alert(1)', `${coin}?q=1`]) expect(coinElsewhere(bad, 'graduated', 'robinhood')).toBeNull();
  });
});
