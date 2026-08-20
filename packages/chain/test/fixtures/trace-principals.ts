import { custom, encodeFunctionData, encodeEventTopics, encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { GuardCursorSchema } from '@eko/shared';
import { RpcMeter } from '../../src/rpc/metered.js';
import { createMeteredClients } from '../../src/rpc/clients.js';
import type { RpcRequest } from '../../src/rpc/routes.js';
import type { UsageRow, UsageStore } from '../../src/rpc/usage.js';
import { TraceAcquisition } from '../../src/launchpads/trace-acquisition.js';
import type { CallFrame } from '../../src/launchpads/trace-acquisition.js';
import { entryPoint06Abi, entryPoint07Abi, userOperationEventAbi } from '../../src/launchpads/trace-principals.js';
import { ponsCurveAbi, ponsFactoryAbi } from '../../src/abis.js';
import type { LaunchRoleInput } from '../../src/launchpads/launch-roles.js';

export const address = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const cursor = GuardCursorSchema.parse({ chainId: 4663, blockNumber: '123', blockHash: hash(123), transactionIndex: null, executionOrdinal: null, timestampSec: '100000', boundary: 'block_end' });
export const at = { cursor, acquisitionSequence: '1' };
export const coin = address(1), factory = address(2), curve = address(3), tool = address(4), entrypoint = address(5), bundler = address(6), sponsor = address(7), account = address(8), otherAccount = address(9), recipient = address(10), otherRecipient = address(11), txHash = hash(12);
export function traceFixture(version: '0.6' | '0.7' = '0.6') {
  const code = '0x6000' as Hex, codeHash = keccak256(code);
  const op = (sender: Hex, nonce: bigint) => ({ sender, nonce, initCode: '0x' as Hex, callData: '0x1234' as Hex, callGasLimit: 100n, verificationGasLimit: 100n,
    preVerificationGas: 100n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
    paymasterAndData: (version === '0.6' ? sponsor : `${sponsor}${100n.toString(16).padStart(32, '0')}${100n.toString(16).padStart(32, '0')}`) as Hex, signature: '0x' as Hex });
  const ops = [op(account, 1n), op(otherAccount, 2n)];
  const packed = ops.map(o => ({ sender: o.sender, nonce: o.nonce, initCode: o.initCode, callData: o.callData,
    accountGasLimits: `0x${(100n << 128n | 100n).toString(16).padStart(64, '0')}` as Hex,
    preVerificationGas: o.preVerificationGas, gasFees: `0x${(1n << 128n | 1n).toString(16).padStart(64, '0')}` as Hex, paymasterAndData: o.paymasterAndData, signature: o.signature }));
  const input = version === '0.6' ? encodeFunctionData({ abi: entryPoint06Abi, functionName: 'handleOps', args: [ops, bundler] }) :
    encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [packed, bundler] });
  const operationHashes = ops.map(o => {
    if (version === '0.6') return getUserOperationHash({ chainId: 4663, entryPointAddress: entrypoint, entryPointVersion: '0.6', userOperation: o });
    const { initCode: _, paymasterAndData: __, ...rest } = o;
    return getUserOperationHash({ chainId: 4663, entryPointAddress: entrypoint, entryPointVersion: '0.7',
      userOperation: { ...rest, paymaster: sponsor, paymasterData: '0x', paymasterVerificationGasLimit: 100n, paymasterPostOpGasLimit: 100n } });
  });
  const launched = { address: factory, topics: encodeEventTopics({ abi: ponsFactoryAbi, eventName: 'TokenLaunched', args: { token: coin, curve, deployer: tool } }),
    data: encodeAbiParameters(parseAbiParameters('address,uint256,uint256'), [address(0), 1n, 1000n]), position: 0 };
  launched.topics = launched.topics as Hex[];
  const buy = (sender: Hex, dest: Hex) => ({ address: curve, topics: encodeEventTopics({ abi: ponsCurveAbi, eventName: 'CurveBuy', args: { buyer: sender, recipient: dest } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [100n, 200n, 1n, 1n]), position: 0 });
  const buys = [buy(tool, recipient), buy(tool, otherRecipient)].map(l => ({ ...l, topics: l.topics as Hex[] }));
  const done = ops.map((o, i) => ({ address: entrypoint, topics: encodeEventTopics({ abi: userOperationEventAbi, eventName: 'UserOperationEvent', args: { userOpHash: operationHashes[i], sender: o.sender, paymaster: sponsor } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'), [o.nonce, true, 2n, 100n]), position: 1 })).map(l => ({ ...l, topics: l.topics as Hex[] }));
  const call = (from: Hex, to: Hex, calls: CallFrame[] = [], logs: CallFrame['logs'] = [], data: Hex = '0x', value = '0x0'): CallFrame => ({ type: 'CALL', from, to, input: data, value, calls, logs });
  const launchLog = { ...launched, topics: launched.topics as Hex[] };
  const tools = [call(account, tool, [call(tool, factory, [], [launchLog]), call(tool, curve, [], [buys[0]], '0x', '0x64')], [], '0x', '0x64'),
    call(otherAccount, tool, [call(tool, curve, [], [buys[1]], '0x', '0x64')], [], '0x', '0x64')];
  const containers = ops.map((o, i) => call(entrypoint, entrypoint, [call(entrypoint, o.sender, [tools[i]], [], o.callData)], [done[i]], '0x01020304'));
  const root = call(bundler, entrypoint, containers, [], input);
  const receiptLogs = [launched, buys[0], done[0], buys[1], done[1]].map((l, i) => ({ ...l, logIndex: `0x${i.toString(16)}`, transactionHash: txHash }));
  const transaction = { hash: txHash, from: bundler, to: entrypoint, input, value: '0x0', transactionIndex: '0x0', blockHash: cursor.blockHash, blockNumber: '0x7b' };
  const receipt = { transactionHash: txHash, blockHash: cursor.blockHash, blockNumber: '0x7b', transactionIndex: '0x0', status: '0x1', logs: receiptLogs };
  const rawBlock = { hash: cursor.blockHash, number: '0x7b', timestamp: '0x186a0', transactions: [transaction] };
  const profiles = [{ address: entrypoint, version, code, codeHash, effectiveFrom: { ...cursor, blockNumber: '120', blockHash: hash(120), timestampSec: '99900' }, effectiveUntil: null, knownAt: at }];
  const roleInput: LaunchRoleInput = { coin, cursor, name: 'Sample token', symbol: 'DEMO', launchpad: 'pons', exemptions: [], senders: [], events: [
    { ref: `${txHash}:0`, block: '123', txHash, logIndex: 0, emitter: factory, kind: 'launch', data: { token: coin, curve, deployer: tool, outerFrom: bundler, outerTo: entrypoint, timestampSec: '100000', pairToken: address(0) } },
    ...[1, 3].map((logIndex, i) => ({ ref: `${txHash}:${logIndex}`, block: '123', txHash, logIndex, emitter: curve, kind: 'trade', data: { token: coin, side: 1, buyer: tool, recipient: i === 0 ? recipient : otherRecipient, timestampSec: '100000' } })),
  ] };
  const responses = (request: RpcRequest): unknown => {
    if (request.method === 'eth_getBlockByNumber') return rawBlock;
    if (request.method === 'eth_getBlockReceipts') return [receipt];
    if (request.method === 'debug_traceBlockByNumber') return [{ txHash, result: root }];
    throw new Error('Unsupported fixture method');
  };
  return { root, roleInput, profiles, receipt, rawBlock, transaction, responses, operationHashes, containers };
}
/** Every upstream is an in-memory fake, still admitted and counted by the task-024 meter. */
export function fakeAcquisition(respond: (r: RpcRequest) => unknown, maxBlocks = 64) {
  let time = Date.UTC(2026, 9, 2), total = 0;
  const rows = new Map<string, UsageRow>(), requests: RpcRequest[] = [];
  const store: UsageStore = { async reserve(_day, provider, method, units, limit) {
    if (total + units > limit) return { allowed: false, total };
    total += units; const key = `${provider}:${method}`, row = rows.get(key) ?? { provider, method, calls: 0, units: 0 };
    row.calls++; row.units += units; rows.set(key, row); return { allowed: true, total };
  }, async today() { return [...rows.values()]; } };
  const meter = new RpcMeter({ RPC_HTTP_URL: 'https://fixture.invalid' }, { store, now: () => time, sleep: async ms => { time += ms; }, log: () => undefined });
  meter.transport = context => options => custom({ request: async r => meter.request(r, {
    paid: async req => { requests.push(req); return respond(req); }, public: async () => { throw new Error('Unexpected public fallback'); },
  }, context) }, { retryCount: 0 })(options);
  const clients = createMeteredClients({}, { meter });
  return { acquisition: new TraceAcquisition(clients, maxBlocks), requests, meter };
}
