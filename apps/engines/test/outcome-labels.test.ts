import { expect,it } from 'vitest';
import { evaluateOutcomeLabels } from '../src/outcome-labels.js';
import { outcomeFixture,confirmation,authority,at,rational } from './outcome-fixtures.js';
import { fixture,sell,buy,buyer,seller } from '../../../packages/chain/test/campaign-fixtures.js';
import { hash } from '../../../packages/chain/test/reference-fixtures.js';
const labels=(i:ReturnType<typeof outcomeFixture>,lag=30,canonical=true)=>evaluateOutcomeLabels(i,confirmation(i,lag),canonical);
const fact=(r:ReturnType<typeof labels>,kind:string)=>r.records.find(f=>f.kind===kind)!;

it('records ordinary-loss survival only after complete checkpoints and the 30-second canonical policy, never finality',()=>{
 const i=outcomeFixture();
 expect(fact(labels(i,29),'survived').status).toBe('provisional');
 expect(fact(labels(i,30,false),'survived').status).toBe('provisional');
 const r=labels(i);expect(fact(r,'survived').qualification).toBe('qualified');expect(fact(r,'survived').status).toBe('confirmed_under_policy');
 expect(r.complete).toBe(true);expect(r.confirmationPolicy.protocolFinality).toBe(false);expect(r.records.every(r=>!r.historyEligible)).toBe(true);
 expect(r.maturityCursor).toEqual(i.boundaries.at(-1)!.cursor);
});
it.each([3600,86400,604800] as const)('uses first completed boundary and scheduled exits for the %i-second horizon',horizon=>{
 const i=outcomeFixture(undefined,horizon),r=labels(i);
 expect(r.requiredCheckpoints).toHaveLength(horizon/60);expect(BigInt(r.maturityCursor!.timestampSec)).toBe(940n+BigInt(horizon));
 expect(fact(r,'survived').qualification).toBe('qualified');
});
it('requires named real before/during victims, the material OR and valid sell-only contribution; retains independent origin harm without launcher blame',()=>{
 const campaign=fixture([[buy('during')],[sell('sale')],[]],[1000,1060,1121]);
 campaign.campaign.totalCost.during=rational(100);campaign.campaign.openingFloat='100000000';
 const i=outcomeFixture(campaign);i.campaigns[0].responsibility=authority(i,'origin');
 const r=labels(i),harm=fact(r,'harmful_disposition');
 expect(harm.qualification).toBe('qualified');expect(harm.attribution).toBe('origin_unresolved');expect(harm.status).toBe('indeterminate');expect(fact(r,'dump').qualification).toBe('unknown');
 const details=harm.details as {materialBranches:{float:boolean;reserve:boolean};cohorts:{cohort:string;wallets:{owner:string}[]}[]};
 expect(details.materialBranches.float).toBe(false);expect(details.materialBranches.reserve).toBe(true);
 expect(details.cohorts.map(c=>c.cohort)).toEqual(['before','during']);expect(details.cohorts[0].wallets[0].owner).toBe(buyer);
 expect(details.cohorts[1].wallets).toHaveLength(1);expect(r.records.every(r=>!r.historyEligible)).toBe(true);
});
it('requires own-side control, accepted conservation/fidelity and calibration for dump; later control cannot rewrite earlier responsibility',()=>{
 const campaign=fixture([[sell('sale')],[]],[1000,1061]);campaign.campaign.fidelityAccepted=true;
 const i=outcomeFixture(campaign);i.campaigns[0].calibrated=true;i.campaigns[0].responsibility=authority(i);
 expect(fact(labels(i),'dump').qualification).toBe('qualified');
 for(const kind of ['origin','coordination','authenticated_remover'] as const){i.campaigns[0].responsibility=authority(i,kind);expect(fact(labels(i),'dump').qualification).toBe('unknown');}
 i.campaigns[0].responsibility=authority(i);i.campaigns[0].responsibility!.knownAt={...i.availabilityCut,acquisitionSequence:'3'};
 expect(fact(labels(i),'dump').attribution).toBe('unknown');expect(fact(labels(i),'dump').qualification).toBe('unknown');
 const priorEvent=fact(labels(i),'dump').eventId;
 i.availabilityCut={...i.availabilityCut,acquisitionSequence:'3'};
 expect(fact(labels(i),'dump').eventId).toBe(priorEvent);expect(fact(labels(i),'dump').qualification).toBe('qualified');
 i.campaigns[0].responsibility=authority(i,'non_operator');expect(fact(labels(i),'harmful_disposition').qualification).toBe('qualified');
 expect(fact(labels(i),'harmful_disposition').status).toBe('confirmed_under_policy');expect(fact(labels(i),'dump').qualification).toBe('not_qualified');
});
it('keeps subthreshold and incomplete/invalid intervention campaigns out of automated harm',()=>{
 const tiny=fixture([[sell('tiny','10000')],[]],[1000,1061]);tiny.campaign.openingFloat='100000000';
 const small=labels(outcomeFixture(tiny));expect(fact(small,'harmful_disposition').qualification).toBe('not_qualified');
 const unknown=fixture([[sell('sale')],[]],[1000,1061]);unknown.campaign.totalCost.before=rational(1000);
 expect(fact(labels(outcomeFixture(unknown)),'harmful_disposition').qualification).toBe('unknown');
 unknown.campaign.totalCost.before=rational(100);unknown.campaign.closeLiquidationGasQuote=null;
 expect(fact(labels(outcomeFixture(unknown)),'harmful_disposition').qualification).toBe('unknown');
 const open=fixture();expect(fact(labels(outcomeFixture(open)),'harmful_disposition').qualification).toBe('unknown');
});
it('records authorized independent withdrawal, excludes benign migration and leaves unknown successors unassessed',()=>{
 const i=outcomeFixture(),cursor=at(i,1060);
 i.withdrawals=[{eventId:hash('withdrawal-event'),cursor,knownAt:i.availabilityCut,evidenceIds:[hash('withdrawal')],removable:'verified',authorizedRemover:seller,authorityVerified:true,
  responsibility:authority(i,'non_operator'),preInventoryUsd:rational(500),remainingInventoryUsd:rational(5),preTokenWideSell2:rational(100),postTokenWideSell2:rational(10),
  routeDiscoveryComplete:true,successor:'absent',successorObservedThrough:at(i,1660)}];
 let r=labels(i);expect(fact(r,'rug').qualification).toBe('qualified');expect(fact(r,'rug').attribution).toBe('non_operator');expect(fact(r,'rug').status).toBe('confirmed_under_policy');expect(fact(r,'rug').historyEligible).toBe(false);
 i.withdrawals[0].successor='equivalent_reachable';expect(fact(labels(i),'rug').qualification).toBe('not_qualified');
 i.withdrawals[0].successor='unknown';expect(fact(labels(i),'rug').qualification).toBe('unknown');
 i.withdrawals[0].successor='absent';i.withdrawals[0].successorObservedThrough=at(i,1600);expect(fact(labels(i),'rug').qualification).toBe('unknown');
 i.withdrawals[0].removable='nonwithdrawable';expect(fact(labels(i),'rug').qualification).toBe('not_qualified');
});
it('reproduces pinned token restrictions independently, separating immutable restriction from unresolved issuer',()=>{
 const i=outcomeFixture();i.restrictions=[{eventId:hash('restriction-event'),cursor:at(i,1060),knownAt:i.availabilityCut,evidenceIds:[hash('restriction')],wallet:buyer,sizeUsd:100,accountClass:'eoa',routeId:'fixture-curve',
  failure:'token_enforced',independentlyReproduced:true,temporaryResolved:true,responsibility:null}];
 expect(fact(labels(i),'restriction').qualification).toBe('qualified');expect(fact(labels(i),'restriction').status).toBe('indeterminate');
 i.restrictions[0].responsibility=authority(i,'exercised_configuration');expect(fact(labels(i),'restriction').attribution).toBe('operator');
 i.restrictions[0].temporaryResolved=false;expect(fact(labels(i),'restriction').qualification).toBe('unknown');
 i.restrictions[0].temporaryResolved=true;i.restrictions[0].failure='provider';expect(fact(labels(i),'restriction').qualification).toBe('not_qualified');
});
it('retains recovered collapse and earliest ties; a no-selling literal requires complete swaps/transfers/actors and zero linked sales',()=>{
 const i=outcomeFixture();
 for(const c of i.checkpoints.filter(c=>c.sizeUsd===100))c.netQuote=rational(Number(c.cursor.timestampSec)===1120?10:100);
 let r=labels(i),details=fact(r,'collapse').details as {drawdownPct:{numerator:string;denominator:string};horizonValue:unknown;withoutObservedOperatorOrLaunchLinkedSelling:boolean;peak:{cursor:unknown};trough:{cursor:unknown}};
 expect(fact(r,'collapse').qualification).toBe('qualified');expect(details.horizonValue).toEqual(rational(100));expect(details.peak.cursor).toEqual(at(i,1000));expect(details.trough.cursor).toEqual(at(i,1120));
 expect(details.withoutObservedOperatorOrLaunchLinkedSelling).toBe(true);expect(fact(r,'survived').qualification).toBe('not_qualified');expect(fact(r,'collapse').historyEligible).toBe(false);
 i.selling.actorsComplete=false;expect((fact(labels(i),'collapse').details as typeof details).withoutObservedOperatorOrLaunchLinkedSelling).toBe(false);
 i.selling.actorsComplete=true;i.selling.sales=[{cursor:at(i,1060),knownAt:i.availabilityCut,evidenceIds:[hash('linked-sale')],units:'1',operatorOrLaunchLinked:true}];
 expect((fact(labels(i),'collapse').details as typeof details).withoutObservedOperatorOrLaunchLinkedSelling).toBe(false);
 i.selling.sales[0].operatorOrLaunchLinked=null;expect((fact(labels(i),'collapse').details as typeof details).withoutObservedOperatorOrLaunchLinkedSelling).toBe(false);
});
it('never survives an immature, missing, provider-censored, unsupported or wrong-quantity benchmark',()=>{
 const i=outcomeFixture();
 i.checkpoints=i.checkpoints.filter(c=>!(c.sizeUsd===1000&&c.cursor.blockNumber===at(i,1120).blockNumber));
 expect(fact(labels(i),'survived').status).toBe('censored');expect(fact(labels(i),'survived').qualification).toBe('unknown');
 const missing=outcomeFixture();missing.entries=[];missing.checkpoints=[];expect(fact(labels(missing),'survived').status).toBe('censored');
 const provider=outcomeFixture();provider.checkpoints[4].status='provider_unavailable';provider.checkpoints[4].netQuote=null;expect(fact(labels(provider),'survived').status).toBe('censored');
 const wrong=outcomeFixture();wrong.checkpoints[4].quantity='1';expect(fact(labels(wrong),'survived').qualification).toBe('unknown');
 const archive=outcomeFixture();archive.coverage.archive=false;expect(fact(labels(archive),'survived').status).toBe('censored');
 const immature=outcomeFixture();immature.boundaries=immature.boundaries.slice(0,4);immature.entries=[];immature.checkpoints=[];immature.availabilityCut={cursor:immature.boundaries.at(-1)!.cursor,acquisitionSequence:'2'};
 expect(fact(evaluateOutcomeLabels(immature,immature.availabilityCut,true),'survived').status).toBe('provisional');
});
it('rejects same-second future evidence and incomplete block chains; ignores after-horizon events',()=>{
 const i=outcomeFixture();i.checkpoints[0].knownAt={...i.availabilityCut,acquisitionSequence:'3'};expect(()=>labels(i)).toThrow('availability cut');
 const bad=outcomeFixture();bad.boundaries[3].parentHash=hash('wrong-parent');expect(()=>labels(bad)).toThrow('prefix');
 const late=outcomeFixture(),last=late.boundaries.at(-1)!.cursor,next=confirmation(late).cursor;
 late.boundaries.push({cursor:next,parentHash:last.blockHash as `0x${string}`});late.availabilityCut={cursor:next,acquisitionSequence:'3'};
 late.restrictions=[{eventId:hash('late-restriction-event'),cursor:next,knownAt:late.availabilityCut,evidenceIds:[hash('late-restriction')],wallet:buyer,sizeUsd:100,accountClass:'eoa',routeId:'fixture-curve',failure:'token_enforced',independentlyReproduced:true,temporaryResolved:true,responsibility:null}];
 expect(fact(labels(late),'restriction').qualification).toBe('not_qualified');expect(fact(labels(late),'survived').qualification).toBe('qualified');
});
