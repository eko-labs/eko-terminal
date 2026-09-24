import { entryPoint06Abi, entryPoint07Abi, userOperationEventAbi, type AddressRegistry } from '@eko/chain';
import { decodeEventLog, decodeFunctionData, keccak256, stringToHex, parseAbi, toEventSelector, type Address, type Hex } from 'viem';
import type { RpcReceipt, RpcTransaction } from './types.js';
import { lower } from './clients.js';

const beforeAbi = parseAbi(['event BeforeExecution()']);
const beforeTopic = toEventSelector(beforeAbi[0]), opTopic = toEventSelector(userOperationEventAbi[0]);
export interface ReceiptActor {
  sender: Address; accountClass: 'erc4337'; operationHash: Hex; bundler: Address; paymaster: Address | null;
}
export function receiptMappingRevision(registry:AddressRegistry) {
  return keccak256(stringToHex(JSON.stringify({method:'receipt-log-brackets-1',entryPoints:(['v06','v07','v08'] as const).map(v=>[v,registry.addressOf(`entryPoints.${v}`)?.toLowerCase() ?? null])})));
}
/** Holder-level receipt segmentation only. Never a 043 principal/control binding. */
export function receiptActors(tx: RpcTransaction, receipt: RpcReceipt | undefined, registry: AddressRegistry) {
  const actors = new Map<string, ReceiptActor>();
  const deployment = (['v06', 'v07', 'v08'] as const).find(v => registry.addressOf(`entryPoints.${v}`)?.toLowerCase() === tx.to?.toLowerCase());
  const result = (reason: string | null) => ({ actors, reason, version: deployment ? {v06:'0.6',v07:'0.7',v08:'0.8'}[deployment] : null });
  if (!deployment) return result('unverified_entry_point');
  if (!receipt || receipt.synthetic) return result('missing_complete_receipt');
  if (receipt.status != null && BigInt(receipt.status) !== 1n) return result('failed_transaction');
  const logs = [...receipt.logs].sort((a,b) => Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
  if (new Set(logs.map(l => BigInt(l.logIndex).toString())).size !== logs.length) return result('duplicate_log_index');
  const protocol = logs.filter(l => l.topics[0] === beforeTopic || l.topics[0] === opTopic);
  if (protocol.some(l => lower(l.address) !== lower(tx.to!))) return result('nested_or_unknown_entry_point');
  const starts = protocol.filter(l => l.topics[0] === beforeTopic);
  if (starts.length !== 1) return result('before_execution_count_mismatch');
  const start = starts[0];
  try { decodeEventLog({abi:beforeAbi,topics:start.topics,data:start.data,strict:true}); }
  catch { return result('malformed_before_execution'); }
  const ends = protocol.filter(l => l.topics[0] === opTopic);
  if (!ends.length || ends.some(l => BigInt(l.logIndex) <= BigInt(start.logIndex))) return result('user_operation_event_count_mismatch');
  try {
    const ops = ends.map(l => ({ log:l, args:decodeEventLog({abi:userOperationEventAbi,topics:l.topics,data:l.data,strict:true}).args }));
    if (new Set(ops.map(o=>lower(o.args.userOpHash))).size !== ops.length) return result('duplicate_user_operation_event');
    // Full-block inputs, when present, cross-check receipt count and ordered sender/nonce.
    // Scoped receipt paths require the same unambiguous marker/event brackets, with no extra RPC.
    if (tx.input && tx.input !== '0x') {
      const decoded = decodeFunctionData({abi:deployment==='v06' ? entryPoint06Abi : entryPoint07Abi,data:tx.input});
      const inputs = decoded.args[0];
      if (inputs.length !== ops.length || inputs.some((o,i)=>lower(o.sender)!==lower(ops[i].args.sender) || o.nonce!==ops[i].args.nonce)) return result('user_operation_event_count_mismatch');
    }
    let previous = BigInt(start.logIndex);
    for (const op of ops) {
      const end = BigInt(op.log.logIndex);
      if (op.args.success) for (const l of logs) if (BigInt(l.logIndex)>previous && BigInt(l.logIndex)<end) {
        actors.set(BigInt(l.logIndex).toString(), {sender:lower(op.args.sender),accountClass:'erc4337',operationHash:lower(op.args.userOpHash),
          bundler:lower(tx.from),paymaster:/^0x0{40}$/.test(op.args.paymaster) ? null : lower(op.args.paymaster)});
      }
      previous = end;
    }
    return result(null);
  } catch { return result('malformed_or_unsupported_user_operation'); }
}
