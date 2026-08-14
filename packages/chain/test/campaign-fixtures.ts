import type { GuardCursor } from '@eko/shared';
import { applyPonsCampaignTransaction, campaignStateHash, type CampaignReplayInput, type CampaignState, type CampaignLeg, type CampaignTransaction } from '../src/index.js';
import { address, hash } from './reference-fixtures.js';
export const seller=address(21),buyer=address(22),duringBuyer=address(23),collector=address(24);
export const block=(number:number,time:number):GuardCursor & {blockHash:`0x${string}`}=>({chainId:4663,blockNumber:String(number),blockHash:hash(`campaign-block-${number}`),timestampSec:String(time),boundary:'block_end',transactionIndex:null,executionOrdinal:null});
export const emptyFees=()=>({buy:[],sell:[],overrides:[]});
export const state=():CampaignState=>({curve:{tokens:'1000000',realQuote:'1000',virtualQuote:'100',reservedTokens:'100'},fees:emptyFees(),
 wallets:[{account:seller,quote:'100000',token:'500000',allowance:'500000'},{account:buyer,quote:'100000',token:'100000',allowance:'100000'},{account:duringBuyer,quote:'100000',token:'0',allowance:'1000000'}],
 lots:[{id:hash('side-opening'),owner:seller,origin:seller,units:'500000',cost:null,payer:null},{id:hash('outside-opening'),owner:buyer,origin:buyer,units:'100000',cost:{numerator:'100',denominator:'1'},payer:buyer}]});
export const sell=(name:string,units='375000'):CampaignLeg=>({kind:'sell',id:hash(name),economicId:null,account:seller,recipient:seller,input:units,minimumOutput:'0',deadlineSec:'999999',executable:'supported',pressureFraction:{numerator:'1',denominator:'1'}});
export const buy=(name:string,account=duringBuyer,input='100'):CampaignLeg=>({kind:'buy',id:hash(name),economicId:null,account,recipient:account,input,minimumOutput:'0',deadlineSec:'999999',executable:'supported'});
export function fixture(groups:CampaignLeg[][]=[ [sell('sale')] ],times=[1000],opening=state(),start=0):CampaignReplayInput {
 let current=structuredClone(opening),previous=block(99,999);
 const blocks=groups.map((legs,k)=>{
  const cursor=block(100+k,times[k]),tx:CampaignTransaction={id:hash(`campaign-tx-${k}`),index:0,gasPayer:seller,gasQuote:'0',gasRecipient:collector,expectedStateHash:hash('pending'),legs};
  current=applyPonsCampaignTransaction(current,tx,cursor.timestampSec);tx.expectedStateHash=campaignStateHash(current);
  const out={cursor,parentHash:previous.blockHash as `0x${string}`,transactions:[tx]};previous=cursor;return out;
 });
 return {methodVersion:'campaign-replay-1',origin:'fixture',coin:address(10),quoteAsset:address(11),quoteDecimals:0,knownAt:{cursor:blocks.at(-1)!.cursor,acquisitionSequence:'1'},
 checkpoint:{cursor:block(99,999),state:opening,stateHash:campaignStateHash(opening),evidenceIds:[hash('parent-checkpoint')]},blocks,
 campaign:{from:{...blocks[start].cursor,boundary:'before_tx',transactionIndex:0,executionOrdinal:0},through:blocks.at(-1)!.cursor,
 saleIds:groups.slice(start).flat().filter(l=>l.kind==='sell'&&l.account===seller).map(l=>l.id),sellingSide:[seller],openingFloat:'100000000',quoteUsd:{numerator:'1',denominator:'1'},
 totalCost:{before:{numerator:'100',denominator:'1'},during:null},closeLiquidationGasQuote:'0',liquidationAccounts:[buyer,duringBuyer],coverageComplete:true,routeReviewed:true,fidelityAccepted:false,
 profileHash:hash('synthetic-profile'),evidenceIds:[hash('synthetic-campaign')]}};
}
