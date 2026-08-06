// Cross-check: our pure receipt encoder must give the same root, leaves and proofs as OpenZeppelin's
// StandardMerkleTree (the reference the on-chain MerkleProof check is written against, BACKEND §13).
// The library is a devDependency only; runtime code stays dependency-free.
import { describe, expect, it } from 'vitest';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { createReceiptEncoder, RECEIPT_KIND_IDS } from '../src/index.js';
import type { ReceiptItem } from '../src/index.js';
import { receiptHashing as viem } from './viem-adapter.mjs';

const encoder = createReceiptEncoder(viem);
const kinds = Object.keys(RECEIPT_KIND_IDS) as ReceiptItem['kind'][];

function batch(n: number, seed: number): ReceiptItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `rcpt-${seed}-${i}`,
    kind: kinds[(i + seed) % kinds.length]!,
    hash: viem.keccak256(viem.stringToHex(`payload-${seed}-${i}`)),
  }));
}

describe('receipt tree matches StandardMerkleTree', () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 64, 100]) {
    it(`${n} item${n === 1 ? '' : 's'}`, () => {
      const items = batch(n, n);
      const values = items.map((item) => [RECEIPT_KIND_IDS[item.kind], encoder.receiptItemId(item.id), item.hash]);
      const oz = StandardMerkleTree.of(values, ['uint8', 'bytes32', 'bytes32']);
      const ours = encoder.buildReceiptTree(items);
      expect(ours.root).toBe(oz.root);
      items.forEach((item, i) => {
        expect(ours.leaves[i]).toBe(oz.leafHash(values[i]!));
        expect(ours.proofs[i]).toEqual(oz.getProof(i));
        expect(StandardMerkleTree.verify(ours.root, ['uint8', 'bytes32', 'bytes32'], values[i]!, ours.proofs[i]!)).toBe(true);
      });
    });
  }
});
