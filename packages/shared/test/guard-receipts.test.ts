import { describe, expect, it } from 'vitest';
import { canonicalize, createGuardReceiptCodec, Bytes32Schema, ReceiptItemSchema, GuardReceiptPayloadSchema, TRACE_RETENTION_SEC, RECEIPT_BATCH_INTERVAL_SEC } from '../src/index.js';
import { receiptHashing } from './viem-adapter.mjs';
import fixture from './fixtures/receipts/guard-v2.json';

const codec=createGuardReceiptCodec(receiptHashing);
const items=fixture.items.map(i=>ReceiptItemSchema.parse(i));
const vector=(name:string)=>fixture.items.find(i=>i.case===name)!;
const payload=(name:string)=>GuardReceiptPayloadSchema.parse(vector(name).payload);
describe('034 raw hashes and shared proof vectors (synthetic)',()=>{
  it('reproduces JCS, payloads, exact leaf domains and the mixed batch',()=>{
    expect(RECEIPT_BATCH_INTERVAL_SEC).toBe(300);expect(TRACE_RETENTION_SEC).toBe(2592000);
    expect(codec.buildReceiptTree(items)).toEqual({root:fixture.root,leaves:fixture.items.map(i=>i.leaf),proofs:fixture.proofs});
    for(const [i,item] of fixture.items.entries()) {
      expect(canonicalize(item.payload)).toBe(item.canonicalPayload);
      expect(codec.receiptItemId(item.id)).toBe(item.itemId);
      expect(codec.verifyPublicProof(item.payload,items[i]!,fixture.proofs[i]!.map(n=>Bytes32Schema.parse(n)),Bytes32Schema.parse(fixture.root))).toBe(true);
    }
  });
  it('hashes raw threshold crossings even when formatted values match',()=>{
    const below=payload('rounded-below-threshold'), equal=payload('exact-threshold');
    expect(Number(below.decision.reasons.find(r=>r.code==='EXIT_COST')!.parameters.costPct).toFixed(2)).toBe(Number(equal.decision.reasons.find(r=>r.code==='EXIT_COST')!.parameters.costPct).toFixed(2));
    expect(below.decision.familyPoints.E).toBe(10);expect(equal.decision.familyPoints.E).toBe(20);
    expect(below.decision.snapshotHash).not.toBe(equal.decision.snapshotHash);expect(below.decision.decisionHash).not.toBe(equal.decision.decisionHash);
    const rounded=JSON.parse(JSON.stringify(below).replaceAll('9.999','10'));
    expect(codec.verifyPayload(rounded,ReceiptItemSchema.parse(vector('rounded-below-threshold')))).toBe(false);
  });
  it('separates observed zero from unknown and retains original reorg payload',()=>{
    const zero=payload('observed-zero'),unknown=payload('unknown'),old=payload('rounded-below-threshold'),correction=payload('reorg-correction');
    expect(zero.decision.factors.find(f=>f.id==='execution_cost')!.state).toBe('not_matched');
    expect(unknown.decision.factors.find(f=>f.id==='execution_cost')!.state).toBe('unknown');
    expect(zero.decision.snapshotHash).not.toBe(unknown.decision.snapshotHash);
    expect(correction.decision.cursor.blockNumber).toBe(old.decision.cursor.blockNumber);
    expect(correction.decision.cursor.blockHash).not.toBe(old.decision.cursor.blockHash);
    expect(correction.decision.supersedes).toBe(old.revisionId);
    expect(codec.verifyPayload(old,ReceiptItemSchema.parse(vector('rounded-below-threshold')))).toBe(true);
  });
  it('does not recursively hash metadata or silently accept dishonest inner hashes',()=>{
    const original=payload('exact-threshold'),item=ReceiptItemSchema.parse(vector('exact-threshold'));
    expect(original.decision).not.toHaveProperty('receipt');expect(original).not.toHaveProperty('root');
    expect(codec.verifyPayload({...original,txHash:fixture.root},item)).toBe(false);
    const drift={...original,decision:{...original.decision,snapshotHash:fixture.root}};
    expect(codec.verifyPayload(drift,{...item,hash:codec.hash(drift)})).toBe(false);
    const revisedTime={...original,recordedAt:'2026-10-02T00:00:01.000Z'};
    expect(codec.hash(revisedTime)).not.toBe(item.hash);expect(revisedTime.decision.decisionHash).toBe(original.decision.decisionHash);
  });
});
