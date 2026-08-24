import { decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { z } from 'zod';
import { AddressSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { AvailabilityCut, GuardCursor } from '@eko/shared';
import { erc20Abi, ponsCurveAbi, ponsFactoryAbi } from '../abis.js';
import type { LaunchRoleSnapshot, LaunchRoleInput } from './launch-roles.js';
import type { AcquiredTraceBlock, AcquiredTraceTransaction, BoundTraceLog, TraceFrame } from './trace-acquisition.js';
import { resolveService } from './principal-services.js';

export const userOperationEventAbi = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']);
export const entryPoint06Abi = parseAbi([
  'struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
  'function handleOps(UserOperation[] ops, address beneficiary)',
]);
export const entryPoint07Abi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
]);
export interface EntryPointProfile {
  address: string; version: '0.6' | '0.7'; code: Hex; codeHash: Hex;
  effectiveFrom: GuardCursor; effectiveUntil: GuardCursor | null; knownAt: AvailabilityCut;
}
export interface TraceRoleOptions {
  at: AvailabilityCut; entryPoints: readonly EntryPointProfile[];
  // TODO(spec): 043 specifies effective profiles/fee evidence but no adapter wire envelope.
  // These finite acquired observations are retained with the source payload; unsupported layouts stay missing.
  /** Acquired adapter-specific fee decomposition, never msg.value-as-launch-cost. */
  creationFee?: { asset: string; recipient: string; raw: string; evidenceRef: string };
  service?: Parameters<typeof resolveService>[0];
}
interface Operation { hash: Hex; sender: Hex; nonce: bigint; callData: Hex; paymaster: Hex | null }
const addr = (s: string) => AddressSchema.parse(s.toLowerCase()) as Hex;
const within = (frame: TraceFrame, root: TraceFrame) => frame.ordinal >= root.ordinal && frame.endOrdinal <= root.endOrdinal;
const isZero = (a: string) => /^0x0{40}$/.test(a);
const launchArgs = z.object({ token: AddressSchema, curve: AddressSchema, deployer: AddressSchema, pairToken: AddressSchema });
const buyArgs = z.object({ recipient: AddressSchema, quoteIn: z.bigint() });
const sellArgs = z.object({ recipient: AddressSchema, tokensIn: z.bigint() });

