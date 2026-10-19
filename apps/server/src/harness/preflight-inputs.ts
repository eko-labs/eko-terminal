import { BlueChipReader, type BlueChipConfig } from '../read/blue-chip.js';
import { binary, type ChainDb } from '@eko/db';
import { normalizeInstrument } from '@eko/policy';
import { AddressSchema } from '@eko/shared';
import { ReadStore } from '../read/store.js';
import type { CachedPreflightInputs, PreflightInputs } from './preflight.js';

/** Oldest indexed 1-minute close used to size a qty-only order; older prices leave notional unknown. */
export const PREFLIGHT_PRICE_MAX_AGE_MS = 15 * 60_000;

const none = (guardPolicyV2: boolean): PreflightInputs =>
  ({ guardPolicyV2, verdictFor: () => undefined, cardFor: () => undefined, priceFor: () => undefined });

/**
 * Read the indexed close of the latest 1-minute bar inside the freshness window, or undefined when
 * the coin has no recent priced bar. Read-only SQL on the supplied transaction; failures reject.
 */
export async function recentCoinPrice(db: ChainDb, coin: string, now: number) {
  // TODO(spec): §9.6 notional falls back to "cached USD price" without a freshness bound. Use
  // the indexed 1m close only when it is at most 15 minutes old; otherwise deny missing_notional.
  const row = (await db.sql.query<{ close: number | string | null }>(
    `SELECT close FROM bars_1m WHERE coin=$1 AND minute>=to_timestamp($2::double precision)
     AND minute<=to_timestamp($3::double precision) ORDER BY minute DESC LIMIT 1`,
    [binary(coin), (now - PREFLIGHT_PRICE_MAX_AGE_MS) / 1000, now / 1000])).rows[0];
  const price = row?.close == null ? NaN : Number(row.close);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

/**
 * Stored Senses for MCP preflight: the latest non-orphaned V1 verdict, the engine card and a
 * recent indexed price for the order's own Robinhood Chain coin, read once inside the preflight
 * transaction. Reads only cached engine output; no simulation, RPC or acquisition runs, and a
 * coin EKO has not checked yet stays undefined so the pure policy denies with scan_pending.
 * Other venues and sells read nothing. Guard V2 policies keep their existing unavailable
 * actual-order evidence (052) and therefore deny.
 */
export const storedPreflightInputs: CachedPreflightInputs = (...args) => blueChipPreflightInputs()(...args);
/** Build cached membership inputs from trusted host configuration. Reads only the order coin on buys
 * inside the caller's transaction, and never acquires external data. Missing membership denies
 * the optional category policy, while disabled configuration preserves original evaluations.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Policy invariants}
 */
export const blueChipPreflightInputs = (config?: BlueChipConfig): CachedPreflightInputs => async (request, policy, _agent, now, tx) => {
  const guardPolicyV2 = policy.guardPolicyVersion === 2;
  const order = request.order;
  const coin = order.venue === 'rhc' && order.side === 'buy' ? AddressSchema.safeParse(order.instrument.trim()) : undefined;
  if (!coin?.success) return {...none(guardPolicyV2),blueChipEnabled:config?.enabled};
  const asset = normalizeInstrument(order.venue, coin.data);
  const store = new ReadStore(tx, () => now);
  const verdict = await store.verdict(coin.data) ?? undefined;
  const card = await store.card(coin.data) ?? undefined;
  const price = await recentCoinPrice(tx, coin.data, now);
  const member=config?.enabled ? (await new BlueChipReader(tx,config,()=>now).members([coin.data])).get(coin.data.toLowerCase() as `0x${string}`)?.member : undefined;
  return { guardPolicyV2,blueChipEnabled:config?.enabled,blueChipFor:instrument=>instrument===asset && member===true,
    verdictFor: instrument => instrument === asset ? verdict : undefined,
    cardFor: instrument => instrument === asset ? card : undefined,
    priceFor: (venue, instrument) => venue === 'rhc' && instrument === asset ? price : undefined };
};
