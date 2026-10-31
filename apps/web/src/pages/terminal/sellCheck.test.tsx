import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { createPairRows } from '../../mocks/demo/pairs';
import { exitMeasured, sellCheckOf } from '../../lib/sellCheck';
import { CoinOverview, CoinVerdict } from './CoinCard';
import { RadarRowView } from './RadarParts';
import { PairView } from './Pairs';
vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));

// Demo fixtures with a sell-check overlay as the API projects it; no live readings.
function checkedCard(flag: 'sell_check_sellable' | 'sell_check_refused', missing: string[] = []) {
  const card = createRadarCard(createRadarRows()[0]!.address)!;
  card.tradeability = { ...card.tradeability, exitCostPct: { usd100: 6.5, usd1k: 8.25, usd10k: 0 }, honeypot: false, buyTaxPct: 0, sellTaxPct: 0 };
  card.meta = { tradeability: { confidence: 0.5, asOfBlock: 1, unavailable: false, flags: [flag], missing: ['exitCostPct.usd10k', 'buyTax', 'sellTax', 'taxes', 'antiSnipeTiming', ...missing] },
    liquidity: { confidence: 0, asOfBlock: 1, unavailable: true }, flow: { confidence: 0, asOfBlock: 1, unavailable: true }, control: { confidence: 0, asOfBlock: 1, unavailable: true } };
  return card;
}
describe('live sell check readings on the web', () => {
  it('shows measured exit sizes, the sell check and names every size and field it did not measure', () => {
    const card = checkedCard('sell_check_sellable');
    expect([exitMeasured(card, 'usd100'), exitMeasured(card, 'usd1k'), exitMeasured(card, 'usd10k')]).toEqual([true, true, false]);
    expect(sellCheckOf(card)).toBe('sellable');
    const html = render(<CoinOverview card={card} verdict={card.verdict} flows={[card.flow]} evidenceOpen={false} />);
    expect(html).toContain('6.5% / 8.3% / not checked yet');
    expect(html).toContain('Sold back in a buy-then-sell simulation');
    // A contract-probe reading is not a confirmed honeypot answer, and taxes, anti-snipe and depth stay unmeasured.
    expect(html).not.toContain('<dt>Honeypot</dt>');
    expect(html).not.toContain('0% buy');
    expect(html).not.toContain('Fixed tax of 5% or less');
    expect(html).not.toContain('None active');
    expect(html).not.toContain('$0');
  });
  it('explains a pending sell check on the coin page using the existing verdict contract', () => {
    const card = checkedCard('sell_check_sellable');
    card.verdict = { ...card.verdict, level: 'pending', evaluatedPlaybooks: ['tax_trap'], reasons: [] };
    const html = render(<CoinVerdict verdict={card.verdict} />);
    expect(html).toContain('Waiting on a sell check: the buy-then-sell simulation has not completed.');
    expect(render(<CoinVerdict verdict={{ ...card.verdict, evaluatedPlaybooks: ['honeypot'] }} />)).not.toContain('Waiting on a sell check');
    const reason = 'Waiting on a sell check: the buy-then-sell simulation has not completed.';
    expect(render(<CoinVerdict verdict={{ ...card.verdict, reasons: [reason] }} />).split(reason)).toHaveLength(2);
  });
  it('marks a failed sell on the coin card, the Radar row and the Pairs row', () => {
    const card = checkedCard('sell_check_refused', ['exitCostPct.usd1k']);
    const html = render(<CoinOverview card={card} verdict={card.verdict} flows={[card.flow]} evidenceOpen={false} />);
    expect(html).toContain('Sell failed in simulation · buys refused');
    expect(html).toContain('6.5% / not checked yet / not checked yet');
    const base = createRadarRows()[0]!;
    const row = { ...base, exitCost1kPct: 0, unavailable: ['exitCost' as const], sellCheck: { status: 'refused' as const, asOfBlock: 1, checkedAt: new Date(0).toISOString() } };
    const rowHtml = render(<table><tbody><RadarRowView c={row} selected={false} select={() => {}} trade={() => {}} pulse={0} /></tbody></table>);
    expect(rowHtml).toContain('>Sell fails</td>');
    expect(rowHtml).toContain('c-exit r num bad');
    const pair = { ...createPairRows()[0]!, unavailable: ['exitCost' as const], sellCheck: row.sellCheck };
    expect(render(<ul><PairView row={pair} now={1} at={1} select={() => {}} trade={() => {}} stale={false} /></ul>)).toContain('Sell fails');
    // A measured sellable row shows its number, never the placeholder.
    const measured = render(<table><tbody><RadarRowView c={{ ...base, exitCost1kPct: 8.25, unavailable: [], sellCheck: { ...row.sellCheck, status: 'sellable' } }} selected={false} select={() => {}} trade={() => {}} pulse={0} /></tbody></table>);
    expect(measured).toContain('8.3%');
    expect(measured).not.toContain('Sell fails');
  });
});
