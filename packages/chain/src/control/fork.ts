import { keccak256, toFunctionSelector, toHex, type Hex } from 'viem';
import { referenceDigest } from '../simulation/reference.js';
import type { MeteredForkLease } from '../simulation/types.js';
import { CONTROL_SELECTORS, CONTROL_SLOTS, controlWordAddress, inertAuthority } from './collector.js';
import { ControlInspectionSchema, ControlProfileSchema, ControlRecipeSchema, ControlConfirmationSchema, controlBytes } from './types.js';
import type { ControlInspection, ControlRecipe, ControlConfirmation, ControlProfile } from './types.js';
const word = (value: unknown): Hex => {
  const b = controlBytes.parse(value); if (b.length !== 66) throw new Error('Expected fork state word'); return b;
};
export function controlStateChanged(recipe: ControlRecipe, before: Hex, after: Hex) {
  if (recipe.effect === 'uint_increase') return BigInt(after) > BigInt(before);
  if (recipe.effect === 'uint_decrease') return BigInt(after) < BigInt(before);
  if (recipe.effect === 'false_to_true') return BigInt(before) === 0n && BigInt(after) === 1n;
  const a = controlWordAddress(before), b = controlWordAddress(after);
  return a !== null && b !== null && a !== b && !inertAuthority(b);
}
const effectFor = { tax_raise: 'uint_increase', blacklist: 'false_to_true', sell_pause: 'false_to_true', mint: 'uint_increase', transfer_upgrade: 'address_change' } as const;

/** Local transactions only, under the existing exclusive metered fork lease.
 * Never impersonate a contract authority or override token/permission storage. */
