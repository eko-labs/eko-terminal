import { describe,expect,it } from 'vitest';
import { applyPonsCampaignTransaction,campaignPressure,pressureAtLeast,campaignStateHash,replayPonsCampaign,type CampaignLeg } from '../src/index.js';
import { fixture,state,sell,buy,seller,buyer,duringBuyer,collector,block,emptyFees } from './campaign-fixtures.js';
import { hash } from './reference-fixtures.js';
const rationalNumber=(r:{numerator:string;denominator:string}|null)=>r?Number(r.numerator)/Number(r.denominator):null;
function repin(i:ReturnType<typeof fixture>) {
 let s=structuredClone(i.checkpoint.state);i.checkpoint.stateHash=campaignStateHash(s);
 for(const b of i.blocks)for(const tx of b.transactions){s=applyPonsCampaignTransaction(s,tx,b.cursor.timestampSec);tx.expectedStateHash=campaignStateHash(s);}return i;
}
describe('campaign pressure interval arithmetic',()=>{
 it('encloses exact full-weight pressure, handles fractions, rise-only legs, and threshold uncertainty',()=>{
  const leg={before:{n:2n,d:1n},after:{n:1n,d:1n},fraction:{n:1n,d:1n}},p=campaignPressure([leg]);
  expect(p.fraction).toBe('0.5');expect(p.pct).toBe('50');expect(pressureAtLeast(p,1n,2n)).toBeNull();expect(pressureAtLeast(p,49n,100n)).toBe(true);
  const bounds=p.errorBounds;expect(BigInt(bounds.lower.numerator)*2n).toBeLessThanOrEqual(BigInt(bounds.lower.denominator));expect(BigInt(bounds.upper.numerator)*2n).toBeGreaterThanOrEqual(BigInt(bounds.upper.denominator));
  const half=campaignPressure([{...leg,fraction:{n:1n,d:2n}}]);expect(Number(half.fraction)).toBeCloseTo(1-Math.sqrt(0.5),14);
  expect(campaignPressure([{...leg,before:leg.after,after:leg.before}]).fraction).toBe('0');
  expect(()=>campaignPressure([{...leg,fraction:{n:2n,d:1n}}])).toThrow('Invalid');
 });
 it('encloses telescoping rational pressures over extreme ratios without floating-point overflow',()=>{
  for(const n of [3n,17n,10n**80n]){
   const p=campaignPressure([{before:{n,d:1n},after:{n:1n,d:1n},fraction:{n:1n,d:1n}}]);
   expect(BigInt(p.errorBounds.lower.numerator)*n).toBeLessThanOrEqual((n-1n)*BigInt(p.errorBounds.lower.denominator));
   expect(BigInt(p.errorBounds.upper.numerator)*n).toBeGreaterThanOrEqual((n-1n)*BigInt(p.errorBounds.upper.denominator));
  }
 });
});
describe('exact campaign reconstruction and real buyer interventions',()=>{
 it('$300 reserve-relative harm qualifies while the float and $500 branches do not',()=>{
  const r=replayPonsCampaign(fixture());expect(r.failure).toBeNull();expect(r.raw.gross).toBe('300');expect(r.raw.netTradingCashOut).toBe('300');
  expect(r.materialBranches).toEqual({float:false,netUsd:false,reserve:true});expect(r.actual![0].sufficient).toBe(true);
  expect(rationalNumber(r.actual![0].costWeightedReturnPp)).toBe(-46);expect(rationalNumber(r.interventions[0].contributionPp![0].value)).toBe(46);
  expect(r.harmfulCandidate).toBe(true);expect(r.attributionAvailable).toBe(false);expect(r.pressure).not.toBeNull();expect(r.mode).toBe('shadow');
 });
 it('tiny ordinary profit is retained without a harmful candidate',()=>{
  const i=fixture([[sell('tiny','10000')]]);const r=replayPonsCampaign(i);
  expect(r.raw.gross).toBe('10');expect(r.harmfulCandidate).toBe(false);expect(Object.values(r.materialBranches)).not.toContain(true);
 });
 it('reconstructs intra-block launch, buy, dump and fee change from parent prefix',()=>{
  const opening=state();opening.curve=null;
  const launch:CampaignLeg={kind:'launch',id:hash('launch-leg'),economicId:null,curve:state().curve!,fees:emptyFees()};
  const fees:CampaignLeg={kind:'fees',id:hash('fee-change'),economicId:null,fees:{buy:[],sell:[{kind:'creator',base:'gross',bps:'1000',fixedWei:'0',recipient:collector}],overrides:[]}};
  const groups=[[launch],[buy('prefix-buy',buyer)],[sell('intra-sale')],[fees],[buy('during-buy')]];
  const i=fixture(groups,[1000,1000,1000,1000,1000],opening,2);
  const transactions=i.blocks.map((b,k)=>({...b.transactions[0],index:k}));i.blocks=[{cursor:block(100,1000),parentHash:i.checkpoint.cursor.blockHash as `0x${string}`,transactions}];
  i.campaign.from={...block(100,1000),boundary:'before_tx',transactionIndex:2,executionOrdinal:0};i.campaign.through=block(100,1000);i.knownAt.cursor=block(100,1000);
  i.campaign.totalCost.before={numerator:'200',denominator:'1'};i.campaign.totalCost.during={numerator:'100',denominator:'1'};
  const r=replayPonsCampaign(repin(i));expect(r.failure).toBeNull();expect(r.boundaries).toHaveLength(5);
  expect(r.openingState!.curve!.realQuote).toBe('1100');expect(r.closeState!.fees.sell[0].bps).toBe('1000');
  expect(r.actual!.map(v=>v.cohort)).toEqual(['before','during']);expect(r.actual![1].cost).toEqual({numerator:'100',denominator:'1'});
  expect(r.interventions[0].status).toBe('valid');expect(r.openingState!.lots.filter(l=>l.owner===buyer)).toHaveLength(2);
 });
 it('values wallets independently at the same close state, allocating liquidation gas once',()=>{
  const i=fixture([[sell('sale')],[buy('during')]], [1000,1001]);i.campaign.totalCost.during={numerator:'100',denominator:'1'};i.campaign.closeLiquidationGasQuote='7';
  const r=replayPonsCampaign(i);expect(r.actual![0].wallets[0].owner).toBe(buyer);expect(r.actual![1].wallets[0].owner).toBe(duringBuyer);
  const noGas=replayPonsCampaign({...i,campaign:{...i.campaign,closeLiquidationGasQuote:'0'}});
  expect(rationalNumber(noGas.actual![0].value)!-rationalNumber(r.actual![0].value)!).toBe(7);expect(rationalNumber(noGas.actual![1].value)!-rationalNumber(r.actual![1].value)!).toBe(7);
 });
 it('retains 61/301-second episodes and a slow 24h bleed exactly once',()=>{
  const r=replayPonsCampaign(fixture([[sell('a','10000')],[sell('b','10000')],[sell('c','10000')],[sell('d','10000')]], [1000,1061,1362,87399]));
  expect(r.windows[2].saleIds).toHaveLength(4);expect(r.windows[2].sold).toBe('40000');expect(r.windows[0].saleIds).toEqual([hash('d')]);expect(r.episodes).toHaveLength(4);expect(r.status).toBe('open');
 });
 it('preserves raw pressure and harmed buyers when a remaining buy limit invalidates counterfactual',()=>{
  const next=buy('tight-buy');if(next.kind==='buy')next.minimumOutput='100000';
  const i=fixture([[sell('dump')],[next]],[1000,1001]);i.campaign.totalCost.during={numerator:'100',denominator:'1'};
  const r=replayPonsCampaign(i);expect(r.failure).toBeNull();expect(r.actual).not.toBeNull();expect(r.pressure).not.toBeNull();
  expect(r.interventions[0].failure).toBe('minimum_output');expect(r.interventions[0].failedTransaction).toBe(i.blocks[1].transactions[0].id);expect(r.harmfulCandidate).toBe(false);
 });
 it('does not spend removed sale proceeds to satisfy original remaining funding',()=>{
  const transfer:CampaignLeg={kind:'quote_transfer',id:hash('sweep'),economicId:null,from:seller,to:collector,units:'100300'};
  const r=replayPonsCampaign(fixture([[sell('fund-sale')],[transfer]],[1000,1001]));
  expect(r.interventions[0].failure).toBe('negative_quote_balance');expect(r.pressure).not.toBeNull();
 });
 it('separates sell-only from net-trading and rejects invalid mandatory swaps',()=>{
  const i=fixture([[buy('side-buy',seller,'20')],[sell('side-sell')]], [1000,1001]);
  const r=replayPonsCampaign(i);expect(r.interventions[0].removedLegIds).toEqual([hash('side-sell')]);expect(r.interventions[1].removedLegIds).toContain(hash('side-buy'));
  const broken=structuredClone(i);const l=broken.blocks[1].transactions[0].legs[0];if(l.kind==='sell')l.deadlineSec='1000';
  expect(replayPonsCampaign(broken).failure).toBe('deadline');expect(replayPonsCampaign(broken).harmfulCandidate).toBe(false);
 });
 it('keeps gift basis unknown and never treats gift origin as sale control',()=>{
  const opening=state();opening.lots[1].origin=seller;opening.lots[1].cost=null;opening.lots[1].payer=null;
  const r=replayPonsCampaign(fixture([[sell('gift-origin-sale')]], [1000],opening));
  expect(r.actual![0].wallets[0].status).toBe('unknown');expect(r.interventions[0].failure).toBe('unpriced_basis_or_position');expect(r.pressure).not.toBeNull();expect(r.harmfulCandidate).toBe(false);
 });
 it('closes episodes on empty timer blocks, splits at 300s, and stays deterministic on resume',()=>{
  const i=fixture([[sell('s0','10000')],[sell('s1','10000')],[sell('s2','10000')],[sell('s3','10000')],[sell('s4','10000')],[sell('s5','10000')]], [1000,1060,1120,1180,1240,1300]);
  const r=replayPonsCampaign(i);expect(r.episodes).toHaveLength(2);expect(r.episodes[0].saleIds).toHaveLength(5);expect(r.episodes[0].status).toBe('closed');expect(r.episodes[1].status).toBe('open');
  const cursor=block(106,1361);i.blocks.push({cursor,parentHash:i.blocks.at(-1)!.cursor.blockHash as `0x${string}`,transactions:[]});i.knownAt.cursor=cursor;i.campaign.through=cursor;
  const closed=replayPonsCampaign(i);expect(closed.status).toBe('closed');expect(closed.episodes.every(e=>e.status==='closed')).toBe(true);expect(replayPonsCampaign(i)).toEqual(closed);
 });
 it('reports independent gift-recipient selling as mechanical harm with responsibility unresolved',()=>{
  const opening=state();opening.lots[0].origin=buyer;
  const r=replayPonsCampaign(fixture([[sell('independent-gift-seller')]], [1000],opening));
  expect(r.harmfulCandidate).toBe(true);expect(r.attributionAvailable).toBe(false);expect(r.openingState!.lots[0].origin).toBe(buyer);
 });
 it('makes unsupported migrations and unreviewed routes indeterminate while retaining reconstructed sale pressure',()=>{
  const i=fixture();i.blocks[0].transactions.push({id:hash('unsupported-tx'),index:1,gasPayer:seller,gasQuote:'0',gasRecipient:collector,expectedStateHash:hash('missing-successor-state'),legs:[{kind:'unsupported',id:hash('migration'),economicId:null,reason:'migration'}]});
  const r=replayPonsCampaign(i);expect(r.failure).toBe('unsupported_migration');expect(r.interventions[0].status).toBe('indeterminate');expect(r.pressure).not.toBeNull();expect(r.harmfulCandidate).toBe(false);
  const unreviewed=fixture();unreviewed.campaign.routeReviewed=false;const unknown=replayPonsCampaign(unreviewed);expect(unknown.failure).toBe('unreviewed_route');expect(unknown.pressure).toBeNull();
 });
 it('preserves original gas, allowances and fee recipients, rejecting token-balance overrides',()=>{
  const i=fixture();i.blocks[0].transactions[0].gasQuote='1';const r=replayPonsCampaign(repin(i));
  expect(r.closeState!.wallets.find(w=>w.account===collector)!.quote).toBe('1');expect(r.closeState!.wallets.find(w=>w.account===seller)!.allowance).toBe('125000');
  const bad=fixture();bad.checkpoint.state.wallets[0].token='600000';bad.checkpoint.stateHash=campaignStateHash(bad.checkpoint.state);expect(()=>replayPonsCampaign(bad)).toThrow('lot_conservation');
  const allowance=fixture();allowance.checkpoint.state.wallets[0].allowance='0';allowance.checkpoint.stateHash=campaignStateHash(allowance.checkpoint.state);expect(replayPonsCampaign(allowance).failure).toBe('allowance');
 });
 it('rejects missing prefixes, mismatched before pins, block-end substitution and post-state mismatch',()=>{
  const i=fixture();const bad=structuredClone(i);bad.blocks[0].transactions[0].index=1;expect(()=>replayPonsCampaign(bad)).toThrow('transaction_prefix');
  const wrong=structuredClone(i);wrong.campaign.from.timestampSec='1001';expect(()=>replayPonsCampaign(wrong)).toThrow('boundary_pin');
  const end=structuredClone(i);end.campaign.from.boundary='block_end';end.campaign.from.transactionIndex=null;end.campaign.from.executionOrdinal=null;expect(()=>replayPonsCampaign(end)).toThrow('boundary');
  const mismatch=structuredClone(i);mismatch.blocks[0].transactions[0].expectedStateHash=hash('wrong');expect(replayPonsCampaign(mismatch).failure).toBe('replay_fidelity');
 });
});
