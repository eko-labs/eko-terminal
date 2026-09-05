// Synthetic compatibility vectors only. Regenerate explicitly; tests consume
// the checked-in JSON, never freshly generated expected hashes.
import { writeFile } from 'node:fs/promises';
import { concat, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { canonicalize, createGuardReceiptCodec, guardDecisionBody, guardReceiptRevisionKey, GuardReceiptPayloadSchema, RECEIPT_KIND_IDS } from '@eko/shared';
import type { GuardScoreInput, ReceiptItem } from '@eko/shared';
import { evaluateGuardV2 } from '../../playbooks/src/index.js';
import { input, observation, hash } from '../../playbooks/test/scoring-fixtures.js';
import v1 from '../../shared/test/fixtures/contracts/v1.json' with { type: 'json' };

const codec = createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex});
const recordedAt = '2026-10-02T00:00:00.000Z';
const vectors: {case:string;id:string;kind:ReceiptItem['kind'];hash:`0x${string}`;payload:unknown;canonicalPayload:string;itemId:`0x${string}`;leaf:`0x${string}`}[]=[];
function add(label:string,id:string,kind:ReceiptItem['kind'],payload:unknown) {
  const item={id,kind,hash:codec.hash(payload)};
  vectors.push({...item,case:label,payload,canonicalPayload:canonicalize(payload),itemId:codec.receiptItemId(id),leaf:codec.encodeReceiptLeaf(item)});
}
add('v1-verdict','legacy:verdict:fixture','verdict',v1.Verdict);
add('v1-forecast','legacy:forecast:fixture','forecast',{schemaVersion:'forecast-1',probability:0.25,windowSec:3600});
add('private-domain','legacy:private:fixture','harness_private',{salt:'synthetic-public-vector',journalDigest:hash(90)});
function v2(label:string,raw:GuardScoreInput,supersedes:string|null=null) {
  raw.historySource=null;raw.checks=[];
  const result=evaluateGuardV2(raw), {receipt:_,...decision}=result.assessment;
  decision.supersedes=supersedes;
  decision.decisionHash=codec.hash(guardDecisionBody(decision));
  const key=guardReceiptRevisionKey(decision,hash(80),hash(81),{routeId:null,sizeUsd:'100',accountClass:'eoa'});
  const revisionId=codec.hash(key), receiptId=`guard:${revisionId}`;
  const payload=GuardReceiptPayloadSchema.parse({schemaVersion:'guard-receipt-2',canonicalization:'jcs-rfc8785/v1',kind:'verdict',
    receiptId,revisionId,revisionKey:key,recordedAt,deterministicInput:result.deterministicInput,decision});
  add(label,receiptId,'verdict',payload);
  return revisionId;
}
const old=v2('rounded-below-threshold',input([observation('execution_cost','9.999')]));
v2('exact-threshold',input([observation('execution_cost','10')]));
v2('observed-zero',input([observation('execution_cost','0')]));
v2('unknown',input());
const correction=input([observation('execution_cost','10')]);
// Replace every full cursor at the corrected block, including predicate proof/coverage.
function fork(value:unknown):void {
  if(!value || typeof value!=='object')return;
  if('blockNumber' in value && value.blockNumber===correction.cursor.blockNumber && 'blockHash' in value) value.blockHash=hash(99);
  for(const child of Object.values(value))fork(child);
}
fork(correction);
v2('reorg-correction',correction,old);
const tree=codec.buildReceiptTree(vectors);
await writeFile(new URL('../../shared/test/fixtures/receipts/guard-v2.json',import.meta.url),JSON.stringify({
  provenance:'Synthetic fixture; no measured chain validation or release',canonicalization:'jcs-rfc8785/v1',
  leafEncoding:['uint8','bytes32','bytes32'],kindIds:RECEIPT_KIND_IDS,items:vectors,root:tree.root,proofs:tree.proofs,
},null,2)+'\n');
