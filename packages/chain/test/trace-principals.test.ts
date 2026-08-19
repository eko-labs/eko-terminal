import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, keccak256, concatHex, toHex, toRlp, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveLaunchRolesV2, resolveTraceLaunchRoles, decodeDelegationCode } from '../src/index.js';
import { address, hash, cursor, at, traceFixture, fakeAcquisition, account, otherAccount, bundler, sponsor, tool, entrypoint, coin, recipient, otherRecipient } from './fixtures/trace-principals.js';
import { erc20Abi, ponsCurveAbi } from '../src/abis.js';

describe('043 fixture trace acquisition and principals (no chain requests)', () => {
  it.each(['0.6', '0.7'] as const)('shares four metered fake requests and separates unrelated %s UserOps and economic payers', async version => {
    const f = traceFixture(version), h = fakeAcquisition(f.responses);
    const [block, same] = await Promise.all([h.acquisition.acquire(cursor), h.acquisition.acquire(cursor)]);
    expect(same).toBe(block); expect(block.status).toBe('complete');
    expect(h.requests.map(r => r.method)).toEqual(['eth_getBlockByNumber', 'eth_getBlockReceipts', 'debug_traceBlockByNumber', 'eth_getBlockByNumber']);
    expect((await h.meter.usage()).today.reduce((sum, r) => sum + r.units, 0)).toBe(4);
    const tx = block.transactions[0];
    expect(tx.bindingStatus).toBe('complete');
    expect(tx.logs.map(l => l.logIndex)).toEqual([0, 1, 2, 3, 4]);
    const resolved = resolveTraceLaunchRoles(resolveLaunchRolesV2(f.roleInput), f.roleInput, block, { at, entryPoints: f.profiles });
    expect(resolved.roles.find(r => r.role === 'launch_principal')).toMatchObject({ address: account, status: 'verified' });
    expect(resolved.roles.find(r => r.role === 'outer_signer')?.address).toBe(bundler);
    expect(resolved.roles.find(r => r.role === 'factory_deployer')?.address).toBe(tool);
    expect(resolved.roles.filter(r => r.role === 'buy_payer').map(r => r.address)).toEqual([account, otherAccount]);
    expect(resolved.roles.filter(r => r.role === 'buy_recipient').map(r => r.address)).toEqual([recipient, otherRecipient]);
    expect(resolved.roles.find(r => r.role === 'creation_payer')?.address).toBeNull();
    expect(resolved.roles.some(r => r.role === 'launch_principal' && r.address === sponsor)).toBe(false);
    expect(resolved.roles.find(r => r.role === 'launch_principal')?.refs).toContain(`userop:${f.operationHashes[0]}`);
  });
  it('does not impose lexical order on twelve sibling paths and removes reverted value/log frames', async () => {
    const f = traceFixture();
    const accountFrame = f.containers[0].calls![0];
    const purchase = accountFrame.calls![0];
    accountFrame.calls = Array.from({ length: 12 }, (_, i) => i === 10 ? purchase : ({ type: 'CALL', from: account, to: address(40 + i), input: '0x' as Hex, value: '0x1', ...(i === 2 ? { error: 'execution reverted' } : {}) }));
    const h = fakeAcquisition(f.responses), block = await h.acquisition.acquire(cursor);
    expect(block.transactions[0].bindingStatus).toBe('complete');
    const frames = block.transactions[0].frames;
    const ten = frames.find(f => f.path === '0.0.0.10')!, two = frames.find(f => f.path === '0.0.0.2')!;
    expect(ten.ordinal).toBeGreaterThan(two.ordinal); expect(two.successful).toBe(false);
  });
  it('keeps ambiguous account execution, bad input hashes and failed UserOps unresolved', async () => {
    for (const mode of ['ambiguous', 'hash', 'failed'] as const) {
      const f = traceFixture();
      if (mode === 'ambiguous') {
        f.containers[0].calls!.push({ ...f.containers[0].calls![0], calls: [], logs: [] });
        f.containers[0].logs![0].position = 2;
      } else if (mode === 'hash') f.receipt.logs[2].topics[1] = hash(999);
      else {
        const data = encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'), [1n, false, 2n, 100n]);
        f.receipt.logs[2].data = data;
      }
      const block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
      const result = resolveTraceLaunchRoles(resolveLaunchRolesV2(f.roleInput), f.roleInput, block, { at, entryPoints: f.profiles });
      expect(result.roles.find(r => r.role === 'launch_principal')).toMatchObject({ status: 'missing', address: null });
      expect(result.jobs.map(j => j.kind)).toContain('trace_principal');
    }
  });
  it('records missing positioned logs and changed canonical hashes without fabricating execution ordinals', async () => {
    const f = traceFixture(); delete f.containers[0].logs![0].position;
    const block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
    expect(block.transactions[0].bindingStatus).toBe('unsupported'); expect(block.transactions[0].logs).toEqual([]);
    const h = fakeAcquisition(r => r.method === 'eth_getBlockByNumber' && r.params?.[1] === false ? { hash: hash(999) } : traceFixture().responses(r));
    expect((await h.acquisition.acquire(cursor)).status).toBe('unreconciled');
  });
  it('bounds acquisition, caches missing responses, and propagates metered shutdown without retries', async () => {
    const h = fakeAcquisition(() => { throw new Error('Unsupported fixture method'); }, 1);
    const block = await h.acquisition.acquire(cursor); expect(block.status).toBe('missing');
    await h.acquisition.acquire(cursor); expect(h.requests).toHaveLength(3);
    expect(() => h.acquisition.acquire({ ...cursor, blockHash: hash(124), blockNumber: '124' })).toThrow('cache full');
    await h.acquisition.release(cursor);
    const stopped = fakeAcquisition(traceFixture().responses); stopped.meter.stop('shutdown_requested');
    await expect(stopped.acquisition.acquire(cursor)).rejects.toThrow(); expect(stopped.requests).toHaveLength(0);
  });
  it('decodes delegation/signatures and distinguishes code authorization, sponsor and action controller', async () => {
    const f = traceFixture(), implementation = address(77);
    expect(decodeDelegationCode(`0xef0100${implementation.slice(2)}`)).toBe(implementation);
    expect(decodeDelegationCode(`0xef0100${implementation.slice(2)}00`)).toBeNull();
    const signer = privateKeyToAccount(hash(1001)); // Synthetic fixture key, unrelated to any account.
    const nonce = 2n ** 54n, chain = 4663n;
    const digest = keccak256(concatHex(['0x05', toRlp([toHex(chain), implementation, toHex(nonce)])]));
    const signature = await signer.sign({ hash: digest });
    Object.assign(f.transaction, { authorizationList: [{ chainId: toHex(chain), address: implementation, nonce: toHex(nonce),
      r: signature.slice(0, 66), s: `0x${signature.slice(66, 130)}`, yParity: toHex(BigInt(`0x${signature.slice(130)}`) - 27n) }] });
    const block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
    expect(block.transactions[0].authorizations[0]).toMatchObject({ authority: signer.address.toLowerCase(), implementation, signatureValid: true, nonce: nonce.toString(), effective: 'unknown' });
    // No profile => no authenticated account principal, even with a valid delegation signature and sponsorship.
    const result = resolveTraceLaunchRoles(resolveLaunchRolesV2(f.roleInput), f.roleInput, block, { at, entryPoints: [] });
    expect(result.roles.find(r => r.role === 'launch_principal')?.address).toBeNull();
  });
  it('does not accept late, expired, wrong-code EntryPoint profiles or same-block availability from the future', async () => {
    const f = traceFixture(), block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
    for (const profile of [{ ...f.profiles[0], knownAt: { cursor, acquisitionSequence: '2' } },
      { ...f.profiles[0], effectiveUntil: { ...cursor, transactionIndex: 0, executionOrdinal: 0, boundary: 'before_tx' as const } },
      { ...f.profiles[0], effectiveFrom: cursor }, { ...f.profiles[0], codeHash: hash(1) }]) {
      const result = resolveTraceLaunchRoles(resolveLaunchRolesV2(f.roleInput), f.roleInput, block, { at, entryPoints: [profile] });
      expect(result.roles.find(r => r.role === 'launch_principal')?.address).toBeNull();
    }
  });
  it('preserves a private payer batch through 501-counterparty hub review without merging unrelated public-tool customers', async () => {
    const f = traceFixture(), execution = f.containers[0].calls![0];
    const extra = structuredClone(f.containers[1].calls![0].calls![0]); extra.from = account;
    execution.calls!.push(extra);
    const extraLog = { ...f.receipt.logs[3] };
    f.receipt.logs.splice(2, 0, extraLog);
    f.receipt.logs.forEach((l, i) => l.logIndex = toHex(i));
    f.roleInput.events[2].logIndex = 4; f.roleInput.events[2].ref = `${f.transaction.hash}:4`;
    f.roleInput.events = [...f.roleInput.events, { ...f.roleInput.events[2], logIndex: 2, ref: `${f.transaction.hash}:2` }];
    const block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
    expect(block.transactions[0].bindingStatus).toBe('complete');
    const service = { registry: { version: '2.1.0', entries: [] }, address: tool, codeHash: hash(55), implementation: address(77), at,
      launches: [], launchCoverageComplete: false, degree: { fromSec: '13600', throughSec: '100000', counterparties: Array.from({ length: 501 }, (_, i) => address(1000 + i)),
        complete: false, knownAt: at, evidenceIds: [hash(90)] } };
    const result = resolveTraceLaunchRoles(resolveLaunchRolesV2(f.roleInput), f.roleInput, block, { at, entryPoints: f.profiles, service });
    expect(result.service).toMatchObject({ hub: 'review', stopControlExpansion: true, preserveEconomicExposure: true });
    const payers = result.roles.filter(r => r.role === 'buy_payer');
    expect(payers.map(r => r.address)).toEqual([account, account, otherAccount]);
    expect(payers[0].refs).toContain(`userop:${f.operationHashes[0]}`);
    expect(payers[1].refs).toContain(`userop:${f.operationHashes[0]}`);
    expect(payers[2].refs).toContain(`userop:${f.operationHashes[1]}`);
    expect(result.roles.filter(r => r.role === 'buy_recipient')).toHaveLength(3);
  });
  it('resolves actual ERC20 sell debit separately from a router/event sender and proceeds recipient', async () => {
    const f = traceFixture(), selling = f.containers[1].calls![0].calls![0].calls![0], curve = selling.to!;
    const transfer = { address: coin, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: otherAccount, to: curve } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters('uint256'), [200n]), position: 0 };
    const sale = { address: curve, topics: encodeEventTopics({ abi: ponsCurveAbi, eventName: 'CurveSell', args: { seller: tool, recipient: otherRecipient } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [200n, 80n, 1n, 1n]), position: 2 };
    selling.value = '0x0'; selling.logs = [sale];
    selling.calls = [{ type: 'CALL', from: curve, to: coin, input: '0x', value: '0x0', logs: [transfer] },
      { type: 'CALL', from: curve, to: otherRecipient, input: '0x', value: '0x50' }];
    f.receipt.logs.splice(3, 1, { ...transfer, transactionHash: f.transaction.hash, logIndex: '0x3' }, { ...sale, transactionHash: f.transaction.hash, logIndex: '0x4' });
    f.receipt.logs.forEach((l, i) => l.logIndex = toHex(i));
    f.roleInput.events = f.roleInput.events.map((e, i) => i === 2 ? { ...e, logIndex: 4, ref: `${f.transaction.hash}:4`, data: { token: coin, side: -1, seller: tool, recipient: otherRecipient } } : e);
    const block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
    expect(block.transactions[0].bindingStatus).toBe('complete');
    const result = resolveTraceLaunchRoles(resolveLaunchRolesV2(f.roleInput), f.roleInput, block, { at, entryPoints: f.profiles });
    expect(result.roles.find(r => r.role === 'sell_source')).toMatchObject({ address: otherAccount, status: 'verified' });
    expect(result.roles.find(r => r.role === 'proceeds_recipient')).toMatchObject({ address: otherRecipient, status: 'verified' });
  });
  it('authenticates signed delegated self-execution and reconciles an acquired creation-cost debit', async () => {
    const f = traceFixture(), factoryCall = f.containers[0].calls![0].calls![0].calls![0], feeAsset = address(80), feeRecipient = address(81);
    const fee = { address: feeAsset, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: account, to: feeRecipient } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters('uint256'), [10n]), position: 0 };
    factoryCall.calls = [{ type: 'CALL', from: factoryCall.to!, to: feeAsset, input: '0x', value: '0x0', logs: [fee] }];
    factoryCall.logs![0].position = 1;
    f.root.from = account; f.root.to = account; f.root.input = '0x1234'; f.root.calls = f.containers[0].calls![0].calls;
    f.transaction.from = account; f.transaction.to = account; f.transaction.input = '0x1234';
    f.receipt.logs = [{ ...fee, transactionHash: f.transaction.hash, logIndex: '0x0' }, { ...f.receipt.logs[0], logIndex: '0x1' }, { ...f.receipt.logs[1], logIndex: '0x2' }];
    f.roleInput.events = f.roleInput.events.slice(0, 2).map((e, i) => ({ ...e, logIndex: i + 1, ref: `${f.transaction.hash}:${i + 1}`, data: { ...e.data, outerFrom: account, outerTo: account } }));
    const block = await fakeAcquisition(f.responses).acquisition.acquire(cursor);
    const basic = resolveLaunchRolesV2(f.roleInput);
    expect(basic.roles.find(r => r.role === 'launch_principal')?.address).toBeNull();
    const result = resolveTraceLaunchRoles(basic, f.roleInput, block, { at, entryPoints: [], creationFee: { asset: feeAsset, recipient: feeRecipient, raw: '10', evidenceRef: 'fixture-creation-cost' } });
    expect(result.roles.find(r => r.role === 'launch_principal')).toMatchObject({ address: account, status: 'verified' });
    expect(result.roles.find(r => r.role === 'creation_payer')).toMatchObject({ address: account, status: 'verified' });
    expect(result.jobs.map(j => j.kind)).not.toContain('creation_payer');
    const mismatch = resolveTraceLaunchRoles(basic, f.roleInput, block, { at, entryPoints: [], creationFee: { asset: feeAsset, recipient: feeRecipient, raw: '11', evidenceRef: 'fixture-creation-cost' } });
    expect(mismatch.roles.find(r => r.role === 'creation_payer')?.address).toBeNull();
  });
});
