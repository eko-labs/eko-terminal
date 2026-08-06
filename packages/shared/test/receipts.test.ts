import { describe, expect, it } from 'vitest';
import { createReceiptEncoder, ReceiptItemSchema, RECEIPT_KIND_IDS, Bytes32Schema } from '../src/index.js';
import type { ReceiptItem } from '../src/index.js';
import fixture from './fixtures/receipts/v1.json';

// Test adapter only: use the repo's already-installed viem without changing package manifests.
import { receiptHashing as viem } from './viem-adapter.mjs';
const encoder = createReceiptEncoder(viem);
const items = fixture.items.map((item) => ReceiptItemSchema.parse(item));
const proofs = fixture.proofs.map((proof) => proof.map((node) => Bytes32Schema.parse(node)));
const root = Bytes32Schema.parse(fixture.root);

describe('receipt leaf and Merkle fixtures (BACKEND §13)', () => {
  it('freezes kind numbers, exact UTF-8 ids, and ABI double hashing', () => {
    expect(RECEIPT_KIND_IDS).toEqual(fixture.kindIds);
    expect(fixture.leafEncoding).toEqual(['uint8', 'bytes32', 'bytes32']);
    for (const [index, item] of items.entries()) {
      expect(encoder.receiptItemId(item.id)).toBe(fixture.items[index]!.itemId);
      expect(encoder.encodeReceiptLeaf(item)).toBe(fixture.items[index]!.leaf);
    }
    expect(encoder.receiptItemId('é')).toBe(viem.keccak256(viem.stringToHex('é')));
    expect(encoder.receiptItemId('id')).not.toBe(encoder.receiptItemId('id '));
  });
  it('reproduces the 3-leaf StandardMerkleTree root and proofs', () => {
    const tree = encoder.buildReceiptTree(items);
    expect(tree.root).toBe(root);
    expect(tree.leaves).toEqual(fixture.items.map((item) => item.leaf));
    expect(tree.proofs).toEqual(proofs);
    for (const [index, item] of items.entries()) expect(encoder.verifyReceiptProof(item, proofs[index]!, root)).toBe(true);
    expect(encoder.buildReceiptTree([...items].reverse()).root).toBe(root);
  });
  it('detects tampered ids, kinds, payloads, roots, proofs and malformed nodes', () => {
    for (const [index, item] of items.entries()) {
      const proof = proofs[index]!;
      for (const changed of [{ ...item, id: item.id + 'x' }, { ...item, kind: item.kind === 'verdict' ? 'forecast' : 'verdict' }, { ...item, hash: '0x' + '00'.repeat(32) }]) {
        expect(encoder.verifyReceiptProof(changed as ReceiptItem, proof, root)).toBe(false);
      }
      expect(encoder.verifyReceiptProof(item, [...proof, root], root)).toBe(false);
      expect(encoder.verifyReceiptProof(item, proof.slice(1), root)).toBe(false);
      expect(encoder.verifyReceiptProof(item, proof, Bytes32Schema.parse('0x' + '00'.repeat(32)))).toBe(false);
      expect(encoder.verifyReceiptProof(item, ['0x12'], root)).toBe(false);
    }
    expect(() => encoder.encodeReceiptLeaf({ ...items[0]!, hash: '0x12' })).toThrow();
  });
  it('handles singleton, odd, even and duplicate leaves without mutating inputs', () => {
    expect(() => encoder.buildReceiptTree([])).toThrow();
    for (const count of [1, 2, 4, 5, 7, 8]) {
      const input = Array.from({ length: count }, (_, i) => ({ ...items[i % 3]!, id: `batch:${i}` }));
      const before = JSON.stringify(input);
      const tree = encoder.buildReceiptTree(input);
      input.forEach((item, i) => expect(encoder.verifyReceiptProof(item, tree.proofs[i]!, tree.root)).toBe(true));
      expect(JSON.stringify(input)).toBe(before);
      expect(encoder.buildReceiptTree([...input].reverse()).root).toBe(tree.root);
    }
    const singleton = encoder.buildReceiptTree([items[0]!]);
    expect(singleton.root).toBe(encoder.encodeReceiptLeaf(items[0]!));
    expect(singleton.proofs).toEqual([[]]);
    const duplicates = encoder.buildReceiptTree([items[0]!, items[0]!]);
    expect(encoder.verifyReceiptProof(items[0]!, duplicates.proofs[0]!, duplicates.root)).toBe(true);
    expect(encoder.hashReceiptPair(root, singleton.root)).toBe(encoder.hashReceiptPair(singleton.root, root));
  });
});
