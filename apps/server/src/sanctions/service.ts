import { createHash } from 'node:crypto';
import type { ChainDb } from '@eko/db';
import type { ApiError, ErrorCode } from '@eko/shared';
import { ERROR_STATUS } from '../http/v1/helpers.js';
import { normalizeWallet, parseSdn } from './parser.js';
import { isTreasuryRedirect, isTreasurySource } from './source.js';

export class ScreeningError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ErrorCode) {
    super(code === 'sanctioned' ? 'Trading is unavailable for this wallet.' : 'Trading checks are unavailable. Try again later.');
    this.statusCode = ERROR_STATUS[code];
  }
  body(): ApiError { return { error: this.code, message: this.message }; }
}
// TODO(spec): No maximum sanctions snapshot age is specified. Retain the last complete snapshot on failures;
// without any usable complete snapshot, refuse quotes/orders with stale_data (never treat a missing list as empty).
/** One service for quote and order callers. Reads current committed data on every check. */
export class SanctionsService {
  /**
   * Retain sanctions snapshot storage. Host-only construction; no screening occurs and callers must
   * supply resolved trading wallet identities to checks.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  constructor(private readonly db: ChainDb) {}
  /**
   * Check the normalized wallet against the latest complete nonempty sanctions snapshot on each
   * call. Caller supplies the authenticated trading wallet; absent/invalid snapshot or DB failure
   * becomes stale_data and listed wallets throw sanctioned. No maximum snapshot age is imposed here;
   * absent wallet still requires usable data.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async assertWallet(wallet?: string | null): Promise<void> {
    try {
      const result = await this.db.sql.query<{ listed: boolean }>(
        'SELECT $1 = ANY(addresses) AS listed FROM ofac_sdn WHERE cardinality(addresses)>0 AND record_count>0 ORDER BY version DESC LIMIT 1',
        [wallet ? normalizeWallet(wallet) : null],
      );
      if (!result.rows[0]) throw new ScreeningError('stale_data');
      if (result.rows[0].listed) throw new ScreeningError('sanctioned');
    } catch (error) {
      if (error instanceof ScreeningError) throw error;
      throw new ScreeningError('stale_data');
    }
  }
  /**
   * Return latest stored snapshot and refresh-attempt metadata or nulls. Public operational read, no
   * wallet auth; SQL failures reject. Reading age does not itself enforce an age ceiling.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async freshness() {
    const snapshot = (await this.db.sql.query<{ version: string; refreshed_at: Date; published_at: Date; address_count: number }>(
      'SELECT version, refreshed_at, published_at, cardinality(addresses) AS address_count FROM ofac_sdn ORDER BY version DESC LIMIT 1',
    )).rows[0];
    const refresh = (await this.db.sql.query<{ attempted_at: Date; failed: boolean }>('SELECT attempted_at, failed FROM ofac_refresh WHERE id=1')).rows[0];
    return { snapshot: snapshot ?? null, refresh: refresh ?? null };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Bounded public-list HTTP read. Never sends account data, cookies or authentication.
 * @remarks
 * Fetch only credential-free Treasury HTTPS XML, with a 30-second overall timeout and 32 MB
 * streaming cap. Treasury's list service answers with redirects (treasury.gov to the Sanctions
 * List Service to a signed link in its published-file bucket), so up to three redirects are
 * followed by hand and every hop must stay on those hosts. Host source selection only; invalid
 * source or hop, HTTP/body/size/UTF-8/transport failures reject and no user data is sent.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function downloadSdn(url: string): Promise<string> {
  let target = new URL(url);
  if (!isTreasurySource(target)) throw new Error('Invalid source');
  const signal = AbortSignal.timeout(30_000);
  let response = await fetch(target, { redirect: 'manual', signal, headers: { accept: 'application/xml, text/xml' } });
  for (let hops = 0; response.status >= 300 && response.status < 400; hops++) {
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (hops >= MAX_REDIRECTS || !location) throw new Error('Source unavailable');
    target = new URL(location, target);
    if (!isTreasuryRedirect(target)) throw new Error('Invalid source');
    response = await fetch(target, { redirect: 'manual', signal, headers: { accept: 'application/xml, text/xml' } });
  }
  if (response.status !== 200 || !response.body || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('Source unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw new Error('Source too large');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel(); }
}

export class SanctionsWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  /**
   * Wire storage, configured public source, bounded downloader, clock and finite outcome observer.
   * Host-only construction; no download/timer starts until lifecycle methods.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  constructor(private readonly db: ChainDb, private readonly source?: string,
    private readonly download: (url: string) => Promise<string> = downloadSdn,
    private readonly now: () => number = Date.now,
    private readonly observe: (failed: boolean) => void = () => {}) {}

  /** Startup checks persisted cadence; a restart cannot cause another daily download.
   * @remarks
   * Start a one-minute refresh timer once and immediately tick using persisted daily cadence. Host
   * worker call, no wallet auth. Refresh failures are recorded/reported through tick rather than
   * treated as an empty list.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
  }
  /**
   * Clear the refresh timer and await in-flight work. Host shutdown call, no wallet auth; a throwing
   * injected observation callback can still reject the pending work.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
  /**
   * Share one refresh promise per instance; preserve the last complete snapshot and report refresh
   * failure through the observer. Host worker call; no wallet auth. Normal acquisition/storage
   * failures are caught; injected observer failures may reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.refresh().catch(() => { this.observe(true); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async refresh() {
    const prior = (await this.db.sql.query<{ attempted_at: Date }>('SELECT attempted_at FROM ofac_refresh WHERE id=1')).rows[0];
    if (prior && this.now() - new Date(prior.attempted_at).getTime() < DAY_MS) return;
    const attempted = new Date(this.now());
    // Mark in-progress as failed until the complete snapshot and success status commit together.
    await this.db.sql.query('INSERT INTO ofac_refresh(id,attempted_at,failed) VALUES(1,$1,true) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,failed=true', [attempted]);
    try {
      if (!this.source) throw new Error('Source unconfigured');
      const raw = await this.download(this.source), parsed = parseSdn(raw);
      await this.db.tx(async tx => {
        const previous = (await tx.sql.query<{ published_at: Date }>('SELECT published_at FROM ofac_sdn ORDER BY version DESC LIMIT 1')).rows[0];
        if (previous && Date.parse(parsed.publishedAt) < new Date(previous.published_at).getTime()) throw new Error('Source regressed');
        await tx.sql.query('INSERT INTO ofac_sdn(digest,refreshed_at,published_at,record_count,addresses) VALUES($1,$2,$3,$4,$5)',
          [createHash('sha256').update(raw).digest('hex'), new Date(this.now()), parsed.publishedAt, parsed.recordCount, parsed.addresses]);
        await tx.sql.query('UPDATE ofac_refresh SET failed=false WHERE id=1');
      });
      this.observe(false);
    } catch { this.observe(true); } // No provider errors, source URLs or wallet/account context enter logs.
  }
}
