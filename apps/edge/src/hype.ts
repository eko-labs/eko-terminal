/**
 * HYPE in USD, from Hyperliquid's public info API (no key; 1,200 weight a minute per IP, allMids costs 2).
 * Refreshed at most every `ttlMs`; the last good value is kept through failures, and null means never known.
 */
export class HypeUsd {
  private value: number | null = null;
  private at = 0;
  private flight: Promise<void> | null = null;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly url = 'https://api.hyperliquid.xyz/info', private readonly ttlMs = 30_000, private readonly now = () => Date.now()) {}
  get latest(): number | null { return this.value; }
  async get(): Promise<number | null> {
    if (this.now() - this.at < this.ttlMs && this.value !== null) return this.value;
    this.flight ??= this.refresh().finally(() => { this.flight = null; });
    await this.flight;
    return this.value;
  }
  private async refresh() {
    try {
      const res = await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const mids = await res.json() as Record<string, string>;
      const price = Number(mids.HYPE);
      if (Number.isFinite(price) && price > 0) { this.value = price; this.at = this.now(); }
    } catch { /* keep the last good value */ }
  }
}
