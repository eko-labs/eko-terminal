import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createRadarRows } from '../../mocks/demo/radar';
import { TradePanel } from '../../components/trade/TradePanel';
import { CoinInspector, FlowBar, HotStrip, RadarRowView } from './RadarParts';
import partsSource from './RadarParts.tsx?raw';
import radarSource from './Radar.tsx?raw';
vi.mock('../../lib/useMedia',()=>({useMedia:()=>false}));
describe('Radar contract-driven row and trade slots', () => {
  const row=createRadarRows()[0];
  const renderRow=(c= row)=>renderToStaticMarkup(<table><tbody><RadarRowView c={c} selected={false} select={()=>undefined} trade={()=>undefined} pulse={0}/></tbody></table>);
  it('hides absent CA-31 elements and always tags optional Ape Score beta',()=>{
    const html=renderRow({...row,signal:undefined,spark8h:undefined,beta:{apeScore:87}});
    expect(html).not.toContain('rt-read'); expect(html).not.toContain('class="spark"'); expect(html).toContain('Beta'); expect(html).toContain('87');
    expect(renderRow()).not.toContain('Beta Ape Score');
  });
  it('shows an accessible unavailable value instead of an incomplete price spark',()=>{
    const html=renderRow({...row,spark8h:undefined,unavailable:['spark']});
    expect(html).toContain('class="c-spark"><span');expect(html).toContain('aria-label="Not checked yet"');expect(html).not.toContain('rt-spark');
  });
  it('escapes symbols and names instead of interpreting source instructions',()=>{
    const html=renderRow({...row,symbol:{text:'<img src=x onerror=alert(1)>',flags:['agent_bait'],truncated:false}});
    expect(html).not.toContain('<img'); expect(html).toContain('&lt;img'); expect(html).toContain('Agent bait');
  });
  it('never renders a beta flow without confidence, and hides an absent split',()=>{
    const html=renderToStaticMarkup(<FlowBar flow={row.flow} legend/>); expect(html).toContain('Beta'); expect(html).toContain('86% confidence'); expect(html).toContain('Declared agents'); expect(html).toContain('Likely agents');
    const noSplit=renderToStaticMarkup(<FlowBar flow={{...row.flow,declaredAgentPct:undefined,likelyAgentPct:undefined}} legend/>); expect(noSplit).not.toContain('Declared agents'); expect(noSplit).not.toContain('Likely agents');
  });
  it('shows one Signal beta marker and no agent confidence line in Hot tiles',()=>{
    const html=renderToStaticMarkup(<HotStrip coins={[row]} selected={null} select={()=>undefined}/>);
    expect(html.match(/>Beta</g)).toHaveLength(1); expect(html).not.toContain('confidence');
  });
  it('keeps trading unavailable without configuration and never emits a fabricated quote',()=>{
    const html=renderToStaticMarkup(<TradePanel coin={row.address} priceUsd={row.priceUsd}/>); expect(html).toContain('Trading configuration unavailable.'); expect(html).toContain('disabled=""'); expect(html).not.toContain('Expected received'); expect(html).not.toContain('≈');
  });
  it('preserves the Watch section beside the shared guarded trade panel',()=>{
    const html=renderToStaticMarkup(<CoinInspector row={row} close={()=>undefined} onCard={()=>undefined}/>);
    expect(html).toContain('<h3>Watch</h3>');expect(html).toContain('>Watch</button>');
    expect(html).toContain('<h3>Trade</h3>');expect(html).toContain('Custom trade amount');
  });
  it('calls the signal "Signal · five readings", never agents, with one Beta marker in the column header (BACKEND §7.7)',()=>{
    expect(partsSource).toContain('Signal · five readings'); expect(partsSource).not.toMatch(/five[- ]agent/i);
    expect(renderRow()).not.toContain('signal-beta'); expect(radarSource).toContain('className="c-sig r">Signal <span className="tag signal-beta">Beta</span>');
  });
});
