import { GUARD_POLICY_OPTIONS } from '../../copy/guard';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoinCardV2Schema, GuardAssessmentV2Schema, GUARD_CHECK_IDS, GUARD_CHECK_TIERS, type GuardAssessmentV2, type CheckId, type GuardLevelV2 } from '@eko/shared';
import { assessment, card as rawCard, coverage, missingCoverage, raw, observed, guardSamples } from '../../../../../packages/shared/test/fixtures/contracts/guard-v2';
import { GuardAssessment, GuardCard, GuardPolicyControls } from './GuardCard';
import { VerdictChip } from '../../components/ui';
import { BUYER_RISK, GUARD_LABELS, GUARD_CHECK_LABELS, guardBuyText, formatGuardReason } from '../../copy/guard';
import { DYOR, BUILT_ON, NON_AFFILIATION } from '../../copy';
import { retainPersisted, retainGuardCard } from './useGuardCoin';
import { useUi } from '../../store/ui';
import { CoinVerdict } from './CoinCard';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import Coin from './Coin';
import * as legacyData from './useCoin';
import * as guardData from './useGuardCoin';
import { guardDetailModel } from './guardDetailModel';

vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));
afterEach(() => { vi.restoreAllMocks(); useUi.setState({ riskMode: 'balanced' }); });
// All assessments below are synthetic: no calibration, chain or live-policy evidence.
function fixture(level: GuardLevelV2, gaps: CheckId[] = [], mode: GuardAssessmentV2['mode'] = 'active') {
  const critical = !gaps.some(id => GUARD_CHECK_TIERS[id] === 'buy_critical');
  const lower = !gaps.some(id => GUARD_CHECK_TIERS[id] === 'lower_tier');
  const score = level === 'high' ? 60 : level === 'elevated' && !gaps.length ? 30 : 0;
  const observedLevel = score >= 60 ? 'high' : score >= 30 ? 'elevated' : 'lower';
  return GuardAssessmentV2Schema.parse({ ...assessment, mode, level, observedLevel, score, baseScore: score,
    historyPoints: 0, familyPoints: { E: score, O: 0, Ff: 0, C: 0, I: 0 },
    factors: [{ ...assessment.factors[0], eligiblePoints: Math.max(10, score), assignedPoints: score, calibration: 'released' }],
    levelFloorReason: critical && !lower && observedLevel === 'lower' ? 'lower_tier_gap' : null,
    completeness: { buyCriticalComplete: critical, lowerTierComplete: lower, missing: gaps },
    checks: GUARD_CHECK_IDS.map(id => ({ id, tier: GUARD_CHECK_TIERS[id], status: gaps.includes(id) ? 'missing' : 'complete', coverage: gaps.includes(id) ? missingCoverage : coverage, evidenceIds: [], failureCode: gaps.includes(id) ? 'missing' : null })),
  });
}
const views = {
  lower: fixture('lower'), elevated: fixture('elevated', ['recent_funding']), high: fixture('high', ['reference_exit']),
  incomplete: fixture('incomplete', ['reference_exit']), shadow: fixture('elevated', ['recent_funding'], 'shadow'), candidate: fixture('lower', [], 'candidate'),
};
const newCard = () => CoinCardV2Schema.parse({ ...rawCard, verdict: { ...assessment, factors: [], reasons: [], baseScore: 0, score: 0, familyPoints: { E: 0, O: 0, Ff: 0, C: 0, I: 0 } } });
describe('packet 036 Guard card fixtures', () => {
  it('keeps a fully checked clear rating closed and shows genuine fine results first', () => {
    const clear = GuardAssessmentV2Schema.parse({ ...views.lower, reasons: [], factors: [{ ...views.lower.factors[0], state: 'not_matched', eligiblePoints: 0 }] });
    const html = render(<GuardAssessment guard={clear} />);
    expect(html).toContain('Fine'); expect(html).toContain('Buy-then-sell cost: no flag found.');
    expect(html).not.toContain('data-result="flagged"'); expect(html).not.toContain('class="panel guard-section guard-not-run"');
    expect(html.match(/<details\b[^>]*\bopen(?:=|\s|>)/g) ?? []).toHaveLength(0);
    expect(html).toContain('1 fine · 0 flagged · 0 not checked');
  });
  it('puts danger findings before fine results and opens only the flagged question', () => {
    const guard = GuardAssessmentV2Schema.parse({ ...views.high, decisiveIds: ['sell_block'],
      factors: [...views.high.factors, { ...views.high.factors[0], id: 'thin_depth', state: 'not_matched', eligiblePoints: 0, assignedPoints: 0 }] });
    const html = render(<GuardAssessment guard={guard} />);
    const findings = html.slice(html.indexOf('<ul class="guard-findings"'), html.indexOf('</section>'));
    expect(findings.indexOf('sell block.')).toBeLessThan(findings.indexOf('A $100 buy-then-sell'));
    expect(findings.indexOf('A $100 buy-then-sell')).toBeLessThan(findings.indexOf('Fine'));
    expect(html.match(/guard-question" open=""/g)).toHaveLength(1);
    expect(html).toContain('0 fine · 2 flagged · 1 not checked');
  });
  it('shows a brand-new coin as one counted line without empty buyer sections', () => {
    const card = newCard(), model = guardDetailModel(card), html = render(<GuardCard card={card} />);
    expect(html).toContain('No findings recorded yet.');
    expect(html.slice(0, html.indexOf('</section>'))).not.toContain('Not fully checked:');
    const checks = model.pending.filter(r => /^(factor|check)\./.test(r.id)).length;
    expect(html).toContain(`${checks} checks not run yet · ${model.pending.length - checks} measurements missing`);
    expect(html.match(/class="panel guard-section guard-not-run"/g)).toHaveLength(1);
    expect(html).not.toContain('guard-question'); expect(html).not.toContain('data-result="fine"');
    for (const reason of ['Results not available yet', 'Trade simulation results not available yet', 'Wallet and history results not available yet']) expect(html).toContain(reason);
    expect(html.match(/<details\b[^>]*\bopen(?:=|\s|>)/g) ?? []).toHaveLength(0);
  });
  it('distinguishes non-applicability from pending work and does not count it as fine', () => {
    const card = newCard(); card.control.currentController = { ...card.control.currentController, status: 'not_applicable', value: null, failureCode: null };
    const html = render(<GuardCard card={card} />);
    expect(html).toContain('1 does not apply'); expect(html).toContain('data-reason="not_applicable"');
    expect(html).toContain('Does not apply to this kind of coin'); expect(html).not.toContain('data-result="fine"');
  });
  it('keeps a no-rating coin factual with no findings or empty question sections', () => {
    const html = render(<GuardCard card={{ ...newCard(), verdict: null }} />);
    expect(html).toContain('has not been released'); expect(html).not.toContain('No findings recorded yet.'); expect(html).not.toContain('not run yet'); expect(html).not.toContain('measurements missing');
    expect(html).not.toContain('guard-question'); expect(html).not.toContain('data-result="fine"');
    expect(html).toContain('Technical record');
  });
  it.each(Object.entries(views))('opens flagged questions and keeps the technical record closed for %s', (_name, guard) => {
    const html = render(<GuardCard card={CoinCardV2Schema.parse({ ...rawCard, verdict: guard })} />);
    expect(html.match(/<details\b[^>]*\bopen(?:=|\s|>)/g) ?? []).toHaveLength(1);
    expect(html).toContain('class="panel guard-section guard-question" open=""');
    expect(html).toContain('<details class="panel guard-section guard-technical"><summary class="panel-head">Technical record</summary>');
    expect(html).toContain('class="panel guard-section"');
    expect(html).toContain(guardBuyText(guard, 'balanced')); expect(html).toContain('Sells use a separate'); expect(html).toContain('Receipt');
  });
  it('keeps every flagged finding in the first list with evidence one disclosure away', () => {
    const guard = { ...views.high, reasons: [100, 1000, 10000, 100].map(sizeUsd => ({ ...views.high.reasons[0], parameters: { ...views.high.reasons[0].parameters, sizeUsd } })) } as GuardAssessmentV2;
    const html = render(<GuardAssessment guard={GuardAssessmentV2Schema.parse(guard)} />);
    const top = html.slice(html.indexOf('<ul class="guard-findings"'), html.indexOf('</section>'));
    expect(top.match(/data-result="flagged"/g)).toHaveLength(4);
    expect(top).toContain('Evidence and details'); expect(top).toContain('/v2/coins/');
    expect(html.match(/<details\b[^>]*\bopen(?:=|\s|>)/g) ?? []).toHaveLength(1);
  });
  it('shows plain check summaries and puts technical coverage inside their details', () => {
    const html = render(<GuardAssessment guard={views.high} evidenceOpen />);
    expect(html.match(/<details\b[^>]*\bopen(?:=|\s|>)/g)).toHaveLength(2);
    for (const id of GUARD_CHECK_IDS) {
      const status = id === 'reference_exit' ? 'Missing' : 'Complete';
      expect(html).toContain(`<summary>${GUARD_CHECK_LABELS[id]} · ${status}</summary><span class="guard-coverage">Coverage`);
    }
  });
  it('shows readable UTC time, live age and currency in rendered reasons', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1001000);
    const html = render(<GuardAssessment guard={views.high} />);
    expect(html).toContain('1970-01-01 00:16:40 UTC · 1s ago');
    expect(html).not.toContain('1000 s UTC');
    expect(html).toContain('A $100 buy-then-sell returned $95.00');
  });
  it.each([
    ['EXIT_COST', { sizeUsd: 1000, returnedUsd: '950', snapshotId: 'fixture-snapshot', costPct: '5', gasUsd: '0.1', breakdownStatus: 'complete' }, ['$1,000', '$950.00', '$0.10']],
    ['DEPTH', { buyDepthUsd: '1000', sellDepthUsd: '999.5', routeId: 'fixture-route' }, ['$1,000.00/$999.50']],
    ['ENTRY_LIMIT', { sizeUsd: '12.5', accountClass: 'eoa', limitCode: 'max_tx' }, ['$12.50']],
    ['SELL_RESTRICTION', { sizeUsd: '1000', accountClass: 'eoa' }, ['$1,000']],
    ['SAME_BLOCK', { recipientCount: 2, buyUsd: '250', boughtPct: '1', controlStatus: 'candidate' }, ['$250.00']],
    ['CYCLING', { sharePct: '5', volumeUsd: '1234.5', classificationStatus: 'candidate' }, ['$1,234.50']],
  ])('formats every monetary parameter in %s reasons', (code, parameters, amounts) => {
    const text = formatGuardReason({ code, parameters, factorId: null, evidenceIds: [] } as Parameters<typeof formatGuardReason>[0]);
    for (const amount of amounts as string[]) expect(text).toContain(amount);
  });
  it.each(Object.entries(views))('renders the canonical %s snapshot, gap, reasons and disclaimers', (_name, guard) => {
    const html = render(<GuardAssessment guard={guard} evidenceOpen />);
    expect(html).toContain(GUARD_LABELS[guard.level]); expect(html).toContain(BUYER_RISK); expect(html).toContain(DYOR);
    expect(html).toContain('Snapshot block 123'); expect(html).toContain('$100 / $1,000'); expect(html).toContain('EOA / smart account');
    expect(html).toContain('All reasons, checks and evidence');
    expect(html).toContain('Fee breakdown: unavailable'); expect(html).toContain('/v2/coins/');
  });
  it('never exposes a green observed-Lower label below the lower-tier gap overlay', () => {
    const html = render(<VerdictChip level="clear" verdictPending guard={views.elevated} size="lg" />);
    expect(html).toContain('Elevated risk'); expect(html).toContain('class="guard-gap"'); expect(html).toContain('Not fully checked: Recent funding');
    expect(html).not.toContain('Lower observed risk'); expect(html).not.toContain('verdict clear'); expect(html).not.toContain('Scanning'); expect(html).toContain('aria-busy="false"');
  });
  it('retains High with equally visible gaps and renders candidate colours neutrally', () => {
    const high = render(<VerdictChip level="pending" guard={views.high} />);
    expect(high).toContain('verdict danger'); expect(high).toContain('High risk'); expect(high).toContain('Not fully checked: Can a buyer sell? (exit simulation)');
    for (const guard of [views.shadow, views.candidate]) {
      const html = render(<VerdictChip level="clear" guard={guard} />);
      expect(html.toLowerCase()).toContain('shadow assessment'); expect(html).toContain('does not affect orders'); expect(html).not.toContain('verdict clear');
    }
  });
  it.each(['safe', 'balanced', 'degen'] as const)('shows mandatory gates and actual-order checks for %s', mode => {
    useUi.setState({ riskMode: mode });
    const html = render(<GuardPolicyControls guard={views.elevated} mode={mode} onChange={() => {}} />);
    expect(html).toContain(`aria-pressed="true">${GUARD_POLICY_OPTIONS.find(option => option.value === mode)!.label}`);
    expect(html).toContain(mode === 'safe' ? 'Careful mode denies Elevated risk' : 'Continue through policy limits');
    expect(guardBuyText(views.high, mode)).toContain('refused'); expect(guardBuyText(views.incomplete, mode)).toContain('refused');
    expect(guardBuyText(views.shadow, mode)).toContain('no active'); expect(guardBuyText(null, mode)).toContain('no active');
  });
  it('separates entry limits, sell restrictions, venue/all-in costs and unknown account rows', () => {
    const card = CoinCardV2Schema.parse(rawCard);
    card.tradeability.quotes[0].entry = { ...card.tradeability.quotes[0].entry, ...observed('entry', 'entry_limited', 'status') } as typeof card.tradeability.quotes[0]['entry'];
    card.tradeability.quotes[0].sellability = { ...card.tradeability.quotes[0].sellability, ...observed('sellability', 'capacity_absent', 'status') } as typeof card.tradeability.quotes[0]['sellability'];
    const html = render(<GuardCard card={CoinCardV2Schema.parse(card)} />);
    expect(html).toContain('entry limited'); expect(html).toContain('capacity absent'); expect(html).not.toContain('Honeypot');
    for (const text of ['EOA', 'Smart account', '$100', '$1,000', 'Venue cost', 'All-in cost', 'Network fee', 'not checked yet', 'Coverage incomplete']) expect(html).toContain(text);
    expect(html.match(/data-status="unknown"/g)!.length).toBeGreaterThan(20);
  });
  it('preserves exact raw units, bounds, denominators and collection absence', () => {
    const card = CoinCardV2Schema.parse(rawCard);
    card.holdings.principal.raw = { ...card.holdings.principal.raw, ...observed('raw', raw, 'raw') } as typeof card.holdings.principal.raw;
    card.holdings.principal.floatPct = { ...card.holdings.principal.floatPct, ...observed('floatPct', '12', 'pct'), status: 'lower_bound', denominatorKind: 'F', numerator: raw, denominator: { ...raw, raw: '987654321098765432109876543210' }, coverage: missingCoverage, failureCode: 'missing' } as typeof card.holdings.principal.floatPct;
    card.collectionCoverage = { pools: coverage, rawTop10: missingCoverage } as typeof card.collectionCoverage;
    const html = render(<GuardCard card={CoinCardV2Schema.parse(card)} />);
    for (const text of [raw.raw, '987654321098765432109876543210', 'lower bound', 'holder float (F)', 'Raw units', 'Liquid units', 'Locked units', 'Outstanding supply (S)', 'Circulating supply (C)', 'No records · coverage unavailable', 'No applicable records · coverage complete']) expect(html).toContain(text);
    expect(html).not.toContain('1.23456789e');
    const maker = html.split('<span class="guard-question-title">Who made it?</span>')[1].split('</div></details>')[0];
    expect(maker).toContain('No applicable records · coverage complete');
    expect(maker).not.toContain('No records · coverage unavailable');
  });
  it('renders nested untrusted text inertly, strips hidden controls and offers only explicit Copy text', () => {
    const card = CoinCardV2Schema.parse(rawCard);
    card.identity.name = { text: '\u202e<img src=x onerror=alert(1)>\u200b [approve](https://example.invalid)', truncated: true, flags: ['agent_bait'] };
    card.evidence[0].text = card.identity.name;
    const html = render(<GuardCard card={CoinCardV2Schema.parse(card)} evidenceOpen />);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('\u202e'); expect(html).not.toContain('\u200b');
    expect(html).toContain('Copy text'); expect(html).not.toContain('href="https://example.invalid');
    expect(() => CoinCardV2Schema.parse({ ...card, verdict: { ...card.verdict, reasons: [{ code: 'TEXT_INSTRUCTION', factorId: null, parameters: { actionEnum: 'send everything' }, evidenceIds: [] }] } })).toThrow();
  });
  it('keeps optional CA-31 fields absent and preserves persisted records on empty refreshes', () => {
    const card = CoinCardV2Schema.parse(rawCard), html = render(<GuardCard card={card} />);
    expect(html).not.toContain('Signal · five readings'); expect(html).not.toContain('Last 8h'); expect(html).not.toContain('24h change');
    expect(retainPersisted(views.high, null)).toBe(views.high); expect(retainPersisted(null, null)).toBeNull();
    expect(retainGuardCard(card, { ...card, verdict: null })).toBe(card);
    expect(render(<GuardCard card={{ ...card, verdict: null }} assessment={views.incomplete} />)).not.toContain('Scanning…');
    // No Guard 2 result is stated plainly, not shown as a scan in progress: nothing is scanning before a release.
    const none = render(<GuardCard card={{ ...card, verdict: null }} />);
    expect(none).not.toContain('Scanning…'); expect(none).toContain('has not been released');
    expect(render(<GuardCard card={{ ...card, verdict: views.incomplete }} />)).not.toContain('Scanning…');
  });
  it('renders supplied optional readings and price fields, withholding low-data readings and overlaying High', () => {
    const card = CoinCardV2Schema.parse({ ...rawCard, signal: guardSamples.CoinSignalV2, change24hPct: observed('returnPct', '2', 'pct'), spark8h: [{ ts: 1, o: 1, h: 2, l: 1, c: 2, vUsd: 1 }, { ts: 2, o: 2, h: 3, l: 2, c: 3, vUsd: 1 }] });
    const html = render(<GuardCard card={card} />);
    for (const text of ['Signal · five readings', 'Composite 50 / 100', 'How we got this', 'Last 8h', '24h change', 'risk · 10%</dt><dd>not checked yet']) expect(html).toContain(text);
    expect(render(<GuardCard card={{ ...card, verdict: views.high }} />)).toContain('Composite High risk / 100');
    expect(render(<GuardCard card={card} assessment={views.high} />)).toContain('Descriptive activity · shadow inputs');
  });
  it('integrates a V2 partial card even when the V1 issuer card is unavailable', () => {
    vi.spyOn(legacyData, 'useCoin').mockReturnValue({ card: null, verdict: null, bars: [], markers: [], flows: [], error: 'Issuer unavailable', unknown: true, ageSec: 0, retry: () => {}, candlesUnavailable: false, candlesLoading: false, lastTradeTs: null, labelsUnavailable: true });
    vi.spyOn(guardData, 'useGuardCoin').mockReturnValue({ card: CoinCardV2Schema.parse(rawCard), assessment: views.shadow, failed: true, status: 'ready', retry: () => {} });
    const html = render(<Coin params={{ address: rawCard.identity.address }} />);
    expect(html).toContain('Route, size and account class'); expect(html).toContain('Shadow assessment'); expect(html).toContain('prior snapshot retained');
    expect(html).not.toContain('Coin card unavailable');
    vi.mocked(guardData.useGuardCoin).mockReturnValue({ card: null, assessment: views.incomplete, failed: false, status: 'ready', retry: () => {} });
    const fast = render(<Coin params={{ address: rawCard.identity.address }} />);
    expect(fast).toContain('Buyer risk'); expect(fast).toContain('Not fully checked'); expect(fast).not.toContain('Coin card unavailable');
  });
  it('labels legacy receipts without reinterpreting No flags as V2 Lower', () => {
    const card = createRadarCard(createRadarRows()[0].address)!;
    const html = render(<CoinVerdict verdict={{ ...card.verdict, level: 'clear', guardV2: undefined }} />);
    expect(html).toContain('Graded by rule set 1.0.x'); expect(html).not.toContain('Legacy'); expect(html).toContain('No flags'); expect(html).not.toContain('Lower observed risk'); expect(html).toContain(BUYER_RISK); expect(html).toContain(DYOR);
  });
  it('shows the run-up score beside the first rule set\'s grade on a curve coin, never beside a pending one', () => {
    const card = createRadarCard(createRadarRows()[0].address)!;
    const identity = { ...card.identity, stage: 'curve' as const, curvePct: 40 };
    const html = render(<CoinVerdict identity={identity} verdict={{ ...card.verdict, level: 'danger', guardV2: undefined }} />);
    expect(html).toContain('· 75'); expect(html).toContain('Run-up score 75 of 100. The price is 4× the launch curve');
    expect(render(<CoinVerdict identity={identity} verdict={{ ...card.verdict, level: 'pending', guardV2: undefined }} />)).not.toContain('Run-up score');
    expect(render(<CoinVerdict identity={{ ...identity, stage: 'graduated' as const, curvePct: 100 }} verdict={{ ...card.verdict, level: 'danger', guardV2: undefined }} />)).not.toContain('Run-up score');
  });
  it('formats typed V2 reason amounts in the V1 compatibility view', () => {
    const card = createRadarCard(createRadarRows()[0].address)!;
    const html = render(<CoinVerdict verdict={{ ...card.verdict, guardV2: views.high }} />);
    expect(html).toContain('A $100 buy-then-sell returned $95.00');
  });
  it('keeps the active legacy evidence ahead of shadow metrics with distinct focus targets', () => {
    const card = createRadarCard(createRadarRows()[0].address)!;
    vi.spyOn(legacyData, 'useCoin').mockReturnValue({ card, verdict: card.verdict, bars: [], markers: [], flows: [], error: '', unknown: false, ageSec: 0, retry: () => {}, candlesUnavailable: false, candlesLoading: false, lastTradeTs: null, labelsUnavailable: true });
    vi.spyOn(guardData, 'useGuardCoin').mockReturnValue({ card: CoinCardV2Schema.parse(rawCard), assessment: views.shadow, failed: false, status: 'ready', retry: () => {} });
    const html = render(<Coin params={{ address: card.identity.address }} />);
    expect(html.match(/id="coin-evidence"/g)).toHaveLength(1); expect(html.match(/id="guard-shadow-evidence"/g)).toHaveLength(1);
    expect(html.indexOf('id="coin-evidence"')).toBeLessThan(html.indexOf('id="guard-shadow-evidence"'));
    for (const line of [BUYER_RISK, DYOR, NON_AFFILIATION]) expect(html.split(line)).toHaveLength(2);
  });
  it('can prepare isolated static desktop/mobile visual fixtures without a server', () => {
    const dir = process.env.GUARD_VISUAL_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    vi.spyOn(Date, 'now').mockReturnValue(1001000);
    const css = ['styles/tokens.css', 'styles/base.css', 'styles/ui.css', 'styles/shell.css', 'pages/terminal/radar.css', 'pages/terminal/coin.css'].map(p => readFileSync(`src/${p}`, 'utf8')).join('\n');
    for (const [name, guard] of Object.entries(views)) {
      const card = CoinCardV2Schema.parse({ ...rawCard, verdict: guard });
      const html = render(<div className="coin-page"><GuardCard card={card} /><p>{BUILT_ON}</p><p>{NON_AFFILIATION}</p></div>);
      writeFileSync(`${dir}/${name}.html`, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nhtml,body{height:auto;overflow:auto}body{padding:20px}.icon{width:16px;height:16px}</style></head><body>${html}</body></html>`);
    }
    for (const [name, card] of Object.entries({ new: newCard(), noRating: { ...newCard(), verdict: null } })) {
      writeFileSync(`${dir}/${name}.html`, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nhtml,body{height:auto;overflow:auto}body{padding:20px}.icon{width:16px;height:16px}</style></head><body class="coin-page">${render(<GuardCard card={card} />)}</body></html>`);
    }
    const legacy = createRadarCard(createRadarRows()[0].address)!;
    writeFileSync(`${dir}/legacy.html`, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nhtml,body{height:auto;overflow:auto}body{padding:20px}</style></head><body class="coin-page">${render(<CoinVerdict verdict={legacy.verdict} />)}</body></html>`);
  });
});
