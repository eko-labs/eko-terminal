import { describe, it, expect } from 'vitest';
import { toFunctionSelector, toHex, keccak256 } from 'viem';
import { inspectGenericControls, observedControlSelectors, CONTROL_SLOTS } from '../src/control/collector.js';
import { GenericControlFork } from '../src/control/fork.js';
import { SerializedMeteredForkLease } from '../src/simulation/anvil.js';
import { archiveFixture, forkFixture, coin, owner, impl, timelock, cursor, address, hash, recipeFor, runtime, selector } from './control-fixtures.js';

const inspect = (f = archiveFixture(), extra = {}) => inspectGenericControls(f.clients, { coin, cursor, launchpad: 'other', ...extra });
describe('069 generic control collection: synthetic archive only', () => {
  it.each(['eip1967', 'beacon', 'clone'] as const)('resolves bounded %s implementations with pinned code evidence', async proxy => {
    const f = archiveFixture({ proxy }); const s = await inspect(f);
    expect(s.path.map(p => p.address)).toEqual([coin, impl]); expect(s.path[0].kind).toBe(proxy);
    expect(s.implementationHash).toBe(keccak256(runtime)); expect(s.selectors[0].capability).toBe('tax_raise');
    expect(f.calls.every(r => r.method !== 'eth_call' || r.params[1] === '0x64')).toBe(true);
    expect(s.requests).toBe(f.calls.length); expect(s.requests).toBeLessThan(128);
  });
  it('versions ownership, implementation, explicit configuration and block/hash; never caches across them', async () => {
    const first = await inspect(archiveFixture({ proxy: 'eip1967' }));
    const replacement = await inspect(archiveFixture({ proxy: 'eip1967', implementation: address(31) }));
    const inert = await inspect(archiveFixture({ inert: true }));
    const config = await inspect(archiveFixture(), { configurationReads: [{ target: coin, data: toFunctionSelector('sellTax()') }] });
    expect(new Set([first.profileHash, replacement.profileHash, inert.profileHash, config.profileHash]).size).toBe(4);
    expect(config.configurationHash).not.toBe(first.configurationHash);
    await expect(inspectGenericControls(archiveFixture().clients, { coin, cursor: { ...cursor, blockHash: hash('reorg') }, launchpad: 'other' })).rejects.toThrow('pin');
  });
  it('records zero owners without inventing absent roles, and confirms enumerable admin membership', async () => {
    const inert = await inspect(archiveFixture({ inert: true, role: true }));
    expect(inert.roles.some(r => r.inert)).toBe(true); expect(inert.roles.some(r => r.kind === 'default_admin' && r.address === owner)).toBe(true);
    const unknown = await inspect(archiveFixture({ noOwner: true })); expect(unknown.roles).toEqual([]); expect(unknown.gaps).toContain('failed');
  });
  it('leaves unknown code and missing selectors unknown; ignores PUSH payload substring lookalikes', async () => {
    const s = await inspect(archiveFixture({ runtime: '0x600000' })); expect(s.resolution).toBe('unknown'); expect(s.selectors).toEqual([]);
    expect(observedControlSelectors(`0x7f63${selector.slice(2)}${'00'.repeat(27)}`)).toEqual([]);
    const cycle = await inspect(archiveFixture({ proxy: 'eip1967', cycle: true })); expect(cycle.gaps).toContain('unsupported'); expect(cycle.implementationHash).toBeNull();
    await expect(inspect(archiveFixture(), { configurationReads: Array(17).fill({ target: coin, data: '0x' }) })).rejects.toThrow('budget');
    await expect(inspect(archiveFixture(), { launchpad: 'pons' })).rejects.toThrow('039');
  });
});
describe('069 isolated fork confirmation: synthetic local RPC state', () => {
  it.each([{ noOp: false, expected: 'changed' }, { noOp: true, expected: 'no_change' }, { revert: true, expected: 'reverted' }, { providerFailure: true, expected: 'failed' }])('requires a state delta, case $expected', async options => {
    const s = await inspect(); const f = forkFixture(s, options);
    const p = await new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset)).confirm(s, [recipeFor(s)]);
    expect(p.confirmations[0].status).toBe(options.expected); expect(f.resets()).toBe(1);
    expect(f.calls.filter(r => /setCode|setStorage|stateOverride/.test(r.method))).toEqual([]);
    if (!options.providerFailure) expect(f.calls.at(-1)?.method).toBe('anvil_stopImpersonatingAccount');
  });
  it('does not impersonate inert, unknown or contract authorities and rejects obsolete implementation recipes', async () => {
    const s = await inspect(archiveFixture({ inert: true })); const f = forkFixture(s);
    const simulator = new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset));
    expect((await simulator.confirm(s, [recipeFor(s)])).confirmations[0].status).toBe('unknown_authority'); expect(f.resets()).toBe(0);
    const unknown = await inspect(archiveFixture({ noOwner: true }));
    expect((await simulator.confirm(unknown, [recipeFor(unknown)])).confirmations[0].status).toBe('unknown_authority');
    const contract = await inspect(archiveFixture({ roleContract: true }));
    expect((await simulator.confirm(contract, [recipeFor(contract, { caller: timelock, authority: timelock })])).confirmations[0].status).toBe('unknown_authority');
    const valid = await inspect(); expect((await simulator.confirm(valid, [recipeFor(valid, { implementationHash: hash('old-implementation') })])).confirmations[0].status).toBe('unsupported');
    expect(f.resets()).toBe(0);
  });
  it.each([1800, 7200])('demonstrates a timelock early negative and later delta at %i seconds', async delay => {
    const s = await inspect(archiveFixture({ roleContract: true }), { roleTargets: [timelock] });
    const f = forkFixture(s, { delay }); const plan = recipeFor(s, { authority: timelock, queue: { target: timelock, data: toFunctionSelector('queue()'), value: '0' }, delaySec: delay });
    const p = await new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset)).confirm(s, [plan]);
    expect(p.confirmations[0]).toMatchObject({ status: 'changed', elapsedSec: delay, earlyRejected: true });
    expect(f.transactions()).toBe(3); expect(f.resets()).toBe(1);
    expect(f.calls.find(r => r.method === 'anvil_impersonateAccount')?.params).toEqual([owner]);
  });
  it('rejects a claimed timelock when early execution succeeds', async () => {
    const s = await inspect(archiveFixture({ roleContract: true }), { roleTargets: [timelock] }); const f = forkFixture(s, { delay: 1800, earlySucceeds: true });
    const p = await new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset)).confirm(s, [recipeFor(s, { authority: timelock, queue: { target: timelock, data: '0x12345678', value: '0' }, delaySec: 1800 })]);
    expect(p.confirmations[0].status).toBe('unsupported'); expect(p.confirmations[0].earlyRejected).toBe(false);
  });
  it('confirms transfer-code replacement only with a new nonempty implementation', async () => {
    const upgrade = toFunctionSelector('upgradeTo(address)');
    const s = await inspect(archiveFixture({ runtime: `0x63${upgrade.slice(2)}00` }));
    const f = forkFixture(s, { upgrade: true });
    const p = await new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset)).confirm(s, [recipeFor(s, { capability: 'transfer_upgrade', selector: upgrade,
      execute: { target: coin, data: `${upgrade}${toHex(BigInt(address(90)), { size: 32 }).slice(2)}`, value: '0' },
      read: { kind: 'storage', target: coin, slot: CONTROL_SLOTS.implementation }, effect: 'address_change' })]);
    expect(p.confirmations[0].status).toBe('changed');
    expect(p.confirmations[0].trace.at(-1)).toMatchObject({ implementationAfterHash: keccak256('0x600100') });
  });
  it('admits an inert owner plus live role member without certifying selector absence', async () => {
    const s = await inspect(archiveFixture({ inert: true, role: true })); const f = forkFixture(s);
    expect((await new GenericControlFork(new SerializedMeteredForkLease(f.rpc, f.reset)).confirm(s, [recipeFor(s)])).confirmations[0].status).toBe('changed');
  });
});
