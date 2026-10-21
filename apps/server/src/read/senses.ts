import { readCensus, readFlows, unavailableFlow, type ReceiptApiStore } from '@eko/db';
import { toUntrusted } from '@eko/untrusted';
import { UntrustedSchema, SenseCensusResultSchema, type Address, type PlaybookMatch } from '@eko/shared';
import type { GuardReadStore } from './guard-store.js';

/** Sanitize all nested third-party wrappers, including retained historical evidence. */
function sanitize<T>(value: T, maxLen = 280): T {
  if (!value || typeof value !== 'object') return value;
  const wrapped = UntrustedSchema.safeParse(value);
  if (wrapped.success) {
    const clean = toUntrusted(wrapped.data.text, maxLen);
    return { ...clean, truncated: clean.truncated || wrapped.data.truncated,
      flags: [...new Set([...clean.flags, ...wrapped.data.flags])] } as T;
  }
  if (Array.isArray(value)) return value.map(v => sanitize(v)) as T;
  const result = Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [key, sanitize(v, key === 'name' ? 64 : key === 'symbol' ? 16 : 280)]));
  if (result.kind === 'text' && 'ref' in result && 'label' in result) {
    // Text evidence identifiers/labels/values may also contain source prose.
    const parts = [result.label, result.value, result.text?.text].filter(v => typeof v === 'string');
    const clean = toUntrusted(parts.join(' '), 280);
    result.text = { ...clean, truncated: clean.truncated || result.text?.truncated === true,
      flags: [...new Set([...clean.flags, ...(result.text?.flags ?? [])])] };
    result.ref = typeof result.ref === 'string' && /^[A-Za-z0-9_.:#-]{1,256}$/.test(result.ref) ? result.ref : 'untrusted-text'; result.label = 'Third-party text'; delete result.value;
  }
  return result as T;
}
const unavailable = (reason: 'coin_unavailable' | 'delayed_snapshot_unavailable' | 'receipt_unavailable' | 'receipt_verification_unavailable') =>
  ({ status: 'unavailable' as const, reason });

