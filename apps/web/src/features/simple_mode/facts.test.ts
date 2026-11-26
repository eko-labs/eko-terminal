import { describe, expect, it } from 'vitest';
import { RadarRowSchema, type CoinCard, type Flow, type GuardAssessmentV2, type RadarRow, type Verdict } from '@eko/shared';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { LOCKED_IN, NOTHING_WRONG, NO_POWERS, PLAYBOOK_PLAIN, REASON_PLAIN, SOLD_OK, STILL_CHECKING, WARNING_SIGNS, dollars, factsOf, reasonsOf, whoIsBuying } from './model';
import demo, { activityFor, withTrading } from './demo';

const JARGON = /\b(fdv|liquidity|impact|curve|slippage|mcap|market cap|playbook|guard|honeypot|bonding|deployer|rug|lp|pool|volume|exit)\b/i;
const verdict = (level: Verdict['level'], playbooks: { id: string; level: string }[] = [], extra: Partial<Verdict> = {}) =>
  ({ level, playbooks: playbooks.map(p => ({ ...p, confidence: 0.9, evidence: [] })), ...extra }) as unknown as Verdict;
const card = (o: { sellable?: boolean; refused?: boolean; e100?: number; top10?: number; powers?: boolean; lp?: string; stage?: string; curvePct?: number; supplyFlags?: string[]; missing?: string[] } = {}) => ({
  identity: { stage: o.stage ?? 'graduated', curvePct: o.curvePct },
  tradeability: { honeypot: false, exitCostPct: { usd100: o.e100 ?? 3.6, usd1k: 4, usd10k: 9 }, buyTaxPct: 0, sellTaxPct: 0 },
  control: { canMint: !!o.powers, canPause: false, canBlacklist: false, canChangeTax: false, upgradeable: false },
  liquidity: { lpStatus: o.lp ?? 'burned', depthUsd: { pct2: 1, pct5: 1, pct10: 1 }, feeTiers: [] },
  supply: { top10Pct: o.top10 ?? 34, devPct: 1, bundlesHeldPct: 0, exemptWalletsHeldPct: 0 },
  meta: { tradeability: { confidence: 1, asOfBlock: 1, flags: o.refused ? ['sell_check_refused'] : o.sellable === false ? [] : ['sell_check_sellable'], missing: o.missing ?? [] },
    supply: { confidence: 1, asOfBlock: 1, flags: o.supplyFlags ?? [] } },
}) as unknown as CoinCard;
const row = (o: Partial<RadarRow> = {}) => ({ address: '0xabababababababababababababababababababab', liquidityUsd: 218_000, marketCapUsd: 1_840_000, change1hPct: 6.2, change24hPct: 37.4, volume1hUsd: 4_200, trades1h: 18, ...o }) as RadarRow;

describe('the answer’s reasons', () => {
  it('gives up to three, dangers before cautions, never the same twice', () => {
    const v = verdict('danger', [{ id: 'run_up', level: 'monitor' }, { id: 'dev_dump', level: 'danger' }, { id: 'holder_concentration', level: 'danger' }, { id: 'launch_snipers', level: 'monitor' }]);
    expect(reasonsOf(v, null, card())).toEqual([
      { tone: 'bad', text: PLAYBOOK_PLAIN.dev_dump }, { tone: 'bad', text: PLAYBOOK_PLAIN.holder_concentration }, { tone: 'watch', text: PLAYBOOK_PLAIN.run_up }]);
  });
  it('puts a failed test sale first', () => {
    expect(reasonsOf(verdict('danger', [{ id: 'dev_dump', level: 'danger' }]), null, card({ refused: true }))[0]).toEqual({ tone: 'bad', text: REASON_PLAIN.SELL_RESTRICTION });
  });
  it('names what EKO measured as good for a coin that looks OK', () => {
    expect(reasonsOf(verdict('clear'), null, card()).map(r => r.text)).toEqual([NOTHING_WRONG, SOLD_OK, NO_POWERS]);
    expect(reasonsOf(verdict('clear'), null, card({ powers: true, lp: 'removable' })).map(r => r.text)).toEqual([NOTHING_WRONG, SOLD_OK]);
    expect(reasonsOf(verdict('clear'), null, card({ sellable: false, powers: true, lp: 'locked' })).map(r => r.text)).toEqual([NOTHING_WRONG, LOCKED_IN]);
    expect(reasonsOf(verdict('clear'), null, card()).every(r => r.tone === 'good')).toBe(true);
  });
  it('says only that it is checking while it checks, and gives a caution with no named finding', () => {
    expect(reasonsOf(verdict('pending'), null, card())).toEqual([{ tone: 'neutral', text: STILL_CHECKING }]);
    expect(reasonsOf(verdict('monitor', [{ id: 'tax_trap', level: 'info' }]), null, card())).toEqual([{ tone: 'watch', text: WARNING_SIGNS }]);
  });
  it('reads an active guard’s reasons in plain words', () => {
    const guard = { mode: 'active', level: 'high', reasons: [{ code: 'TOP_HOLDERS' }, { code: 'SELL_PRESSURE' }] } as unknown as GuardAssessmentV2;
    expect(reasonsOf(verdict('clear'), guard, card()).map(r => r.text)).toEqual([REASON_PLAIN.TOP_HOLDERS, REASON_PLAIN.SELL_PRESSURE]);
  });
});

