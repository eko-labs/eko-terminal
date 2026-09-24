import { receiptActors, receiptMappingRevision } from './receipt-actors.js';
import { decodeAuthorization, decodeDelegationCode, entryPointProfileAvailable, resolveOperationSubtree, userOperationEventAbi,
  type AcquiredTraceBlock, type TraceRoleOptions, type ActorContext, type AddressRegistry } from '@eko/chain';
import { binary } from '@eko/db';
import { decodeEventLog, keccak256, parseAbi, toEventSelector, type Address, type Hex } from 'viem';
import { BlockRows } from './rows.js';
import { json, type RpcBlock, type RpcReceipt } from './types.js';
import type { RemoteInputs } from './decode.js';
import { lower, native } from './clients.js';

export const walletProtocolTopics = [...parseAbi(['event BeforeExecution()']), ...userOperationEventAbi].map(toEventSelector);
export interface WalletProtocolInput { block?: AcquiredTraceBlock; options: TraceRoleOptions }
export type ProtocolActor = ActorContext & { missing?: boolean; reason?: string; accountClass?: 'erc4337' };
const eventKey = (tx: string, index: string) => `${lower(tx)}:${BigInt(index)}`;

/** Collect already-acquired inputs only. No transport, trace acquisition or pure Watcher writes. */
export async function collectWalletProtocol(block: RpcBlock, receipts: RpcReceipt[], registry: AddressRegistry,
  remote: RemoteInputs, supplied?: WalletProtocolInput) {
  const mappingRevision=receiptMappingRevision(registry);
  const rows = new BlockRows(), actors = new Map<string, ProtocolActor>();
  const number = BigInt(block.number), chainId = registry.data.chainId;
  const profiles = supplied?.options.entryPoints ?? [];
  if (supplied && (supplied.options.at.cursor.chainId !== chainId || BigInt(supplied.options.at.cursor.blockNumber) < number)) throw new Error('Protocol observation exceeds availability');
  const registered = (['entryPoints.v06', 'entryPoints.v07', 'entryPoints.v08'] as const)
    .flatMap(k => registry.addressOf(k) ? [lower(registry.addressOf(k)!)] : []);
  const traceBlock = supplied?.block;
  if (traceBlock && (traceBlock.cursor.chainId !== chainId || traceBlock.cursor.blockHash !== lower(block.hash) ||
    BigInt(traceBlock.cursor.blockNumber) !== number || BigInt(traceBlock.cursor.timestampSec) !== BigInt(block.timestamp))) throw new Error('Protocol trace block mismatch');
  const seen = new Set<string>();
  for (const [ordinal, tx] of block.transactions.entries()) {
    const matches = receipts.filter(r => lower(r.transactionHash) === lower(tx.hash));
    if (seen.has(lower(tx.hash)) || matches.length > 1) throw new Error('Duplicate protocol transaction/receipt');
    seen.add(lower(tx.hash));
    const receipt = matches[0];
    if (receipt && (lower(receipt.blockHash) !== lower(block.hash) || BigInt(receipt.blockNumber) !== number ||
      receipt.logs.some(l => l.removed || lower(l.blockHash) !== lower(block.hash) || BigInt(l.blockNumber) !== number || lower(l.transactionHash) !== lower(tx.hash)))) throw new Error('Protocol receipt block mismatch');
    const complete = receipt != null && !receipt.synthetic;
    const index = tx.transactionIndex ?? receipt?.transactionIndex;
    const base = { chain_id: chainId, block: number.toString(), block_hash: binary(block.hash), tx_hash: binary(tx.hash),
      transaction_index: index == null ? block.transactionsComplete === false ? null : ordinal : Number(BigInt(index)), timestamp_sec: BigInt(block.timestamp).toString() };
    const rawLogs = receipt?.logs.filter(l => walletProtocolTopics.includes(l.topics[0])) ?? [];
    const traced = traceBlock?.status === 'complete' ? traceBlock.transactions.find(t => t.transaction.hash === lower(tx.hash)) : undefined;
    // A supplied 043 observation must reconcile with the existing input/receipt, never another fork or transaction.
    if (traced && (traced.transaction.from !== lower(tx.from) || traced.transaction.to !== (tx.to ? lower(tx.to) : null) ||
      traced.receipt.logs.some(l => !receipt?.logs.some(r => eventKey(r.transactionHash,r.logIndex) === eventKey(tx.hash,l.logIndex) &&
        lower(r.address) === l.address && lower(r.data) === l.data && r.topics.map(lower).join() === l.topics.join())))) throw new Error('Protocol trace receipt mismatch');
    const segmented = receiptActors(tx,receipt,registry);
    let verifiedEvents = 0;
    for (const l of rawLogs) {
      if (l.topics[0] !== toEventSelector(userOperationEventAbi[0]) || !complete) continue;
      // resolveOperationSubtree performs profile lifetime/availability, bytecode hash and exact operation checks.
      const frame = traced?.frames.find(f => f.path === traced.logs.find(t => t.logIndex === Number(BigInt(l.logIndex)))?.path);
      const binding = frame && supplied && traced?.bindingStatus === 'complete' && traced.receipt.status === '0x1' ? resolveOperationSubtree(traced, frame, profiles, supplied.options.at) : null;
      // Receipt events can be stored as verified without assigning logs to an execution subtree.
      const executionCursor = supplied ? { ...supplied.options.at.cursor, chainId, blockNumber:number.toString(), blockHash:lower(block.hash) as `0x${string}`,
        timestampSec:BigInt(block.timestamp).toString(), transactionIndex:base.transaction_index, executionOrdinal:0, boundary:'before_tx' as const } : null;
      const profile = profiles.find(p => lower(p.address) === lower(l.address) && executionCursor && supplied &&
        entryPointProfileAvailable(p,executionCursor,supplied.options.at));
      const registeredVersion = (['v06','v07','v08'] as const).find(v=>registry.addressOf(`entryPoints.${v}`)?.toLowerCase()===lower(l.address));
      if (!profile && (!registeredVersion || lower(tx.to ?? native)!==lower(l.address))) continue;
      try {
        const { args } = decodeEventLog({ abi: userOperationEventAbi, topics: l.topics, data: l.data, strict: true });
        rows.add('userops', { ...base, log_index: Number(BigInt(l.logIndex)), entry_point: binary(l.address), version: profile?.version ?? {v06:'0.6',v07:'0.7',v08:'0.8'}[registeredVersion!],
          user_op_hash: binary(args.userOpHash), sender: binary(args.sender), paymaster: binary(args.paymaster), nonce: args.nonce.toString(),
          success: args.success, actual_gas_cost: args.actualGasCost.toString(), actual_gas_used: args.actualGasUsed.toString(),
          data: json({ log: l, profile, knownAt: supplied?.options.at ?? null, principalBinding: binding ? { sender: binding.principal, operationHash: binding.operationHash, sponsor: binding.sponsor } : null }) });
        verifiedEvents++;
      } catch { /* Malformed events remain raw missing inputs, never zero-valued operations. */ }
    }
    const complex = rawLogs.length > 0 || registered.includes(lower(tx.to ?? native)) || profiles.some(p => lower(p.address) === lower(tx.to ?? native));
    const externalDelegate = tx.to != null && lower(tx.from) !== lower(tx.to) && decodeDelegationCode(remote.codes.get(lower(tx.to)) ?? '0x') !== null;
    const bindings: {logIndex:string;sender:Address;operationHash:Hex;sponsor:Hex|null;tracePath:string}[] = [];
    for (const l of receipt?.logs ?? []) {
      const frame = traced?.frames.find(f => f.path === traced.logs.find(t => t.logIndex === Number(BigInt(l.logIndex)))?.path);
      const binding = frame && supplied && traced?.bindingStatus === 'complete' && traced.receipt.status === '0x1' ? resolveOperationSubtree(traced,frame,profiles,supplied.options.at) : null;
      if(binding) bindings.push({logIndex:BigInt(l.logIndex).toString(),sender:binding.principal as Address,operationHash:binding.operationHash,sponsor:binding.sponsor,tracePath:binding.root.path});
      const holder = segmented.actors.get(BigInt(l.logIndex).toString());
      actors.set(eventKey(tx.hash,l.logIndex), binding ? { userOpSender: binding.principal as Address, accountClass:'erc4337' } :
        holder ? {userOpSender:holder.sender,accountClass:holder.accountClass} :
        complex || externalDelegate ? { missing: true, reason:externalDelegate && !complex ? 'missing_delegated_execution_binding' : segmented.reason ?? 'outside_successful_user_operation' } : {});
    }
    const fullInputs = block.transactionsComplete !== false;
    const authorizations = fullInputs ? tx.authorizationList ?? [] : [];
    for (const [i,a] of authorizations.entries()) {
      const decoded = await decodeAuthorization(a,chainId);
      rows.add('delegations_7702', { ...base, kind:'authorization', evidence_index:i,
        authority: decoded.authority ? binary(decoded.authority) : null, implementation:binary(decoded.implementation),
        signature_valid:decoded.signatureValid, data:json({ raw:a, ...decoded }) });
    }
    let codeCount = 0;
    for (const address of new Set([tx.to].filter((a): a is Address => a != null))) {
      const code = remote.codes.get(lower(address)), observed = remote.codeBlocks?.get(lower(address)) ?? number;
      // TTL reuse is evidence of an earlier state, never proof of the current delegation.
      if (code == null || observed !== number) continue;
      rows.add('delegations_7702', { ...base, kind:'code', evidence_index:codeCount++, authority:binary(address),
        implementation:decodeDelegationCode(code) ? binary(decodeDelegationCode(code)!) : null,
        signature_valid:null, data:json({ code, boundary:'block_end', effectiveAuthorization:'unknown' }) });
    }
    // TODO(spec): No persisted Watcher coverage wire schema is specified; retain a finite scoped input manifest.
    const coverage = {
      holderAttribution:{method:'receipt-log-brackets-1',mappingRevision,reason:segmented.reason,bindings:[...segmented.actors].map(([logIndex,a])=>({logIndex,...a})),
        gaps:[...actors].filter(([key,a])=>key.startsWith(`${lower(tx.hash)}:`) && a.missing).map(([key,a])=>({logIndex:key.split(':')[1],reason:a.reason}))},
      transaction:fullInputs ? {input:tx.input??null,gasLimit:tx.gas??null,gasUsed:complete?receipt?.gasUsed??null:null} : null,
      bindings, knownAt:supplied?.options.at ?? null, outerSigner:tx.from, target:tx.to, transactionType:tx.type ?? null,
      receipt:complete ? 'complete' : 'missing', authorizationList:fullInputs && (tx.type == null || BigInt(tx.type) !== 4n || tx.authorizationList != null) ? 'complete' : 'missing',
      entryPoints: (['v06','v07','v08'] as const).map(version => ({version,status:profiles.some(p => p.version === (version==='v06'?'0.6':version==='v07'?'0.7':'0.8')) ? 'supplied_profile' : registry.addressOf(`entryPoints.${version}`) ? 'registry_verified' : 'missing_verified_deployment'})),
      userOperationEvents:rawLogs.filter(l=>l.topics[0]===toEventSelector(userOperationEventAbi[0])).length === verifiedEvents && complete ? 'complete_for_receipt' : 'missing_verified_events',
      principalBindings:complex || externalDelegate ? bindings.length ? 'partial_043_bindings' : 'missing_043' : 'direct_transaction',
      code:codeCount ? 'observed_block_end' : 'missing_current_state', rawProtocolLogs:rawLogs,
    };
    rows.add('wallet_protocol_coverage', { ...base, scope:fullInputs ? 'full_transaction' : complete ? 'scoped_receipt' : 'logs_only',
      input_hash:binary(keccak256(new TextEncoder().encode(json(coverage)))),data:json(coverage) });
  }
  return { rows, actors };
}
