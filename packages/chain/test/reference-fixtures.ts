import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import type { GuardCursor } from '@eko/shared';
import type { ReferenceInput, DeepEvidence, ForkMatch } from '../src/simulation/types.js';
import type { ReferenceRoute } from '../src/simulation/v3.js';
export const address=(n:number):Address=>`0x${n.toString(16).padStart(40,'0')}`;
export const hash=(s:string):Hex=>keccak256(stringToHex(s));
export const cursor:GuardCursor={chainId:4663,blockNumber:'100',blockHash:hash('synthetic-block'),timestampSec:'1000',boundary:'block_end',transactionIndex:null,executionOrdinal:null};
export const route:ReferenceRoute={venue:'uniswap_v3',id:'fixture-v3',coin:address(10),router:address(11),quoter:address(12),weth:address(13),fee:3000,deadline:10000n,
  verification:{blockHash:cursor.blockHash as Hex,evidenceIds:[hash('fixture-route')]},entryLimitSelectors:['0x12345678'],cooldown:{seconds:3,evidenceIds:[hash('fixture-cooldown')]}};
export const matches=(sizeUsd:100|1000|10000=100):ForkMatch[]=>['eoa','contract'].flatMap(accountClass=>Array.from({length:30},(_,i)=>({
  id:hash(`synthetic-match:${sizeUsd}:${accountClass}:${i}`),venue:'uniswap_v3',sizeUsd,accountClass:accountClass as 'eoa'|'contract',caseId:`synthetic-${i}`,
  expectedSpent:'1000',actualSpent:'1000',expectedReturned:'990',actualReturned:'990',expectedBlocked:false,actualBlocked:false,
})));
export const input:ReferenceInput={cursor,sizeUsd:100,sizeWei:1000n,route,matches:matches()};
export const deep=(changes:Partial<DeepEvidence>={}):DeepEvidence[]=>[20,21].map(n=>({account:address(n),blockHash:cursor.blockHash as Hex,allowanceBefore:'0',delaySec:3,
  validSellState:true,trace:{fixture:'synthetic'},tokens:'1000',spent:'1000',returned:'990',quotedBuy:'1000',quotedSell:'990',buyOk:true,sellOk:true,revert:'0x',...changes}));
export const probeOutput=(tokens=1000n,quotedSell=990n,returned=990n,buyOk=true,sellOk=true,revert:Hex='0x')=>encodeAbiParameters(
  [{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'bool'},{type:'bool'},{type:'bytes'}],
  [tokens,quotedSell,returned,buyOk?1000n:0n,buyOk,sellOk,revert]);
