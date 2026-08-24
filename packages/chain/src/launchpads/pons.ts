import { decodeEventLog, getAddress, type AbiEvent, type Address } from 'viem';
import { ponsCurveAbi, ponsFactoryAbi } from '../abis.js';
import { resolveActor, type ActorContext, type ActorTransaction } from '../actor.js';
import { eventSelector, type DecoderLog } from '../decoders.js';
import type { AddressRegistry } from '../registry.js';
import type { LaunchpadAdapter, LaunchpadEvent } from './types.js';
export interface PonsContext extends ActorContext {
  registry: AddressRegistry;
  tokenForCurve(curve: Address): Address | null;
}
const supportedNames = ['TokenLaunched', 'CurveBuy', 'CurveSell', 'SnipeTaxExempted'];
const supportedOf = (abi: readonly unknown[]) => (abi as readonly { type: string; name?: string }[]).filter((a): a is AbiEvent => a.type === 'event' && supportedNames.includes(a.name ?? ''));
const factoryEvents = supportedOf(ponsFactoryAbi), curveEvents = supportedOf(ponsCurveAbi);
export function decodePonsResult(log: DecoderLog, tx: ActorTransaction, ctx: PonsContext): { events: LaunchpadEvent[]; unknownTopics: number; malformedLogs: number } {
  const factory = ctx.registry.addressOf('pons.factory');
  const fromFactory = factory?.toLowerCase() === log.address.toLowerCase();
  const token = ctx.tokenForCurve(getAddress(log.address));
  // Selectors are hashed once per event (decoders.ts), and the log is decoded against the one event that matches.
  const matched = (fromFactory ? factoryEvents : token ? curveEvents : []).find(a => eventSelector(a) === log.topics[0]);
  if (!matched) return { events: [], unknownTopics: 1, malformedLogs: 0 };
  try {
    const event = decodeEventLog({ abi: [matched], topics: log.topics, data: log.data, strict: true });
    const a = event.args as Record<string, Address | bigint>;
    let result: LaunchpadEvent;
    if (event.eventName === 'TokenLaunched') result = { kind: 'launch', token: a.token as Address, deployer: a.deployer as Address, curve: a.curve as Address,
      pairToken: a.pairToken as Address, launchConfigId: a.launchConfigId as bigint, graduationThreshold: a.graduationThreshold as bigint };
    else if (event.eventName === 'SnipeTaxExempted') result = { kind: 'exempt', token: token!, wallet: a.account as Address };
    else {
      const buy = event.eventName === 'CurveBuy';
      result = { kind: 'trade', token: token!, actor: resolveActor(tx, ctx), side: buy ? 1 : -1, amountToken: (buy ? a.tokensOut : a.tokensIn) as bigint, amountEth: (buy ? a.quoteIn : a.quoteOut) as bigint, feeEth: a.fee as bigint, taxEth: a.tax as bigint, ...(buy ? { buyer: a.buyer as Address } : { seller: a.seller as Address }), recipient: a.recipient as Address };
    }
    return { events: [result], unknownTopics: 0, malformedLogs: 0 };
  } catch { return { events: [], unknownTopics: 0, malformedLogs: 1 }; }
}
export function decodePons(log: DecoderLog, tx: ActorTransaction, ctx: PonsContext): LaunchpadEvent[] {
  return decodePonsResult(log, tx, ctx).events;
}
/** Apply per launch/curve, not globally: a wallet can be exempt on multiple tokens. */
export function dedupeExempt(events: readonly LaunchpadEvent[]): LaunchpadEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    if (event.kind !== 'exempt') return true;
    const key = `${event.token.toLowerCase()}:${event.wallet.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export interface PonsReadClient {
  readContract(input: { address: Address; abi: typeof ponsCurveAbi; functionName: 'currentSnipeTaxBps'; args: readonly [Address]; blockNumber: bigint }): Promise<bigint>;
}
export function createPonsAdapter(ctx: PonsContext, options: {
  client?: PonsReadClient;
  curveForToken?: (token: Address) => Address | null;
  /** Verified timing source, if available. */
  endsInSec?: (token: Address, block: bigint) => Promise<number | null>;
} = {}): LaunchpadAdapter {
  return {
    id: 'pons',
    addresses: () => ['pons.factory', 'pons.v4Hook', 'pons.router'].flatMap(key => {
      const address = ctx.registry.addressOf(key as 'pons.factory' | 'pons.v4Hook' | 'pons.router'); return address ? [address] : [];
    }),
    decode: (log, tx) => decodePons(log, tx, ctx),
    ...(options.client && options.curveForToken ? {
      async antiSnipe(token: Address, block: bigint) {
        const curve = options.curveForToken!(token);
        if (!curve) return null;
        const bps = await options.client!.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'currentSnipeTaxBps', args: [token], blockNumber: block });
        if (bps < 0n || bps > 10000n) throw new Error('Invalid currentSnipeTaxBps');
        // TODO(spec): decay timing is unverified. Active tax needs an injected timing source; never invent endsInSec.
        const endsInSec = bps === 0n ? 0 : await options.endsInSec?.(token, block);
        return endsInSec == null ? null : { taxPct: Number(bps) / 100, endsInSec };
      },
    } : {}),
  };
}
// TODO(spec): CurveCompleted/PoolGraduated/LaunchSwept, creator fees and native buybacks need real logs.
// TODO(spec): The Pons router launch topic 0xdcacba5e… remains unidentified and is counted as unknown.

export interface PonsProfileClient {
  /** Background acquisition rejects on outage instead of waiting behind foreground acquisition. */
  outageNonBlocking?: boolean;
  readContract(input: { address: Address; abi: typeof ponsCurveAbi; functionName: 'currentSnipeTaxBps' | 'creatorTaxBps' | 'feeBps'; args?: readonly [Address]; blockNumber: bigint }): Promise<bigint>;
  getCode(input: { address: Address; blockNumber: bigint }): Promise<`0x${string}` | undefined>;
  /**
   * The three getters in one call at the block (Multicall3), failing if any getter fails: one paid request instead of
   * three, under a per-minute limit the sell check shares. Without it, each getter is read on its own.
   */
  readGetters?(input: { curve: Address; token: Address; blockNumber: bigint }): Promise<readonly [creatorTaxBps: bigint, feeBps: bigint, currentSnipeTaxBps: bigint]>;
}
/** Archive reads at the requested block; failed reads remain absent at the caller. */
export async function readPonsProfile(client: PonsProfileClient, token: Address, curve: Address, blockNumber: bigint) {
  const [[creator, fee, snipe], code] = await Promise.all([
    client.readGetters ? client.readGetters({ curve, token, blockNumber }) : Promise.all([
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps', blockNumber }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'feeBps', blockNumber }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'currentSnipeTaxBps', args: [token], blockNumber }),
    ]),
    client.getCode({ address: token, blockNumber }),
  ]);
  if ([creator, fee, snipe].some(v => v < 0n || v > 10000n) || !code || code === '0x') throw new Error('Invalid Pons profile');
  return { creatorTaxPct: Number(creator) / 100, feePct: Number(fee) / 100, antiSnipeActive: snipe > 0n, code };
}
