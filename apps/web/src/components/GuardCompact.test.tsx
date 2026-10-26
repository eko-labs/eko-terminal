import { applyRadarEvents } from '../pages/terminal/radarModel';
import { applyPairEvents } from '../pages/terminal/pairsFeedModel';
import { retainCompactGuard } from '../pages/terminal/radarModel';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuardAssessmentV2Schema, BUYER_RISK, DYOR, NON_AFFILIATION, GUARD_CHECK_LABELS, type GuardAssessmentV2 } from '@eko/shared';
import { assessment } from '../../../../packages/shared/test/fixtures/contracts/guard-v2';
import { GuardCompact, CompactVerdictChip, GuardLegend } from './GuardCompact';
import { RadarRowView, HotStrip } from '../pages/terminal/RadarParts';
import { PairView } from '../pages/terminal/Pairs';
import { FeedRow, FeedDescription } from '../pages/terminal/Feed';
import { createRadarRows } from '../mocks/demo/radar';
import { createPairRows } from '../mocks/demo/pairs';
import { FeedItemSchema } from '@eko/shared';
import { ResearchNotes } from '../pages/research/Research';
import { createResearchNotes } from '../mocks/demo/research';

const guard = GuardAssessmentV2Schema.parse(assessment);
const row = createRadarRows()[0];
const pair = createPairRows()[0];
describe('037 compact rendering (synthetic fixtures)', () => {
  it('keeps three tile lines, full detail access, gaps, snapshot and disclosures', () => {
    const g = GuardAssessmentV2Schema.parse({...guard,reasons:[guard.reasons[0],guard.reasons[0],guard.reasons[0],guard.reasons[0]]});
    const html = render(<GuardCompact verdict={{version:2,assessment:g}} />);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('All reasons, checks and evidence');expect(html).toContain('#guard-shadow-evidence');
    expect(html).toContain('Snapshot block');expect(html).toContain('$100 / $1,000');
    for (const text of [BUYER_RISK,DYOR,NON_AFFILIATION]) expect(html).toContain(text);
    for (const check of g.completeness.missing) expect(html).toContain(GUARD_CHECK_LABELS[check]);
  });
  it('negotiates every existing compact row and keeps shadow separate from legacy', () => {
    const views = [
      render(<table><tbody><RadarRowView c={{...row,guardV2:guard}} selected={false} select={()=>{}} trade={()=>{}} pulse={0}/></tbody></table>),
      render(<HotStrip coins={[{...row,guardV2:guard}]} selected={null} select={()=>{}} />),
      render(<PairView row={{...pair,guardV2:guard}} now={1000} at={1000} select={()=>{}} trade={()=>{}} stale={false}/>),
      render(<FeedRow item={FeedItemSchema.parse({id:'sample-feed',kind:'verdict',coin:guard.coin,symbol:row.symbol,level:'clear',block:123,ts:1000000,guardV2:guard})} />),
      render(<ResearchNotes notes={createResearchNotes().map(job=>({...job,note:job.note?{...job.note,guardV2:guard}:undefined}))}/>),
    ];
    for (const html of views) {expect(html).toContain('Rule set 1.0.x');expect(html).not.toContain('Legacy');expect(html).toContain('Shadow assessment');expect(html).toContain('Not fully checked');}
  });
  it('distinguishes unavailable negotiation and active High with gaps from first scan', () => {
    // No Guard 2 result: the grade alone, with no per-row tag (the list's legend explains the rule set once).
    const alone = render(<CompactVerdictChip level="clear" guard={null}/>);expect(alone).toContain('No flags');expect(alone).not.toContain('Guard 2 assessment unavailable');
    const high = GuardAssessmentV2Schema.parse({...guard,mode:'active',level:'high',observedLevel:'high',score:60,baseScore:60,familyPoints:{E:60,O:0,Ff:0,C:0,I:0},factors:[]}) as GuardAssessmentV2;
    const html = render(<CompactVerdictChip level="clear" guard={high} pending />);
    expect(html).toContain('High risk');expect(html).toContain('Not fully checked');expect(html).not.toContain('Scanning');expect(html).not.toContain('No flags<');
  });
  it('preserves negotiated Guard fields while hiding omitted legacy readings after WS updates', () => {
    const {signal: _signal, spark8h: _spark, ...incoming} = row;
    const updated = applyRadarEvents([{...row,guardV2:guard}],[{t:'ev',ch:'radar',seq:1,ts:1,kind:'row_upsert',data:incoming}])[0];
    expect(updated.guardV2).toBe(guard);expect(updated.signal).toBeUndefined();expect(updated.spark8h).toBeUndefined();
    const {antiSnipe: _anti, ...nextPair} = pair;
    const pairUpdated = applyPairEvents([{...pair,guardV2:guard}],[{t:'ev',ch:'pairs',seq:1,ts:1,kind:'pair_upsert',data:nextPair}])[0];
    expect(pairUpdated.guardV2).toBe(guard);expect(pairUpdated.antiSnipe).toBeUndefined();
    const html = render(<HotStrip coins={[{...row,guardV2:guard}]} selected={null} select={()=>{}} />);
    expect(html).not.toContain('<a ');
  });
  it('retains a prior list assessment with stale status on a missing refresh', () => {
    const previous: import('@eko/shared').RadarRow = {...row,guardV2:guard};
    const retained = retainCompactGuard(previous,{...row,guardV2:null});
    expect(retained.guardV2).toBe(guard);expect(retained.guardRefreshFailed).toBe(true);
    expect(render(<CompactVerdictChip level={retained.verdict} guard={retained.guardV2} failed={retained.guardRefreshFailed}/>)).toContain('Stale');
    expect(retainCompactGuard(undefined,{...row,guardV2:null}).guardV2).toBeNull();
  });
  it('builds Feed descriptions only from typed reason data and never parses prose', () => {
    const item = FeedItemSchema.parse({id:'sample-feed',kind:'verdict',coin:guard.coin,symbol:row.symbol,block:123,ts:1000000,guardReasonCode:'EXIT_COST',guardFactorId:'execution_cost'});
    expect(render(<FeedDescription item={item}/>)).toContain('Venue round-trip cost');
    expect(render(<FeedDescription item={{...item,guardReason:guard.reasons[0]}}/>)).toContain('buy-then-sell');
  });
  it('says once, above the rows, which rule set graded them, and puts no tag on the row', () => {
    const legend = render(<GuardLegend rows={[{ guardV2: null }, { guardV2: null }]} />);
    expect(legend.match(/rule set 1\.0\.x/g)).toHaveLength(1);
    // The legend states the buy gate as it is: this grade is checked, not a Guard 2 result.
    expect(legend).toContain('Unscanned coins and coins that cannot be sold are refused');expect(legend).toContain('unless you trade in Degen mode');expect(legend).not.toContain('shown for reference');
    expect(render(<GuardLegend rows={[{}]} />)).toBe('');
    const active = GuardAssessmentV2Schema.parse({...guard,mode:'active',level:'high',observedLevel:'high',score:60,baseScore:60,familyPoints:{E:60,O:0,Ff:0,C:0,I:0},factors:[]}) as GuardAssessmentV2;
    expect(render(<GuardLegend rows={[{ guardV2: active }]} />)).toBe('');
    const chip = render(<CompactVerdictChip level="monitor" guard={null} />);
    expect(chip).toContain('Monitor');expect(chip).not.toContain('Legacy');expect(chip).not.toContain('guard-disclosure');
  });
});

it('renders a price fact beside the rating on Radar and New pairs without changing its level',()=>{
  const radar={...createRadarRows()[0],verdict:'clear' as const,verdictPending:false,priceMove:{downFromPeakPct:85}};
  const pair={...createPairRows()[0],verdict:'clear' as const,verdictPending:false,priceMove:{downFromPeakPct:85}};
  expect(render(<CompactVerdictChip level="clear" priceMove={radar.priceMove}/>)).toContain('Down 85% from peak');
  expect(render(<RadarRowView c={radar} selected={false} select={()=>{}} trade={()=>{}} pulse={0}/>)).toContain('Down 85% from peak');
  expect(render(<PairView row={pair} now={1000} at={1000} select={()=>{}} trade={()=>{}} stale={false}/>)).toContain('Down 85% from peak');
});
