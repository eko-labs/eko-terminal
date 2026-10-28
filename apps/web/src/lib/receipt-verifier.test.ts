import { describe, expect, it } from 'vitest';
import { ReceiptItemSchema, Bytes32Schema } from '@eko/shared';
import legacy from '../../../../packages/shared/test/fixtures/receipts/v1.json';
import current from '../../../../packages/shared/test/fixtures/receipts/guard-v2.json';
import { receiptVerifier } from './receipt-verifier';

describe('browser V1/V2 receipt compatibility',()=>{
  it('keeps original V1 leaves and checks every mixed raw-payload fixture',()=>{
    for(const [i,item] of legacy.items.entries()) expect(receiptVerifier.verifyReceiptProof(ReceiptItemSchema.parse(item),legacy.proofs[i]!.map(n=>Bytes32Schema.parse(n)),Bytes32Schema.parse(legacy.root))).toBe(true);
    for(const [i,item] of current.items.entries()) {
      expect(receiptVerifier.verifyPublicProof(item.payload,ReceiptItemSchema.parse(item),current.proofs[i]!.map(n=>Bytes32Schema.parse(n)),Bytes32Schema.parse(current.root))).toBe(true);
      expect(receiptVerifier.verifyPublicProof({...item.payload,displayLabel:'new card'},ReceiptItemSchema.parse(item),current.proofs[i]!.map(n=>Bytes32Schema.parse(n)),Bytes32Schema.parse(current.root))).toBe(false);
    }
  });
});
