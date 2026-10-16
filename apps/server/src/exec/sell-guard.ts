import { withRpcOrigin } from '@eko/chain';
import type { ChainDb } from '@eko/db';
import { SellChecker, readSellChecks, recordSellRefusal, type SellCheckResult } from '@eko/engines';
import type { Address } from '@eko/shared';

/** The subset of the metered mainnet client the quote guard uses. */
export interface SellGuardClient {
  getBlockNumber(): Promise<bigint>;
  request(input: { method: string; params: readonly unknown[] }): Promise<unknown>;
}
/** A stored engine reading this recent stands in for a quote-time probe (the per-order simulation still runs). */
export const STORED_SELL_CHECK_MAX_AGE_MS = 120_000;
/**
 * Quote-time sell check (BACKEND §12 "the sell fails (honeypot)" hard refusal). Every buy quote uses the engines'
 * stored reading when it is at most two minutes old (owner decision 2026-10-06), else re-simulates the round trip at
 * the quoted size on the current block through the API's metered RPC client; probe results are reused only for the
 * same coin, size and block. The per-order exact-account simulation runs either way.
 * TODO(spec): §12 re-simulates "with the user's own address"; the probe is a fresh contract address, so an
 * address-specific blacklist of the user's own wallet is not covered until an EOA simulation exists.
 */
export class SellGuard {
  private readonly checker: SellChecker;
  private readonly recent = new Map<string, Promise<SellCheckResult>>();
  /**
   * Wire the chain database (indexed routes, ETH-USD, stored readings, refusal counts) and the API's metered mainnet
   * client. `probe: false` uses stored readings only. Host construction only; no request is made until a buy quote.
   */
  constructor(private readonly db: ChainDb, private readonly client: SellGuardClient, private readonly now: () => number = Date.now,
    private readonly options: { probe?: boolean; storedMaxAgeMs?: number } = {}) {
    this.checker = new SellChecker(db, { request: input => withRpcOrigin('server.sell_guard.rawL29',()=>client.request(input)) }, { now });
  }
  /**
   * The coin's sell check for a buy of `amountUsd`: the engines' stored reading (sellable or refused) when it is at
   * most two minutes old, else a fresh simulation of the buy and the sell of everything it bought, on the current
   * block. Public quote path; the caller (TradeService) refuses on any status but `sellable`. With probing off and no
   * recent reading, and on provider or budget errors, this rejects, which the caller also treats as a refusal.
   */
  async check(coin: Address, amountUsd: number): Promise<SellCheckResult> {
    const stored = (await readSellChecks(this.db, [coin.toLowerCase() as Address], this.now(),
      this.options.storedMaxAgeMs ?? STORED_SELL_CHECK_MAX_AGE_MS)).get(coin.toLowerCase() as Address);
    if (stored) return { coin, block: stored.block, status: stored.status, route: null, ethUsd: null, probes: [], requests: 0, exit100: stored.exit100, exit1k: stored.exit1k };
    if (this.options.probe === false) throw new Error('No recent stored sell check, and quote-time probing is off');
    const block = Number(await this.client.getBlockNumber());
    if (!Number.isSafeInteger(block) || block < 0) throw new Error('Invalid block number');
    const key = `${coin.toLowerCase()}:${block}:${amountUsd}`;
    let found = this.recent.get(key);
    if (!found) {
      found = this.checker.check(coin.toLowerCase() as Address, block, [amountUsd]);
      this.recent.set(key, found);
      found.catch(() => this.recent.delete(key));
      if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
    }
    return found;
  }
  /** Count the refusal for Radar's "Honeypots refused"; the coin, block and size only. */
  refused(result: SellCheckResult, amountUsd: number) { return recordSellRefusal(this.db, result, new Date(this.now()), amountUsd); }
}
