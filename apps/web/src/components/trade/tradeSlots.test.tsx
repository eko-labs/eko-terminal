import { describe, expect, it } from 'vitest';
import type { TradeSlots } from '../../features';
import { activeTradeSlots } from './tradeSlots';

const Line = () => null, Panel = () => null;
const features = [
  { flag: 'size_check' as const, trade: { amount: Line } satisfies TradeSlots },
  { flag: 'paper_trading' as const, trade: { mode: { label: 'Paper', panel: Panel } } satisfies TradeSlots },
  { flag: 'quant' as const },
];

describe('trade panel places', () => {
  it('fills nothing while no feature with a trade place is on, so the panel is unchanged', () => {
    expect(activeTradeSlots(features, undefined)).toEqual([]);
    expect(activeTradeSlots(features, { quant: true })).toEqual([]);
  });
  it('fills only the places of features whose flag is on', () => {
    expect(activeTradeSlots(features, { size_check: true })).toEqual([{ amount: Line }]);
    expect(activeTradeSlots(features, { size_check: true, paper_trading: true }).map(s => Object.keys(s)[0])).toEqual(['amount', 'mode']);
  });
});
