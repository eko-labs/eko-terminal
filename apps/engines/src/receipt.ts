import type { PublicReceiptPayload, Verdict } from '@eko/shared';
import type { Hex } from 'viem';
import { RULES_VERSION } from '@eko/playbooks';
import { digest } from './card.js';
import type { LoadedSources } from './sources.js';

/** Capture rule inputs, including missing values, before assembleCard rounds
 * presentation. Bigints become exact decimal strings, never JSON numbers. */
export function verdictReceipt(s:LoadedSources, verdict:Verdict, blockHash:Hex|null, supersedes:string|null, recordedAt:string, priceObservation?:{price:number|null;peak:number|null;previousFullPrice:number|null}):PublicReceiptPayload {
  const keys = ['coin','deployer','asOfBlock','asOfSec','createdAtSec','createdAtBlock','launchpad','name','symbol',
    'antiSnipeActive','simulations','taxes','liquidity','pools','curve','wash','trending','dominantPair','pons',
    'earlyBuyers','graduation','hook','tokenText','history','supply','profile','sectionBlocks','attributionCoverage'] as const;
  // The prune-time Danger floor is an input only for coins that have one, so every other receipt keeps its shape.
  const deterministicInput=JSON.parse(JSON.stringify({...Object.fromEntries(keys.map(k=>[k,s[k] ?? null])),...(priceObservation ? {priceObservation} : {}),...(s.dangerBeforePrune ? {dangerBeforePrune:s.dangerBeforePrune} : {})},
    (_key,value:unknown)=>{
      if(typeof value==='number' && !Number.isFinite(value)) throw new Error('Nonfinite raw receipt input');
      return typeof value==='bigint' ? String(value) : value;
    }));
  const {receipt:_,...decision}=verdict;
  const snapshotHash=digest(deterministicInput);
  // TODO(spec): the legacy CoinCard has no frozen schema literal; name its
  // existing unversioned shape explicitly until a card schema version is frozen.
  const cardSchemaVersion='legacy-coin-card/unversioned';
  const revisionId=digest({snapshotHash,decision,blockHash,cardSchemaVersion});
  return {schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:`verdict:${revisionId}`,revisionId:`verdict:${revisionId}`,
    kind:'verdict',chainId:4663,coin:s.coin,recordedAt,modelIds:[],personaSetVersion:null,cardSchemaVersion,
    rulesVersion:RULES_VERSION,outputSchemaVersion:verdict.schemaVersion,snapshotHash,deterministicInput,decision,
    window:{kind:'snapshot',blockNumber:s.asOfBlock,blockHash},supersedes,reorgOf:null};
}
