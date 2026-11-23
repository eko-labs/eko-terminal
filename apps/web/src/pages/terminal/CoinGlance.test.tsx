import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CoinCard, Verdict } from '@eko/shared';
import { holdersGlance, sellGlance, verdictGlance } from './CoinGlance';
import { Dots, GlanceTile } from '../../components/GlanceTile';

const card = (over: Partial<{ honeypot: boolean; exit: number; flags: string[]; top10: number }> = {}) => ({
  tradeability: { honeypot: over.honeypot ?? false, exitCostPct: { usd100: over.exit ?? 4, usd1k: over.exit ?? 4, usd10k: over.exit ?? 4 }, buyTaxPct: 0, sellTaxPct: 0 },
  supply: { top10Pct: over.top10 ?? 22, devPct: 3.8, bundlesHeldPct: 2.2 },
  meta: { tradeability: { flags: over.flags ?? ['sell_check_sellable'] } },
}) as unknown as CoinCard;
const verdict = (level: Verdict['level'], ids: [string, string][] = []) =>
  ({ level, playbooks: ids.map(([id, l]) => ({ id, level: l })) }) as unknown as Verdict;

describe('the coin page glance row', () => {
  it('says the verdict in a word and its strongest flags, danger first', () => {
    expect(verdictGlance(verdict('danger', [['fee_trap_pool', 'danger'], ['clone_swarm', 'danger'], ['tax_trap', 'monitor']]))).toMatchObject({ value: 'Danger', tone: 'bad' });
    expect(verdictGlance(verdict('monitor', [['tax_trap', 'monitor'], ['launch_snipers', 'info']]))!.line.split(' · ')).toHaveLength(1);
    expect(verdictGlance(verdict('clear'))).toEqual({ value: 'Clear', line: 'No red flags found', tone: 'good' });
  });
  it('answers "can you sell?" plainly: yes, costly, no or not checked', () => {
    expect(sellGlance(card())).toEqual({ value: 'Yes', line: 'A $1K round trip costs 4%', tone: 'good', gauge: 4 });
    expect(sellGlance(card({ exit: 62.5 }))).toEqual({ value: 'Costly', line: 'A $1K round trip loses 62.5%', tone: 'bad', gauge: 62.5 });
    expect(sellGlance(card({ flags: ['sell_check_refused'] }))).toMatchObject({ value: 'No', tone: 'bad' });
    expect(sellGlance(card({ flags: ['sell_check_not_available'] }))).toMatchObject({ value: 'Not checked', tone: 'neutral' });
  });
  it('shows the top ten\'s share with the dev and bundles beside it', () => {
    expect(holdersGlance(card({ top10: 77 }))).toEqual({ value: '77%', line: 'Dev 3.8% · bundles 2.2%', tone: 'bad', gauge: 77 });
  });
  it('says "Partly checked", not Clear, for a coin graded on part of its history (EKO started following it late)', () => {
    const partial = { ...verdict('clear'), historyPartial: { since: '2026-11-21T00:01:53.000Z' } } as Verdict;
    expect(verdictGlance(partial)).toEqual({ value: 'Partly checked', line: 'Holders and early buyers not counted', tone: 'neutral' });
    // A finding still reads as the finding.
    expect(verdictGlance({ ...verdict('danger', [['fake_mcap', 'danger']]), historyPartial: { since: '2026-11-21T00:01:53.000Z' } } as Verdict)).toMatchObject({ value: 'Danger' });
    const late = { ...card(), meta: { supply: { confidence: 0, asOfBlock: 1, missing: ['top10Pct', 'devPct', 'bundlesHeldPct', 'freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['history_partial'] } } } as unknown as CoinCard;
    expect(holdersGlance(late)).toEqual({ value: 'Not checked', line: 'EKO started following it after launch', tone: 'neutral' });
  });
  it('draws odds as ten dots, filled for "N in 10"', () => {
    const html = renderToStaticMarkup(<Dots filled={3} tone="watch" />);
    expect(html.match(/class="on"/g)).toHaveLength(3); expect(html).toContain('aria-label="3 in 10"');
    expect(renderToStaticMarkup(<GlanceTile label="The Odds" value="3 in 10" dots={3} line="lasted a day" tone="watch" />)).toContain('glance-watch');
  });
});
