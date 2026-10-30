import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Census } from '@eko/shared';
import { createCensus, createRadarRow } from '../mocks/fixtures';
import { DYOR, NON_AFFILIATION } from '../copy';
import { resolveRoute } from '../routes';
import CensusPage, { CensusView } from './Census';

const now=Date.parse('2026-10-03T12:00:00Z');
function published():Census {
  const data=createCensus();data.gated=false;
  data.gate={metric:'likely_agent_precision',value:0.95,threshold:0.9,wilsonLower:0.91,recall:0.8,modelVersion:'fp-fixture',
    evaluatedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400_000).toISOString(),modelHash:'a'.repeat(64),datasetHash:'b'.repeat(64),
    evidence:{declared:1,agents:200,humans:300,disagreements:0,predictedAgents:201}};
  data.chain=[{window:'24h',agentPct:42.3,crewPct:15,humanPct:42.7,asOfBlock:2468},
    {window:'7d',agentPct:35.6,crewPct:10,humanPct:54.4,asOfBlock:2468}];
  const row=createRadarRow();row.flow={...row.flow,agentPct:23.4,crewPct:12.3,humanPct:64.3,beta:false,modelVersion:'fp-fixture'};
  row.unavailable=[];data.coins=[row];return data;
}
const render=(data:Census|null,status?:'loading'|'error',time=now)=>renderToStaticMarkup(<CensusView data={data} now={time} status={status} />);
const assertGated=(html:string)=>{
  expect(html).toContain('Census numbers publish once wallet-label precision passes 90%.');
  for(const text of ['42.3%','35.6%','23.4%','2468','fp-fixture','Publication evidence','<table','<svg','<canvas','census-window','census-share','95.0%'])expect(html).not.toContain(text);
  expect(html).toContain('id="methodology"');expect(html).toContain('Watch updates on this page');
};
describe('Census publication DOM',()=>{
  it('loads the public Census page without flags or authentication',async()=>{
    const route=resolveRoute('/census',{});expect(route?.route.auth).toBe('public');
    expect((await route!.route.load()).default).toBe(CensusPage);
  });
  it('hides all response numbers and evidence when gated even if aggregates were supplied',()=>{
    const data=published();data.gated=true;data.reason='42.3% should never appear';assertGated(render(data));
  });
  it('keeps methodology visible during loading and failures without number placeholders',()=>{
    assertGated(render(null,'loading'));const html=render(null,'error');assertGated(html);expect(html).toContain('Retry');
  });
  it('renders accepted model, measured shares, confidence and disclosures',()=>{
    const html=render(published());for(const text of ['42.3%','35.6%','23.4%','95.0%','91.0%','80.0%','fp-fixture',DYOR,NON_AFFILIATION,
      'per research','Methodology','Confidence tiers','Declared agent (ERC-8004)','Likely agent','Crew','Human']) {
      if(text==='per research')expect(html).toContain('Per our research, the first agent-flow metric published for Elysium.');else expect(html).toContain(text);
    }
    expect(html).toContain('Trend history is unavailable');expect(html).toContain('<td>Unavailable</td>');
  });
  it.each(['expired','future','failed','missing-hashes','small-set'] as const)('fails closed for %s evaluation evidence',kind=>{
    const data=published();
    if(kind==='expired')data.gate.expiresAt=new Date(now).toISOString();
    if(kind==='future')data.gate.evaluatedAt=new Date(now+1).toISOString();
    if(kind==='failed')data.gate.value=0.89;
    if(kind==='missing-hashes')data.gate.modelHash=null;
    if(kind==='small-set')data.gate.evidence!.agents=199;
    assertGated(render(data));
  });
  it('removes published data at expiry and rejects stale model coin rows',()=>{
    const data=published();assertGated(render(data,undefined,Date.parse(data.gate.expiresAt!)));
    data.coins[0].flow.modelVersion='fp-old';expect(render(data)).not.toContain('23.4%');
    expect(render(data)).toContain('Finalized by-coin coverage is unavailable.');
  });
});
