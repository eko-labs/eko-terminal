import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe,expect,it,vi } from 'vitest';
import { emptyTradeWindow } from '../../copy/availability';
import { ChartStage } from '../../components/chart/ChartStage';
import { VerdictChip } from '../../components/ui';
import { createRadarCard,createRadarRows } from '../../mocks/demo/radar';
import { createPairRows } from '../../mocks/demo/pairs';
import { CoinOverview } from './CoinCard';
import { RadarRowView } from './RadarParts';
import Radar from './Radar';
import { PairView } from './Pairs';
import { sortRows,sortAvailable } from './radarModel';
vi.mock('../../lib/useMedia',()=>({useMedia:()=>false}));
describe('CA-35 availability',()=>{
  it('separates Scanning from Not fully checked and names missing checks',()=>{
    const scanning=render(<VerdictChip level="pending" verdictPending/>);
    expect(scanning).toContain('Scanning…');expect(scanning).toContain('aria-busy="true"');
    const pending=render(<VerdictChip level="pending" evaluatedPlaybooks={['agent_bait']} meta={{tradeability:{confidence:0,asOfBlock:1,unavailable:true,missing:['simulations','exitCosts']}}}/>);
    expect(pending).toContain('Not fully checked');expect(pending).toContain('buy-then-sell simulation');expect(pending).toContain('exit costs');expect(pending).toContain('honeypot');expect(pending).toContain('aria-busy="false"');expect(pending).not.toContain('scanning');
  });
  it('masks unavailable row numbers and skips those values when sorting',()=>{
    const base=createRadarRows()[0],row={...base,verdict:'pending' as const,verdictPending:false,unavailable:['exitCost','flow','liquidity','signal','change','marketCap'] as const};
    const c={...row,unavailable:[...row.unavailable],exitCost1kPct:0,change1hPct:0};
    const html=render(<table><tbody><RadarRowView c={c} selected={false} select={()=>{}} trade={()=>{}} pulse={0}/></tbody></table>);
    // Six masked cells: exit, flow, liquidity, signal, 1h and market cap.
    expect(html.match(/aria-label="Not checked yet" title="Not checked yet">—/g)).toHaveLength(6);expect(html).not.toContain('0.0%');expect(html).not.toContain('>0%</span>');
    const pair={...createPairRows()[0],unavailable:c.unavailable,verdict:'pending' as const,verdictPending:false};
    const pairHtml=render(<ul><PairView row={pair} now={1} at={1} select={()=>{}} trade={()=>{}} stale={false}/></ul>);expect(pairHtml.match(/>Not fully checked</g)).toHaveLength(1);
    expect(pairHtml).toContain('aria-label="Not checked yet" title="Not checked yet">—');
    expect(sortAvailable([c],'Exit cost')).toBe(false);
    expect(sortRows([c,{...base,exitCost1kPct:12}],'Exit cost')[0].exitCost1kPct).toBe(12);
  });
  it('shows a calm empty chart and disables all wallet label controls',()=>{
    expect(emptyTradeWindow(0,36000)).toBe('No trades in this window · last trade 10 h ago');
    const html=render(<ChartStage market="DEMO" timeframe="5m" onTimeframe={()=>{}} bars={[]} markers={[]} supply={1} verdict={null} labelsUnavailable/>);
    expect(html).toContain('Wallet labels arrive later');expect(html.match(/type="checkbox" disabled=""/g)).toHaveLength(4);
  });
  it('shows one shared availability legend above Radar',()=>{
    const html=render(<Radar/>);
    expect(html.match(/— not checked yet: exit costs and buyer mix arrive with the trade simulation and wallet labels/g)).toHaveLength(1);
  });
  it('marks unavailable coin sections rather than displaying structural zeros',()=>{
    const card=createRadarCard(createRadarRows()[0].address)!;
    card.verdict={...card.verdict,level:'pending'};
    card.meta={tradeability:{confidence:0,asOfBlock:1,unavailable:true},flow:{confidence:0,asOfBlock:1,unavailable:true},control:{confidence:0,asOfBlock:1,unavailable:true},liquidity:{confidence:0,asOfBlock:1,unavailable:true}};
    const html=render(<CoinOverview card={card} verdict={card.verdict} flows={[card.flow]} evidenceOpen={false}/>);
    expect(html.match(/not checked yet/g)).toHaveLength(4);expect(html).not.toContain('>No</span>');expect(html).not.toContain('0% agents');
  });
});