export class GenericControlFork {
  constructor(private readonly lease: MeteredForkLease) {}
  async confirm(raw: ControlInspection, recipes: ControlRecipe[]): Promise<ControlProfile> {
    const inspection = ControlInspectionSchema.parse(raw);
    if (recipes.length > 16) throw new Error('Control recipe budget exceeded');
    const plans = recipes.map(r => ControlRecipeSchema.parse(r));
    if (new Set(plans.map(r => r.capability)).size !== plans.length) throw new Error('Ambiguous capability recipes');
    const confirmations: ControlConfirmation[] = [];
    for (const recipe of plans) confirmations.push(await this.probe(inspection, recipe));
    const body = { schemaVersion: 'generic-control-profile-1' as const, inspection, confirmations };
    return ControlProfileSchema.parse({ ...body, id: referenceDigest(body) });
  }
  private async probe(s: ControlInspection, recipe: ControlRecipe): Promise<ControlConfirmation> {
    let status: ControlConfirmation['status'] = 'unsupported', before: Hex | null = null, after: Hex | null = null;
    let earlyRejected: boolean | null = null, elapsedSec: number | null = null;
    const trace: unknown[] = [];
    const result = () => ControlConfirmationSchema.parse({ recipe, status, before, after, earlyRejected, elapsedSec, trace, traceHash: referenceDigest(trace) });
    if (recipe.implementationHash !== s.implementationHash || recipe.configurationHash !== s.configurationHash ||
      !(recipe.capability in effectFor) || effectFor[recipe.capability as keyof typeof effectFor] !== recipe.effect ||
      !s.selectors.some(p => p.selector === recipe.selector && p.capability === recipe.capability) ||
      !CONTROL_SELECTORS.some(p => p.selector === recipe.selector && p.capability === recipe.capability) ||
      !recipe.execute.data.startsWith(recipe.selector)) return result();
    if (recipe.capability === 'transfer_upgrade' && !(recipe.read.kind === 'storage' && recipe.read.target === s.coin && recipe.read.slot === CONTROL_SLOTS.implementation ||
      recipe.read.kind === 'call' && s.path.some(p => p.beacon === recipe.read.target) && recipe.read.data === toFunctionSelector('implementation()'))) return result();
    const authority = s.roles.find(r => r.target === recipe.authorityTarget && r.address === recipe.authority && !r.inert);
    const caller = s.roles.find(r => r.address === recipe.caller && !r.inert && (recipe.caller === recipe.authority ? r === authority : r.target === recipe.authority));
    if (!authority || !caller || caller.codeHash !== keccak256('0x')) { status = 'unknown_authority'; return result(); }
    const allowed = new Set([s.coin, recipe.authority, ...s.path.flatMap(p => p.beacon ? [p.beacon] : [])]);
    if (![recipe.execute.target, recipe.read.target, recipe.authorityTarget, ...(recipe.queue ? [recipe.queue.target] : [])].every(t => allowed.has(t))) return result();
    try {
      await this.lease.withExclusive(async (rpc, reset) => {
        await reset(s.cursor);
        const header = await rpc.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(s.cursor.blockNumber)), false] }) as { hash?: string; timestamp?: string };
        if (header?.hash?.toLowerCase() !== s.cursor.blockHash.toLowerCase() || BigInt(header.timestamp ?? '-1') !== BigInt(s.cursor.timestampSec) || BigInt(await rpc.request({ method: 'eth_chainId', params: [] }) as string) !== BigInt(s.cursor.chainId)) throw new Error('Control fork pin mismatch');
        for (const p of s.path) {
          if (keccak256(controlBytes.parse(await rpc.request({ method: 'eth_getCode', params: [p.address, 'latest'] }))) !== p.codeHash) throw new Error('Control fork code mismatch');
          if (p.beacon && keccak256(controlBytes.parse(await rpc.request({ method: 'eth_getCode', params: [p.beacon, 'latest'] }))) !== p.beaconCodeHash) throw new Error('Control fork beacon mismatch');
        }
        if (controlBytes.parse(await rpc.request({ method: 'eth_getCode', params: [recipe.caller, 'latest'] })) !== '0x') throw new Error('Control caller is not an EOA');
        const read = async () => word(await rpc.request(recipe.read.kind === 'storage'
          ? { method: 'eth_getStorageAt', params: [recipe.read.target, recipe.read.slot, 'latest'] }
          : { method: 'eth_call', params: [{ to: recipe.read.target, data: recipe.read.data }, 'latest'] }));
        before = await read();
        let beforeCode: Hex | null = null;
        if (recipe.capability === 'transfer_upgrade') {
          const address = controlWordAddress(before);
          if (!address) throw new Error('Missing old implementation');
          beforeCode = controlBytes.parse(await rpc.request({ method: 'eth_getCode', params: [address, 'latest'] }));
        }
        // Gas funding alone changes native balance. All authorization checks and token storage stay real.
        await rpc.request({ method: 'anvil_setBalance', params: [recipe.caller, toHex(10n ** 18n)] });
        await rpc.request({ method: 'anvil_impersonateAccount', params: [recipe.caller] });
        const send = async (tx: ControlRecipe['execute']) => {
          const hash = controlBytes.parse(await rpc.request({ method: 'eth_sendTransaction', params: [{ from: recipe.caller, to: tx.target, data: tx.data, value: '0x0', gas: toHex(10_000_000n) }] }));
          const receipt = await rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as { status?: string; blockNumber?: string };
          if (!receipt || !['0x0', '0x1'].includes(receipt.status ?? '')) throw new Error('Missing control fork receipt');
          const frame = await rpc.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer', tracerConfig: { withLog: true } }] });
          trace.push({ tx, hash, receipt, frame }); return receipt;
        };
        try {
          if (recipe.queue) {
            if ((await send(recipe.queue)).status !== '0x1') { status = 'reverted'; return; }
            earlyRejected = (await send(recipe.execute)).status === '0x0';
            if (!earlyRejected || await read() !== before) { status = 'unsupported'; return; }
            await rpc.request({ method: 'evm_increaseTime', params: [recipe.delaySec] });
            await rpc.request({ method: 'evm_mine', params: [] });
          }
          const receipt = await send(recipe.execute); after = await read();
          const end = await rpc.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }) as { timestamp?: string };
          const elapsed = BigInt(end.timestamp ?? '-1') - BigInt(s.cursor.timestampSec);
          if (elapsed < 0n || elapsed > 86410n) throw new Error('Unsupported fork execution time');
          elapsedSec = Number(elapsed);
          if (recipe.queue && elapsedSec < recipe.delaySec) throw new Error('Timelock time mismatch');
          let delta = controlStateChanged(recipe, before!, after);
          if (delta && recipe.capability === 'transfer_upgrade') {
            const address = controlWordAddress(after);
            const code = address ? controlBytes.parse(await rpc.request({ method: 'eth_getCode', params: [address, 'latest'] })) : '0x';
            delta = code !== '0x' && beforeCode !== null && keccak256(code) !== keccak256(beforeCode);
            trace.push({ implementationBeforeHash: beforeCode ? keccak256(beforeCode) : null, implementationAfterHash: keccak256(code) });
          }
          status = receipt.status !== '0x1' ? 'reverted' : delta ? 'changed' : 'no_change';
        } finally { await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [recipe.caller] }); }
      });
    } catch { status = 'failed'; }
    return result();
  }
}