/** Read-only adapters: no simulation, collection, scoring, or free-text execution. */
export class SensesReadService {
  /**
   * Wire Guard snapshot and receipt readers only. Host construction performs no simulation,
   * collection, scoring or authentication.
   */
  constructor(readonly guard: GuardReadStore, readonly receipts: Pick<ReceiptApiStore, 'get'>) {}
  private async delayed(block: number | string, delay: number) {
    if (!delay) return false;
    const row = (await this.guard.db.sql.query<{ ts: Date }>(
      'SELECT ts FROM engine_block_times WHERE number=$1 UNION ALL SELECT ts FROM chain_blocks WHERE number=$1 LIMIT 1', [block])).rows[0];
    return !row || new Date(row.ts).getTime() > this.guard.legacy.now() - delay * 1000;
  }
  /**
   * Read the explicitly negotiated Guard version and enforce the supplied snapshot delay. Return
   * unavailable for missing/delayed evidence and sanitize third-party text; missing V2 verdicts
   * retain the negotiated envelope. Caller supplies entitlement delay; storage failures reject.
   */
  async verdict(coin: Address, version: 1 | 2, delay: number) {
    const result = await this.guard.negotiatedVerdict(coin, version);
    if (!result) return unavailable('coin_unavailable');
    if (!result.verdict) return result.version === 2 ? result : unavailable('coin_unavailable');
    const block = result.version === 1 ? (result.verdict.lastChecked?.block ?? result.verdict.asOfBlock) : result.verdict.cursor.blockNumber;
    if (await this.delayed(block, delay)) return unavailable('delayed_snapshot_unavailable');
    return sanitize(result.version === 1 ? result.verdict : result);
  }
  /**
   * Read the negotiated card, enforce delay and sanitize text. V1 serves the requested window's
   * measured Watcher flow (packet 102) with its availability mask, as REST does; an unmeasured
   * window keeps structural zeros only under `meta.flow.unavailable`, never relabeling another
   * window. Caller supplies version/window/delay; missing or delayed cards return unavailable and
   * SQL failures reject.
   */
  async card(coin: Address, version: 1 | 2, window: '5m' | '1h' | '24h', delay: number) {
    const result = await this.guard.negotiatedCard(coin, version);
    if (!result || !result.card) return unavailable('coin_unavailable');
    const block = result.version === 1 ? (result.card.verdict.lastChecked?.block ?? result.card.freshness.block) : result.card.freshness.cursor.blockNumber;
    if (await this.delayed(block, delay)) return unavailable('delayed_snapshot_unavailable');
    if (result.version === 1) {
      const flow = (await readFlows(this.guard.db, [coin], window)).get(coin) ?? unavailableFlow(window, result.card.freshness.block);
      const { meta: flowMeta, ...values } = flow;
      const { flow: _otherWindow, ...meta } = result.card.meta ?? {};
      return sanitize({ ...result.card, flow: values, meta: flowMeta ? { ...meta, flow: flowMeta } : meta });
    }
    // The V2 projection has no measured requested window yet. Keep all other captured V2
    // facts/gaps intact and mark every flow metric unavailable rather than relabel it.
    const card = sanitize(result.card);
    const reset = (v: unknown): unknown => {
      if (!v || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(reset);
      if ('status' in v && 'value' in v && 'coverage' in v) {
        const m = v as Record<string, unknown> & { coverage: Record<string, unknown> };
        return { ...m, status: 'unknown', value: null, numerator: null, denominator: null,
          evidenceIds: [], failureCode: 'missing', fromSec: null,
          coverage: { ...m.coverage, complete: false, gaps: ['missing'] } };
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reset(x)]));
    };
    card.flow = { ...reset(card.flow) as typeof card.flow, windowSec: ({ '5m': 300, '1h': 3600, '24h': 86400 } as const)[window], beta: true };
    return { version: 2 as const, card };
  }
  /**
   * Filter the legacy verdict playbooks by minimum severity after delay checks, removing history
   * unless requested. Return history availability explicitly; missing/delayed snapshots pass
   * through unavailable and read failures reject.
   */
  async playbooks(coin: Address, minLevel: 'info' | 'monitor' | 'danger', includeHistory: boolean, delay: number) {
    const verdict = await this.verdict(coin, 1, delay);
    if ('status' in verdict) return verdict;
    if ('version' in verdict) throw new Error('Unexpected read version');
    const ranks = { clear: 0, info: 1, monitor: 2, danger: 3 };
    const playbooks = verdict.playbooks.filter(m => ranks[m.level] >= ranks[minLevel]).map(m => {
      const match: PlaybookMatch = { ...m };
      if (!includeHistory) delete match.history;
      return match;
    });
    return { playbooks, history: !includeHistory ? 'not_requested' as const
      : playbooks.length > 0 && playbooks.every(m => m.history) ? 'available' as const : 'unavailable' as const };
  }
  /**
   * Return the same precision-gated Census as REST GET /census: methodology, model and gate status
   * with no headline numbers until the label gate passes and finalized coverage exists. No
   * classification, measurement or acquisition runs here; SQL/schema failures reject.
   */
  async census() {
    return sanitize(SenseCensusResultSchema.parse(await readCensus(this.guard.db, this.guard.legacy.now())));
  }
  /**
   * Read a receipt proof/status, omitting revealed and canonical payloads from anchored responses.
   * Missing receipts return unavailable; verification/read failures become
   * receipt_verification_unavailable. No private journal material is read.
   */
  async receipt(id: string) {
    try {
      const receipt = await this.receipts.get(id);
      if (!receipt) return unavailable('receipt_unavailable');
      if (receipt.status === 'anchored') {
        const { revealed: _revealed, canonicalPayload: _canonical, ...proof } = receipt;
        return proof;
      }
      return receipt;
    } catch { return unavailable('receipt_verification_unavailable'); }
  }
}