/** Protocol hashes bind successful receipt events to exact input operations, including repeated senders. */
function operations(input: Hex, profile: EntryPointProfile, chainId: number): Operation[] {
  const outer = (packed: Hex) => keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'), [keccak256(packed), addr(profile.address), BigInt(chainId)]));
  if (profile.version === '0.6') {
    const decoded = decodeFunctionData({ abi: entryPoint06Abi, data: input });
    return decoded.args[0].map(op => ({ hash: outer(encodeAbiParameters(parseAbiParameters('address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,bytes32'),
      [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.callGasLimit, op.verificationGasLimit, op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, keccak256(op.paymasterAndData)])),
    sender: addr(op.sender), nonce: op.nonce, callData: op.callData, paymaster: op.paymasterAndData.length >= 42 ? addr(op.paymasterAndData.slice(0, 42)) : null }));
  }
  const decoded = decodeFunctionData({ abi: entryPoint07Abi, data: input });
  return decoded.args[0].map(op => ({ hash: outer(encodeAbiParameters(parseAbiParameters('address,uint256,bytes32,bytes32,bytes32,uint256,bytes32,bytes32'),
    [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)])),
  sender: addr(op.sender), nonce: op.nonce, callData: op.callData, paymaster: op.paymasterAndData.length >= 42 ? addr(op.paymasterAndData.slice(0, 42)) : null }));
}
/** Shared lifetime/availability gate for pinned profiles; no deployment inference from an event. */
export function entryPointProfileAvailable(p: EntryPointProfile, executionCursor: GuardCursor, at: AvailabilityCut) {
  return p.effectiveFrom.chainId === executionCursor.chainId && at.cursor.chainId === executionCursor.chainId &&
    guardKnownBy(p.knownAt, at) && compareGuardCursors(p.effectiveFrom, executionCursor) <= 0 &&
    (!p.effectiveUntil || compareGuardCursors(executionCursor, p.effectiveUntil) < 0) && keccak256(p.code) === p.codeHash;
}
export function resolveOperationSubtree(tx: AcquiredTraceTransaction, target: TraceFrame, profiles: readonly EntryPointProfile[], at: AvailabilityCut) {
  const bound: { principal: Hex; root: TraceFrame; operationHash: Hex; sponsor: Hex | null }[] = [];
  const executionCursor: GuardCursor = { ...tx.cursor, transactionIndex: Number(BigInt(tx.transaction.transactionIndex)), executionOrdinal: 0, boundary: 'before_tx' };
  for (const p of profiles) {
    if (!entryPointProfileAvailable(p, executionCursor, at)) continue;
    for (const entry of tx.frames.filter(f => f.successful && f.call.type === 'CALL' && f.context === addr(p.address) && within(target, f))) {
      let ops: Operation[];
      try { ops = operations(entry.call.input, p, at.cursor.chainId); } catch { continue; }
      for (const event of tx.logs.filter(l => l.address === addr(p.address) && l.ordinal > entry.ordinal && l.ordinal < entry.endOrdinal)) {
        let args;
        try { args = decodeEventLog({ abi: userOperationEventAbi, ...event, topics: event.topics as [Hex, ...Hex[]] }).args; } catch { continue; }
        if (!args.success) continue;
        const matches = ops.filter(op => op.hash === args.userOpHash && op.sender === addr(args.sender) && op.nonce === args.nonce && (op.paymaster ?? `0x${'0'.repeat(40)}`) === addr(args.paymaster));
        if (matches.length !== 1) continue;
        const op = matches[0];
        // Reviewed v0.6/v0.7 shape: an EntryPoint self-call encloses execution and its terminal UserOperationEvent.
        // The sender/callData alone cannot bind a batch. Other layouts remain unsupported.
        const containers = tx.frames.filter(f => f.successful && f.call.type === 'CALL' && f.call.from === addr(p.address) && f.context === addr(p.address) &&
          f.ordinal > entry.ordinal && f.endOrdinal < entry.endOrdinal && event.ordinal > f.ordinal && event.ordinal < f.endOrdinal && within(target, f));
        const container = containers.sort((a, b) => b.ordinal - a.ordinal)[0];
        if (!container) continue;
        const opEvents = tx.logs.filter(l => l.path === container.path && l.address === addr(p.address)).filter(l => {
          try { decodeEventLog({ abi: userOperationEventAbi, ...l, topics: l.topics as [Hex, ...Hex[]] }); return true; } catch { return false; }
        });
        if (opEvents.length !== 1 || opEvents[0].ordinal !== event.ordinal) continue;
        const roots = tx.frames.filter(f => f.parent === container.path && f.successful && f.call.type === 'CALL' && f.call.from === addr(p.address) &&
          f.context === op.sender && f.call.input === op.callData && f.endOrdinal < event.ordinal);
        if (roots.length !== 1 || !within(target, roots[0])) continue;
        bound.push({ principal: op.sender, root: roots[0], operationHash: op.hash, sponsor: op.paymaster });
      }
    }
  }
  const unique = [...new Map(bound.map(b => [`${b.operationHash}:${b.root.path}`, b])).values()];
  return unique.length === 1 ? unique[0] : null;
}
interface Transfer { asset: Hex; from: Hex; to: Hex; raw: bigint; ordinal: number; ref: string }
function transfers(tx: AcquiredTraceTransaction, root: TraceFrame): Transfer[] {
  const out: Transfer[] = [];
  const native = `0x${'0'.repeat(40)}` as Hex;
  for (const f of tx.frames.filter(f => f.successful && within(f, root) && f.call.type === 'CALL' && f.call.to && BigInt(f.call.value ?? '0x0') > 0n))
    out.push({ asset: native, from: f.call.from, to: f.call.to!, raw: BigInt(f.call.value!), ordinal: f.ordinal, ref: `trace:${f.path}` });
  for (const l of tx.logs.filter(l => l.ordinal > root.ordinal && l.ordinal < root.endOrdinal)) {
    try {
      const { args } = decodeEventLog({ abi: erc20Abi, ...l, topics: l.topics as [Hex, ...Hex[]] });
      out.push({ asset: l.address, from: addr(args.from), to: addr(args.to), raw: args.value, ordinal: l.ordinal, ref: `log:${l.logIndex}` });
    } catch { /* Other event topics have no economic-transfer meaning. */ }
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}
/** Exact conserved input path. Splits, fee ambiguity, or multiple sources require a later adapter. */
function economicDebit(flows: Transfer[], asset: Hex, recipient: Hex, amount: bigint, before: number, principal: Hex | null, after = 0) {
  if (amount <= 0n) return null;
  const candidates = flows.filter(f => f.asset === asset && f.to === recipient && f.raw === amount && f.ordinal < before && f.ordinal >= after);
  if (candidates.length !== 1) return null;
  let debit = candidates[0]; const refs = [debit.ref], seen = new Set<string>();
  while (debit.from !== principal && !seen.has(debit.from)) {
    seen.add(debit.from);
    // Any intervening debit invalidates a simple conserved path; never reuse the same incoming value twice.
    const outgoing = flows.filter(f => f.asset === asset && f.from === debit.from && f.ordinal < debit.ordinal);
    const lastDebit = outgoing.at(-1)?.ordinal ?? -1;
    const incoming = flows.filter(f => f.asset === asset && f.to === debit.from && f.raw === amount && f.ordinal < debit.ordinal && f.ordinal > lastDebit);
    if (incoming.length > 1) return null;
    if (!incoming.length) break;
    debit = incoming[0]; refs.push(debit.ref);
  }
  // ERC20 Transfer establishes the debited owner; native routing must reach an authenticated debit account.
  if (isZero(asset) && debit.from !== principal) return null;
  return { address: debit.from, refs };
}

/** Complete complex roles from acquired evidence, outside the evaluator. Never union economic recipients as owners. */
export function resolveTraceLaunchRoles(snapshot: LaunchRoleSnapshot, input: LaunchRoleInput, block: AcquiredTraceBlock, options: TraceRoleOptions): LaunchRoleSnapshot {
  let service;
  if (options.service) {
    if (!guardKnownBy(options.service.at, options.at)) throw new Error('Service observation exceeds captured availability');
    service = resolveService(options.service);
    const caller = snapshot.roles.find(r => r.role === 'factory_deployer')?.address;
    if (caller !== service.address) throw new Error('Service observation does not match factory caller');
    snapshot = { ...snapshot, service,
      jobs: snapshot.jobs.filter(j => !(j.kind === 'service_review' && service!.status === 'confirmed')) };
  }
  if (block.status !== 'complete') return snapshot;
  if (compareGuardCursors(block.cursor, snapshot.cursor) > 0 || compareGuardCursors(block.cursor, options.at.cursor) > 0) throw new Error('Trace exceeds captured state/availability');
  const launches = input.events.filter(e => e.kind === 'launch' && e.data.token === snapshot.coin);
  if (launches.length !== 1) return snapshot;
  const launch = launches[0], tx = block.transactions.find(t => t.transaction.hash === launch.txHash.toLowerCase());
  if (!tx || tx.bindingStatus !== 'complete' || tx.receipt.status !== '0x1' || BigInt(launch.block) !== BigInt(tx.transaction.blockNumber)) return snapshot;
  const log = tx.logs.find(l => l.logIndex === launch.logIndex && l.address === addr(launch.emitter));
  if (!log) return snapshot;
  let event;
  try { event = decodeEventLog({ abi: ponsFactoryAbi, ...log, topics: log.topics as [Hex, ...Hex[]] }); } catch { return snapshot; }
  const parsed = launchArgs.safeParse(event.args);
  if (event.eventName !== 'TokenLaunched' || !parsed.success || addr(parsed.data.token) !== snapshot.coin || addr(parsed.data.deployer) !== addr(String(launch.data.deployer))) return snapshot;
  const args = parsed.data;
  const factoryFrame = tx.frames.find(f => f.path === log.path);
  if (!factoryFrame?.successful) return snapshot;
  const binding = resolveOperationSubtree(tx, factoryFrame, options.entryPoints, options.at);
  // A transaction signature authenticates its own execution, including a delegated self-call.
  // Sponsored calls require an account-specific permission decoder; authorization of code is not authorization of that call.
  const direct = tx.frames[0];
  const directPrincipal = !tx.frames.some(f => options.entryPoints.some(p => addr(p.address) === f.context) && within(factoryFrame, f)) &&
    (tx.transaction.to === addr(launch.emitter) || tx.transaction.to === tx.transaction.from) ? tx.transaction.from : null;
  const principal = binding?.principal ?? directPrincipal;
  const root = binding?.root ?? direct;
  const roles = snapshot.roles.map(r => ({ ...r }));
  const refs = [launch.ref, `trace:${tx.transaction.hash}:${factoryFrame.path}`, ...(binding ? [`userop:${binding.operationHash}`] : [])];
  const replace = (role: LaunchRoleSnapshot['roles'][number]['role'], value: Hex | null, proof: string[]) => {
    for (let i = roles.length - 1; i >= 0; i--) if (roles[i].role === role && (['launch_principal', 'creation_payer', 'outer_signer', 'factory_deployer'].includes(role) || roles[i].refs.includes(proof[0]))) roles.splice(i, 1);
    roles.push({ role, address: value, status: value === null ? 'missing' : 'verified', refs: proof, cursor: snapshot.cursor });
  };
  // Immediate factory caller is checked against the trace, not an actor alias.
  if (factoryFrame.call.type !== 'CALL' || factoryFrame.call.from !== addr(args.deployer)) return snapshot;
  replace('factory_deployer', addr(args.deployer), refs);
  replace('outer_signer', tx.transaction.from, refs);
  replace('launch_principal', principal, refs);
  const flows = transfers(tx, root), curve = addr(args.curve), quoteAsset = addr(args.pairToken);
  let creationPayer: Hex | null = null;
  if (options.creationFee) {
    const fee = options.creationFee;
    const debit = economicDebit(flows, addr(fee.asset), addr(fee.recipient), BigInt(fee.raw), factoryFrame.endOrdinal, principal);
    creationPayer = debit?.address ?? null;
    replace('creation_payer', creationPayer, [...refs, fee.evidenceRef, ...(debit?.refs ?? [])]);
  }
  for (const l of tx.logs.filter(l => l.address === curve)) {
    const frame = tx.frames.find(f => f.path === l.path)!;
    let trade;
    try { trade = decodeEventLog({ abi: ponsCurveAbi, ...l, topics: l.topics as [Hex, ...Hex[]] }); } catch { continue; }
    if (trade.eventName !== 'CurveBuy' && trade.eventName !== 'CurveSell') continue;
    // Economic roles are bound to their own UserOp, never to the launch's batch neighbors.
    const op = resolveOperationSubtree(tx, frame, options.entryPoints, options.at);
    const tradeRoot = op?.root ?? root, tradePrincipal = op?.principal ?? principal;
    if (!within(frame, tradeRoot)) continue;
    const tradeFlows = transfers(tx, tradeRoot), ref = `${tx.transaction.hash}:${l.logIndex}`, proof = [ref, `trace:${tx.transaction.hash}:${frame.path}`, ...(op ? [`userop:${op.operationHash}`] : [])];
    if (trade.eventName === 'CurveBuy') {
      const args = buyArgs.parse(trade.args);
      const debit = economicDebit(tradeFlows, quoteAsset, curve, args.quoteIn, l.ordinal, tradePrincipal, frame.ordinal);
      replace('buy_payer', debit?.address ?? null, [...proof, ...(debit?.refs ?? [])]);
      replace('buy_recipient', addr(args.recipient), proof);
    } else {
      const sold = sellArgs.parse(trade.args);
      const debit = economicDebit(tradeFlows, addr(args.token), curve, sold.tokensIn, l.ordinal, tradePrincipal, frame.ordinal);
      replace('sell_source', debit?.address ?? null, [...proof, ...(debit?.refs ?? [])]);
      replace('proceeds_recipient', addr(sold.recipient), proof);
    }
  }
  const serviceComplete = service?.status === 'confirmed';
  const jobs = snapshot.jobs.filter(j => !(j.kind === 'trace_principal' && principal !== null) && !(j.kind === 'service_review' && serviceComplete) && !(j.kind === 'creation_payer' && creationPayer !== null));
  if (principal === null && !jobs.some(j => j.kind === 'trace_principal')) jobs.push({ kind: 'trace_principal', status: 'missing', refs });
  return { ...snapshot, roles, jobs };
}
