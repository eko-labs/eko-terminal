import { describe,it,expect } from 'vitest';
import { decodeFunctionData, getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { V4ReferenceSimulation,v4PoolId,v4QuoteData,v4ReferenceQuoterAbi,v4FallbackLink } from '../src/simulation/v4.js';
import { cursor,v4Route,v4Input,v4Clients } from './v4-reference-fixtures.js';
const hash=(s:string)=>keccak256(stringToHex(s));
describe('v4 native reference route (synthetic transport only)',()=>{
  it('encodes the real quoter tuple and binds every PoolKey field',()=>{
    const data=decodeFunctionData({abi:v4ReferenceQuoterAbi,data:v4QuoteData(v4Route,1000n)});
    expect(data.args?.[0]).toMatchObject({poolKey:{...v4Route.key,currency1:getAddress(v4Route.key.currency1)},exactAmount:1000n,zeroForOne:true,hookData:'0x1234'});
    expect(v4PoolId({...v4Route.key,tickSpacing:61})).not.toBe(v4Route.poolId);
    expect(decodeFunctionData({abi:v4ReferenceQuoterAbi,data:v4QuoteData(v4Route,555n,true)}).args?.[0]).toMatchObject({exactAmount:555n,zeroForOne:false});
  });
  it('records a clean hook probe, isolated overrides and quote-only capability',async()=>{
    const {clients,request}=v4Clients();const r=await new V4ReferenceSimulation(clients).run(v4Input);
    expect(r).toMatchObject({status:'observed',complete:false,honeypotConfirmed:false,route:{executable:false},venueRoundTripCostPct:0,ekoFeeWei:'0',capability:{abi:'pinned',trace:'passed',executableForkGate:'not_accepted'}});
    expect(r.hookEvidence).toMatchObject({quoteBuyGapPct:0,quoteSellGapPct:0,buyFeePct:null,sellFeePct:null,diagnostics:[]});
    const trace=request.mock.calls.find(([r])=>r.method==='debug_traceCall')![0];
    const overrides=(trace.params[2] as {stateOverrides:Record<string,unknown>}).stateOverrides;
    expect(Object.keys(overrides)).toHaveLength(1);expect(Object.keys(Object.values(overrides)[0] as object).sort()).toEqual(['balance','code']);
  });
  it('records a >2% quote/simulation mismatch without inventing fees or acceptance',async()=>{
    const {clients}=v4Clients({tokens:950n,returned:970n});const r=await new V4ReferenceSimulation(clients).run(v4Input);
    expect(r.hookEvidence).toMatchObject({quoteBuyGapPct:5,quoteSellGapPct:3,diagnostics:['quote_sim_gap'],buyFeePct:null});expect(r.route.executable).toBe(false);
  });
  it('records asymmetric fees only against a matching independent no-tax baseline',async()=>{
    const {clients}=v4Clients({tokens:990n,quotedSell:891n,returned:891n});
    const noTax={blockHash:cursor.blockHash as Hex,poolId:v4Route.poolId,sizeWei:'1000',tokens:'990',buyOutput:'1000',sellOutput:'990',evidenceIds:[hash('fixture-no-tax')]};
    const r=await new V4ReferenceSimulation(clients).run({...v4Input,noTax});
    expect(r.hookEvidence).toMatchObject({buyFeePct:1,sellFeePct:10,feeAsymmetryPp:9,diagnostics:['asymmetric_fee']});expect(r.venueRoundTripCostPct).toBe(10.9);
    const unbound=await new V4ReferenceSimulation(clients).run({...v4Input,noTax:{...noTax,tokens:'999'}});expect(unbound.hookEvidence.buyFeePct).toBeNull();
  });
  it('uses exact arithmetic at the 2% diagnostic boundary',async()=>{
    for(const [tokens,expected] of [[980000n,false],[979999n,true]] as const) {
      const {clients}=v4Clients({quotedBuy:1000000n,tokens});const r=await new V4ReferenceSimulation(clients).run(v4Input);
      expect(r.hookEvidence.diagnostics.includes('quote_sim_gap')).toBe(expected);
    }
  });
  it('records acquired-position sell restriction without a confirmed honeypot',async()=>{
    const {clients}=v4Clients({sellOk:false,returned:0n});const r=await new V4ReferenceSimulation(clients).run(v4Input);
    expect(r).toMatchObject({status:'sell_restricted',honeypotConfirmed:false,complete:false,venueRoundTripCostPct:null});
  });
  it('rejects unknown hooks, PoolId/key mismatch and missing per-pool successor custody before RPC',async()=>{
    for(const route of [{...v4Route,verification:{...v4Route.verification,reviewed:false}}, {...v4Route,poolId:hash('wrong-pool')}, {...v4Route,launchpad:'pons' as const,successor:null}]) {
      const {clients,request}=v4Clients();expect((await new V4ReferenceSimulation(clients).run({...v4Input,route})).status).toBe('unsupported');expect(request).not.toHaveBeenCalled();
    }
  });
  it('fails closed on missing successor liquidity, changed code, transport error and reorg',async()=>{
    for(const options of [{liquidity:0n},{code:'0x5678' as Hex},{traceError:'unavailable'},{reorg:true}]) {
      const {clients}=v4Clients(options);const r=await new V4ReferenceSimulation(clients).run(v4Input);
      expect(r).toMatchObject({status:'provider_failure',probe:null,route:{executable:false}});
    }
  });
  it('permits only configured HTTPS venue-link origins for Pons fallback',()=>{
    const route={...v4Route,launchpad:'pons' as const};
    const config={pons:{baseUrl:'https://venue.example/swap',allowedOrigins:['https://venue.example']}};
    expect(v4FallbackLink(route,config)).toContain('token=');
    for(const baseUrl of ['https://evil.example/swap','http://venue.example/swap','https://demo:password@venue.example/swap','https://venue.example/swap#bad'])expect(v4FallbackLink(route,{pons:{...config.pons,baseUrl}})).toBeNull();
    expect(v4FallbackLink(v4Route,config)).toBeNull();
  });
});
