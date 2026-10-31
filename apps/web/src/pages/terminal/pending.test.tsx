import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { createPairRows } from '../../mocks/demo/pairs';
import { createMissionDemo } from '../../mocks/demo/mission';
import { heatOf, marking } from '../../lib/heat';
import { CoinInspector, HotStrip, InspectorGuard, RadarRowView } from './RadarParts';
import { CoinVerdict } from './CoinCard';
import Coin from './Coin';
import * as coinData from './useCoin';
import { PairView } from './Pairs';
import { pairTradeDisabled } from './pairsFeedModel';
import { JournalLine } from '../mission/parts';
import { JournalEntryRow } from '../mission/Journal';

vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));
afterEach(() => vi.restoreAllMocks());
const base = createRadarRows()[0], row = { ...base, verdict: 'pending' as const, topPlaybook: undefined };
const original = createRadarCard(row.address)!;
const verdict = { ...original.verdict, level: 'pending' as const, playbooks: [], reasons: [], evaluatedPlaybooks: [] };
const card = { ...original, verdict, playbooks: [] };
function checking(html: string) {
  expect(html).toContain('Not fully checked');
  expect(html).toContain('aria-busy="false"');
  expect(html).not.toContain('No flags<');
  expect(html).not.toContain('Nothing matched');
  expect(html).not.toContain('No scam playbooks matched');
}
describe('CA-34 pending verdict presentation', () => {
  it('keeps Radar rows, tiles and the inspector in the checking state', () => {
    checking(render(<table><tbody><RadarRowView c={row} selected={false} select={() => {}} trade={() => {}} pulse={0} /></tbody></table>));
    checking(render(<HotStrip coins={[row]} selected={null} select={() => {}} />));
    checking(render(<CoinInspector row={row} close={() => {}} onCard={() => {}} />));
    const guard = render(<InspectorGuard card={card} href={`/coin/${row.address}`} />);
    expect(guard).toContain('Not fully checked');
    expect(guard).not.toContain('No scam playbooks matched');
    expect(heatOf(row, { pending: false })).toBe('scanning');
    expect(marking(row, { pending: false })).toBeNull();
  });
  it('keeps the pair trade opener available once a pending verdict exists', () => {
    const pair = { ...createPairRows()[0], verdict: 'pending' as const, verdictPending: false };
    expect(pairTradeDisabled(pair)).toBe(false);
    const html = render(<ul><PairView row={pair} now={1000} at={1000} select={() => {}} trade={() => {}} stale={false} /></ul>);
    checking(html); expect(html).toContain('Not fully checked'); expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });
  it('disables the pair trade opener with the reason while live trading is paused', () => {
    const pair = { ...createPairRows()[0], verdict: 'clear' as const, verdictPending: false };
    expect(pairTradeDisabled(pair, false, true)).toBe(false);
    expect(pairTradeDisabled(pair, false, false)).toBe(true);
  });
  it('renders the coin head and card as checking when the API returns pending', () => {
    vi.spyOn(coinData, 'useCoin').mockReturnValue({ candlesUnavailable:false,candlesLoading:false,lastTradeTs:null,labelsUnavailable:true,card, verdict, bars: [], markers: [], flows: [], error: '', unknown: false, ageSec: 0, retry: () => {} });
    const html = render(<Coin params={{ address: row.address }} />);
    checking(html); expect(html).toMatch(/chart-read.*Not fully checked/); expect(html).toContain('Not fully checked');
    checking(render(<CoinVerdict verdict={verdict} />));
  });
  it.each([{ verdict: 'pending' }, { verdict: { level: 'pending' } }, { senses: { verdict: { level: 'pending' } } }])('shows checking in compact and detailed Mission journal lines: %j', payload => {
    const demo = createMissionDemo(), entry = { ...demo.journals.dca[0], payload: { decision: 'deny', ...payload } };
    checking(render(<ul><JournalLine entry={entry} agent={demo.agents[1]} /></ul>));
    checking(render(<JournalEntryRow entry={entry} agent={demo.agents[1]} />));
  });
});
