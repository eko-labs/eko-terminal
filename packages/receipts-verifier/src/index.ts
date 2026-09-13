import { concat, decodeEventLog, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { canonicalize, createGuardReceiptCodec, ReceiptLookupSchema, type ReceiptLookup } from '@eko/shared';
import publishedAbi from './ReceiptsRegistry.json';

export const receiptsRegistryAbi = publishedAbi as Abi;
export const receiptVerifier = createGuardReceiptCodec({ concat, encodeAbiParameters, keccak256, stringToHex });
export interface RegistryReader {
  getChainId(): Promise<number>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null }>;
  getTransactionReceipt(input: { hash: Hex }): Promise<{
    status: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex;
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[]; logIndex: number | null; removed?: boolean }[];
  }>;
  readContract(input: { address: Address; abi: Abi; functionName: 'batch'; args: readonly [bigint]; blockNumber: bigint }): Promise<unknown>;
}
export type VerificationStep = { status: 'passed' | 'failed' | 'skipped' | 'commitment'; message: string };
export type VerificationResult = { status: 'pending' | 'failed' | 'verified' | 'commitment'; steps: VerificationStep[] };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** No server verification verdict is consumed. The caller supplies a separately
 * published registry address and a keyless chain reader, never an item-selected registry. */
export async function verifyReceipt(raw: unknown, trustedRegistry: Address | null, reader: RegistryReader): Promise<VerificationResult> {
  const steps: VerificationStep[] = [];
  const fail = (message: string): VerificationResult => {
    steps.push({ status: 'failed', message });
    while (steps.length < 3) steps.push({ status: 'skipped', message: 'Not run: an earlier step failed.' });
    return { status: 'failed', steps };
  };
  const parsed = ReceiptLookupSchema.safeParse(raw);
  if (!parsed.success) return fail('Receipt metadata or canonicalization version is invalid.');
  const receipt: ReceiptLookup = parsed.data;
  if (receipt.status === 'pending') return { status: 'pending', steps: [] };
  const commitmentOnly = receipt.revealed === undefined;
  try {
    if (!commitmentOnly && (canonicalize(receipt.revealed) !== receipt.canonicalPayload
      || !receiptVerifier.verifyPayload(receipt.revealed, receipt)))
      return fail('The payload or canonical bytes do not match the receipt hash.');
    if (receiptVerifier.encodeReceiptLeaf(receipt) !== receipt.leaf)
      return fail('The receipt identity, kind or hash does not match the leaf.');
  } catch { return fail('The payload cannot be canonicalized as JCS JSON.'); }
  steps.push({ status: commitmentOnly ? 'commitment' : 'passed', message: commitmentOnly
    ? receipt.payloadStatus === 'expired'
      ? 'Commitment leaf matches. The payload has expired; the summary is not checked by this proof.'
      : 'Commitment leaf matches. The unrevealed payload has not been checked.'
    : 'JCS payload hash and receipt leaf match.' });
  if (!receiptVerifier.verifyReceiptProof(receipt, receipt.proof, receipt.merkleRoot))
    return fail('The sibling proof does not fold to the claimed Merkle root.');
  steps.push({ status: 'passed', message: 'The sibling proof folds to the Merkle root.' });
  if (!trustedRegistry) return fail('The published registry address is unavailable.');
  if (!same(receipt.registry, trustedRegistry)) return fail('The receipt points to a different registry.');
  try {
    if (await reader.getChainId() !== 4663) return fail('The RPC returned a different chain.');
    const [tx, block, batch] = await Promise.all([
      reader.getTransactionReceipt({ hash: receipt.txHash }),
      reader.getBlock({ blockNumber: BigInt(receipt.block) }),
      reader.readContract({ address: trustedRegistry, abi: receiptsRegistryAbi, functionName: 'batch', args: [BigInt(receipt.batchId)], blockNumber: BigInt(receipt.block) }),
    ]);
    if (tx.status !== 'success' || !same(tx.transactionHash, receipt.txHash) || tx.blockNumber !== BigInt(receipt.block)
      || !same(tx.blockHash, receipt.blockHash) || !block.hash || !same(block.hash, receipt.blockHash))
      return fail('The commit transaction or block is missing, changed or unsuccessful.');
    const b = batch as { root?: Hex; leafCount?: number; committer?: Address };
    if (!b?.root || !same(b.root, receipt.merkleRoot) || !Number.isInteger(b.leafCount) || b.leafCount! <= 0 || !b.committer)
      return fail('The registry batch at the commit block does not match the root.');
    const matches = tx.logs.filter(log => {
      if (!same(log.address, trustedRegistry) || log.removed || log.logIndex !== receipt.logIndex) return false;
      try {
        const event = decodeEventLog({ abi: receiptsRegistryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
        const args = event.args as unknown as { batchId: bigint; root: Hex; leafCount: number; committer: Address };
        return event.eventName === 'BatchCommitted' && args.batchId === BigInt(receipt.batchId)
          && same(args.root, receipt.merkleRoot) && args.leafCount === b.leafCount && same(args.committer, b.committer!);
      } catch { return false; }
    });
    if (matches.length !== 1) return fail('The exact transaction event does not bind this batch and root.');
    steps.push({ status: 'passed', message: 'The registry root and exact commit event match on chain 4663.' });
    return { status: commitmentOnly ? 'commitment' : 'verified', steps };
  } catch { return fail('The keyless RPC could not confirm the registry. Retry when chain reads are available.'); }
}