describe('the plain facts', () => {
  it('shows each fact in plain words, with a gauge where Full has one', () => {
    const facts = factsOf(card(), row());
    expect(facts.map(f => [f.label, f.value])).toEqual([
      ['Can you sell it?', 'Yes'], ['$100 gets back', '$96'], ['Today', 'Up 37%'], ['Money behind it', '$218K'], ['Top 10 own', '34%'], ['Trading last hour', '$4K']]);
    expect(facts.find(f => f.id === 'back')?.gauge).toBe(96);
    expect(facts.find(f => f.id === 'top')).toMatchObject({ tone: 'watch', gauge: 34 });
    expect(facts.find(f => f.id === 'trading')?.line).toBe('18 trades');
    for (const f of facts) expect(`${f.label} ${f.line}`, f.label).not.toMatch(JARGON);
  });
  it('says plainly when a few people own a lot, and how much money is behind the price', () => {
    expect(factsOf(card({ top10: 68 }), row()).find(f => f.id === 'top')).toMatchObject({ tone: 'bad', line: 'A few people own a lot' });
    expect(factsOf(card(), row({ liquidityUsd: 2_000, marketCapUsd: 1_000_000 })).find(f => f.id === 'money')).toMatchObject({ tone: 'bad', line: 'Very little for its price' });
    expect(factsOf(card({ stage: 'curve', curvePct: 40 }), row()).find(f => f.id === 'money')).toMatchObject({ gauge: 40, line: 'Still in its first sale' });
  });
  it('leaves a fact out when its data is missing, and never says "not checked"', () => {
    const facts = factsOf(card({ sellable: false, missing: ['exitCostPct'], supplyFlags: ['history_partial'] }), row({ unavailable: ['change', 'liquidity', 'volume'] }));
    expect(facts).toEqual([]);
    expect(factsOf(null, null)).toEqual([]);
    expect(JSON.stringify(factsOf(card(), row()))).not.toMatch(/not checked/i);
  });
  it('writes dollars short', () => {
    expect([dollars(950), dollars(4_200), dollars(218_400), dollars(2_710_000)]).toEqual(['$950', '$4K', '$218K', '$2.7M']);
  });
});

describe('who is buying', () => {
  const flow = (buyers: number, sellers: number) => [{ window: '1h', activity: { buyers, sellers } }] as unknown as Flow[];
  it('compares last hour’s buyers and sellers in a sentence', () => {
    expect(whoIsBuying(flow(24, 11))).toMatchObject({ text: 'More people are buying than selling', buyers: 24, sellers: 11 });
    expect(whoIsBuying(flow(6, 13))?.text).toBe('More people are selling than buying');
    expect(whoIsBuying(flow(10, 11))?.text).toBe('About as many people are buying as selling');
    expect(whoIsBuying(flow(3, 1))?.share).toBe(75);
  });
  it('shows nothing when nobody traded or the flow is not in yet', () => {
    expect(whoIsBuying(flow(0, 0))).toBeNull();
    expect(whoIsBuying([])).toBeNull();
  });
});

describe('mock mode trading counts', () => {
  it('fills every mock coin’s counts the same way each load, as valid radar rows', () => {
    const rows = createRadarRows().map(withTrading);
    expect(rows.map(withTrading)).toEqual(rows);
    for (const r of rows) {
      expect(RadarRowSchema.safeParse(r).success, r.symbol.text).toBe(true);
      expect(r.volume1hUsd! >= 0 && r.trades1h! >= 0, r.symbol.text).toBe(true);
    }
  });
  it('gives a rising coin more buyers than sellers, and answers the flow and radar routes', () => {
    const up = activityFor({ address: '0x01', liquidityUsd: 100_000, change1hPct: 30, change24hPct: 50 }, '1h');
    const down = activityFor({ address: '0x01', liquidityUsd: 100_000, change1hPct: -30, change24hPct: -50 }, '1h');
    expect(up.buyers).toBeGreaterThan(up.sellers);
    expect(down.sellers).toBeGreaterThan(down.buyers);
    const first = createRadarRows()[0]!;
    expect(createRadarCard(first.address)).toBeDefined();
    const answer = demo.fetch!({ method: 'GET', route: `/coins/${first.address}/flow`, query: new URLSearchParams('window=1h'), body: undefined });
    expect((answer?.body as Flow).activity?.buyers).toBeGreaterThanOrEqual(0);
    expect(demo.fetch!({ method: 'GET', route: '/radar', query: new URLSearchParams(), body: undefined })).toBeDefined();
    expect(demo.fetch!({ method: 'POST', route: '/radar', query: new URLSearchParams(), body: undefined })).toBeUndefined();
  });
});
