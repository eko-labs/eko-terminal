import type { AvailabilityCut, GuardCursor } from '@eko/shared';
import type { CampaignReplayInput } from '@eko/chain';
import type { OutcomeLabelInput } from '../src/outcome-labels.js';
import type { OutcomeResponsibility } from '../src/outcome-input.js';
import { block, seller } from '../../../packages/chain/test/campaign-fixtures.js';
import { address, hash } from '../../../packages/chain/test/reference-fixtures.js';
export const rational=(v:number)=>({numerator:String(v),denominator:'1'});
export function outcomeFixture(campaign?:CampaignReplayInput,horizonSec:3600|86400|604800=3600):OutcomeLabelInput {
 const launchCursor=block(98,940), cursors=[launchCursor,block(99,999),...(campaign?.blocks.map(b=>b.cursor)??[block(100,1000)])];
 while(BigInt(cursors.at(-1)!.timestampSec)<940n+BigInt(horizonSec)) {
  const last=cursors.at(-1)!;cursors.push(block(Number(last.blockNumber)+1,Number(last.timestampSec)+60));
 }
 const availabilityCut={cursor:cursors.at(-1)!,acquisitionSequence:'2'},entry=cursors.find(c=>BigInt(c.timestampSec)>=1000n)!;
 return {schemaVersion:'outcome-input-1',origin:'fixture',coin:address(10),eventId:hash('outcome-event'),outcomeVersion:'2.0.0',identityVersion:'1.0.0',
  horizonSec,replayMode:'production',availabilityCut,launchCursor,accountClass:'eoa',quoteAsset:address(11),quoteDecimals:0,
  boundaries:cursors.map((cursor,k)=>({cursor,parentHash:k?cursors[k-1].blockHash as `0x${string}`:null})),relevantBoundaries:[],
  entries:([100,1000] as const).map(sizeUsd=>({sizeUsd,quantity:String(sizeUsd*100),inputQuote:rational(sizeUsd),spentQuote:rational(sizeUsd),gasQuote:rational(0),independentlyVerified:true,fidelityAccepted:false,status:'purchased',cursor:entry,knownAt:availabilityCut,evidenceIds:[hash('benchmark-entry')]})),
  checkpoints:cursors.filter(c=>BigInt(c.timestampSec)>=1000n).flatMap(cursor=>([100,1000] as const).map(sizeUsd=>({sizeUsd,quantity:String(sizeUsd*100),cursor,knownAt:availabilityCut,
   evidenceIds:[hash(`benchmark-${sizeUsd}-${cursor.blockNumber}`)],routeId:'fixture-curve',quoteAsset:address(11),quoteDecimals:0,status:'executed',netQuote:rational(sizeUsd*8/10),independentlyVerified:true,fidelityAccepted:false}))),
  coverage:{events:true,controls:true,routes:true,checkpoints:true,archive:true},campaigns:campaign?[{eventId:hash('campaign-outcome-event'),input:campaign,responsibility:null,calibrated:false}]:[],
  withdrawals:[],restrictions:[],selling:{swapsComplete:true,transfersComplete:true,actorsComplete:true,sales:[]},calibrated:false,dependencyIds:[hash('outcome-dependency')],evidenceIds:[hash('outcome-evidence')]};
}
export function confirmation(i:OutcomeLabelInput,seconds=30):AvailabilityCut {
 const c=i.boundaries.at(-1)!.cursor;return {cursor:block(Number(c.blockNumber)+1,Number(c.timestampSec)+seconds),acquisitionSequence:'3'};
}
export function authority(i:OutcomeLabelInput,kind:OutcomeResponsibility['kind']='authenticated_control'):OutcomeResponsibility {
 return {kind,actor:seller,saleActors:[seller],operatorGroupId:hash('operator-component'),effectiveFrom:i.launchCursor,effectiveThrough:null,
  knownAt:{cursor:i.launchCursor,acquisitionSequence:'0'},reviewed:true,precisionAccepted:true,evidenceIds:[hash('authority-proof')]};
}
export function at(i:OutcomeLabelInput,time:number):GuardCursor {return i.boundaries.find(b=>Number(b.cursor.timestampSec)>=time)!.cursor;}
