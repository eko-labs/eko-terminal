import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { canonicalize, ReceiptLookupSchema } from '@eko/shared';
import legacy from '../../shared/test/fixtures/receipts/v1.json';
import current from '../../shared/test/fixtures/receipts/guard-v2.json';
import publishedAbi from '../../chain/abi/eko/ReceiptsRegistry.json';
import { receiptVerifier, receiptsRegistryAbi, verifyReceipt, type RegistryReader } from '../src/index';

const registry = `0x${'ab'.repeat(20)}` as Address, committer = `0x${'cd'.repeat(20)}` as Address;
const txHash = `0x${'12'.repeat(32)}` as Hex, blockHash = `0x${'34'.repeat(32)}` as Hex;
const other = `0x${'56'.repeat(32)}` as Hex;
function setup() {
  const item = current.items[0]!;
  const receipt = ReceiptLookupSchema.parse({ id: item.id, kind: item.kind, hash: item.hash, leaf: item.leaf,
    canonicalization: 'jcs-rfc8785/v1', status: 'anchored', merkleRoot: current.root, proof: current.proofs[0],
    batchId: 1, txHash, block: 100, blockHash, registry, chainId: 4663, logIndex: 2,
    revealed: item.payload, canonicalPayload: canonicalize(item.payload) });
  if (receipt.status !== 'anchored') throw new Error('Expected anchored fixture');
  const log = { address: registry, logIndex: 2, removed: false,
    topics: encodeEventTopics({ abi: receiptsRegistryAbi, eventName: 'BatchCommitted', args: { batchId: 1n, root: current.root as Hex, committer } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint32' }], [current.items.length]) };
  const transaction = { status: 'success', transactionHash: txHash, blockNumber: 100n, blockHash, logs: [log] };
  const batch = { root: current.root as Hex, leafCount: current.items.length, committedAt: 123n, committer };
  const reader = {
    getChainId: vi.fn(async () => 4663), getBlock: vi.fn(async () => ({ hash: blockHash })),
    getTransactionReceipt: vi.fn(async () => transaction), readContract: vi.fn(async () => batch),
  } satisfies RegistryReader;
  return { receipt, reader, log, transaction, batch };
}
describe('browser verifier', () => {
  it('packages exactly the published ABI and checks the exact historical registry batch', async () => {
    expect(receiptsRegistryAbi).toEqual(publishedAbi);
    const { receipt, reader } = setup();
    expect((await verifyReceipt(receipt, registry, reader)).status).toBe('verified');
    expect(reader.readContract).toHaveBeenCalledWith({ address: registry, abi: publishedAbi, functionName: 'batch', args: [1n], blockNumber: 100n });
  });
  it('keeps every V1 and V2 fixture leaf/proof and the raw V2 payloads', () => {
    for (const fixture of [legacy, current]) for (const [i, item] of fixture.items.entries()) {
      expect(receiptVerifier.encodeReceiptLeaf(item as Parameters<typeof receiptVerifier.encodeReceiptLeaf>[0])).toBe(item.leaf);
      expect(receiptVerifier.verifyReceiptProof(item as Parameters<typeof receiptVerifier.verifyReceiptProof>[0], fixture.proofs[i] as Hex[], fixture.root as Hex)).toBe(true);
      if ('payload' in item) expect(receiptVerifier.verifyPayload(item.payload, item as Parameters<typeof receiptVerifier.verifyPayload>[1])).toBe(true);
    }
  });
  it.each(['payload', 'canonical', 'hash', 'leaf', 'id', 'kind', 'version'])('fails step 1 for tampered %s, with no RPC reads', async stage => {
    const { receipt, reader } = setup();
    const edits = { payload: { revealed: { modified: true } }, canonical: { canonicalPayload: '{}' }, hash: { hash: other }, leaf: { leaf: other }, id: { id: 'changed-id' }, kind: { kind: 'forecast' }, version: { canonicalization: 'unknown' } };
    const result = await verifyReceipt({ ...receipt, ...edits[stage as keyof typeof edits] }, registry, reader);
    expect(result.steps.map(s => s.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(reader.getChainId).not.toHaveBeenCalled();
  });
  it.each(['proof', 'root'])('fails step 2 for tampered %s', async stage => {
    const { receipt, reader } = setup();
    const result = await verifyReceipt({ ...receipt, ...(stage === 'proof' ? { proof: [other] } : { merkleRoot: other }) }, registry, reader);
    expect(result.steps.map(s => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(reader.getChainId).not.toHaveBeenCalled();
  });
  it.each(['batch', 'tx', 'registry', 'chain', 'block', 'blockHash', 'logIndex', 'removed', 'emitter', 'root', 'leafCount', 'committer', 'reverted', 'duplicate', 'event'])('fails step 3 for swapped/tampered %s', async stage => {
    const { receipt, reader, log, transaction, batch } = setup();
    const changed = { ...receipt };
    if (stage === 'batch') changed.batchId = 2;
    if (stage === 'tx') changed.txHash = other;
    if (stage === 'registry') changed.registry = committer;
    if (stage === 'chain') reader.getChainId.mockResolvedValue(1);
    if (stage === 'block') transaction.blockNumber = 101n;
    if (stage === 'blockHash') reader.getBlock.mockResolvedValue({ hash: other });
    if (stage === 'logIndex') changed.logIndex = 3;
    if (stage === 'removed') log.removed = true;
    if (stage === 'emitter') log.address = committer;
    if (stage === 'root') batch.root = other;
    if (stage === 'leafCount') batch.leafCount = 2;
    if (stage === 'committer') batch.committer = registry;
    if (stage === 'reverted') transaction.status = 'reverted';
    if (stage === 'duplicate') transaction.logs.push(log);
    if (stage === 'event') log.topics = [other];
    const result = await verifyReceipt(changed, registry, reader);
    expect(result.steps.map(s => s.status)).toEqual(['passed', 'passed', 'failed']);
    expect(result.status).toBe('failed');
  });
  it('does not require a public payload to verify private commitments', async () => {
    const { receipt, reader, batch, log } = setup();
    const item = legacy.items[2]!;
    batch.root = legacy.root as Hex; batch.leafCount = legacy.items.length;
    log.data = encodeAbiParameters([{ type: 'uint32' }], [legacy.items.length]);
    log.topics = encodeEventTopics({ abi: receiptsRegistryAbi, eventName: 'BatchCommitted', args: { batchId: 1n, root: legacy.root as Hex, committer } }) as Hex[];
    const { revealed: _, canonicalPayload: _bytes, ...anchor } = receipt.status === 'anchored' ? receipt : (() => { throw new Error('fixture'); })();
    const result = await verifyReceipt({ ...anchor, ...item, merkleRoot: legacy.root, proof: legacy.proofs[2], itemId: undefined }, registry, reader);
    // Input uses the public lookup contract, not fixture-only itemId metadata.
    expect(result.status).toBe('failed');
    const privateReceipt = { ...anchor, id: item.id, kind: item.kind, hash: item.hash, leaf: item.leaf, merkleRoot: legacy.root, proof: legacy.proofs[2] };
    const checked = await verifyReceipt(privateReceipt, registry, reader);
    expect(checked.status).toBe('commitment');
    expect(checked.steps.map(s => s.status)).toEqual(['commitment', 'passed', 'passed']);
  });
  it('checks unrevealed public commitments without claiming a checked payload', async () => {
    const { receipt, reader } = setup();
    const { revealed: _, canonicalPayload: _bytes, ...anchor } = receipt.status === 'anchored' ? receipt : (() => { throw new Error('fixture'); })();
    expect((await verifyReceipt(anchor, registry, reader)).status).toBe('commitment');
  });
  it('checks expired public commitments without treating the summary as a verified payload', async () => {
    const {receipt,reader}=setup();
    const {revealed:_,canonicalPayload:_bytes,...anchor}=receipt;
    const result=await verifyReceipt({...anchor,payloadStatus:'expired'},registry,reader);
    expect(result.status).toBe('commitment');
    expect(result.steps.map(s=>s.status)).toEqual(['commitment','passed','passed']);
    expect(result.steps[0].message).toContain('payload has expired');
    expect((await verifyReceipt({...receipt,payloadStatus:'expired'},registry,reader)).status).toBe('failed');
  });
  it('does no reads for pending receipts and fails closed without a pin or RPC', async () => {
    const { receipt, reader } = setup();
    const pending = { id: receipt.id, kind: receipt.kind, hash: receipt.hash, leaf: receipt.leaf, canonicalization: receipt.canonicalization, status: 'pending' };
    expect(await verifyReceipt(pending, registry, reader)).toEqual({ status: 'pending', steps: [] });
    expect(reader.getChainId).not.toHaveBeenCalled();
    expect((await verifyReceipt(receipt, null, reader)).steps[2]?.status).toBe('failed');
    reader.getChainId.mockRejectedValue(new Error('offline'));
    expect((await verifyReceipt(receipt, registry, reader)).steps[2]?.message).toContain('keyless RPC');
  });
});
