import { BagReportSchema, BagShareResponseSchema, PublicBagReportSchema, PlaybookIdSchema, type BagReport, type PublicBagReport, type Address } from '@eko/shared';
import { DYOR } from '../copy';
import { fetchParsed, type ApiOptions } from './api';

export type BagRow = PublicBagReport['holdings'][number];
export type ShareOptions = { includeValues: boolean; includeWallet: boolean };
export function rowComplete(row: BagRow) {
  return (!row.status || row.status === 'ready') && !row.unavailable?.includes('card') && !row.coin.verdictPending && row.coin.verdict !== 'pending'
    && PlaybookIdSchema.options.every(id => row.coin.evaluatedPlaybooks?.includes(id));
}
export function bagCounts(report: PublicBagReport) {
  const ready = report.holdings.filter(rowComplete);
  return { clear: ready.filter(r => r.coin.verdict === 'clear').length, monitor: ready.filter(r => r.coin.verdict === 'monitor').length,
    danger: ready.filter(r => r.coin.verdict === 'danger').length, incomplete: report.holdings.length - ready.length,
    matched: ready.filter(r => r.playbooks.length > 0).length };
}
// Preview mirrors task 109's exact decimal rounding, including balances above Number.MAX_SAFE_INTEGER.
export function sharedBalance(balance: string): string {
  if (!/^\d+(\.\d+)?$/.test(balance)) throw new Error('Invalid balance');
  const [whole, fraction = ''] = balance.split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  let rounded = digits;
  if (digits.length > 2) rounded = String(Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0)) + '0'.repeat(digits.length - 2);
  rounded = rounded.padStart(fraction.length + 1, '0');
  const at = rounded.length - fraction.length;
  return fraction.length ? `${rounded.slice(0, at)}.${rounded.slice(at)}`.replace(/\.?0+$/, '') : rounded;
}
export function bagPreview(report: BagReport, options: ShareOptions): PublicBagReport {
  return PublicBagReportSchema.parse({
    ...(options.includeWallet ? { wallet: report.wallet } : {}), asOfBlock: report.asOfBlock, coverage: report.coverage, cursor: report.cursor,
    holdings: report.holdings.map(r => ({
      coin: { address: r.coin.address, name: r.coin.name, symbol: r.coin.symbol, launchpad: r.coin.launchpad, stage: r.coin.stage,
        curvePct: r.coin.curvePct, change1hPct: r.coin.change1hPct, verdict: r.coin.verdict, verdictPending: r.coin.verdictPending,
        topPlaybook: r.coin.topPlaybook, ageSec: r.coin.ageSec, evaluatedPlaybooks: r.coin.evaluatedPlaybooks,
        unavailable: r.coin.unavailable, priceUnavailable: r.coin.priceUnavailable,
        ...(options.includeValues ? { priceUsd: r.coin.priceUsd, liquidityUsd: r.coin.liquidityUsd, marketCapUsd: r.coin.marketCapUsd } : {}) },
      balance: r.balance === null ? null : sharedBalance(r.balance), balanceStatus: r.balanceStatus, status: r.status,
      unavailable: r.unavailable, error: r.error, playbooks: r.playbooks, exitCost1kPct: r.exitCost1kPct,
      ...(options.includeValues && r.valueUsd !== undefined ? { valueUsd: r.valueUsd } : {}),
    })), summary: { coins: report.summary.coins, flagged: report.summary.flagged, danger: report.summary.danger,
      ...(options.includeValues && report.summary.valueUsd !== undefined ? { valueUsd: report.summary.valueUsd } : {}) },
  });
}
export const bagsPath = (wallet: Address, cursor?: Address, retry = false) => `/wallets/${wallet}/bags${cursor || retry ? `?${new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(retry ? { retry: 'true' } : {}) })}` : ''}`;
type Parse = typeof fetchParsed;
export async function shareBags(wallet: Address, options: ShareOptions, signal?: AbortSignal, parse: Parse = fetchParsed) {
  const result = await parse(`/wallets/${wallet}/bags/share`, BagShareResponseSchema, { body: options, signal });
  // Use the server's immutable snapshot for the issued link; scans may advance during POST.
  const report = await parse(`/bags/${result.id}`, PublicBagReportSchema, { signal });
  return { ...result, report };
}
export async function pollBags(wallet: Address, cursor: Address | undefined, retry: boolean, signal: AbortSignal,
  update: (report: BagReport) => void, parse: Parse = fetchParsed, pause = abortablePause) {
  // TODO(spec): CA-6 has no frontend polling budget. Follow the scan flow's 700 ms / 10 s bound; manual refresh resumes it.
  for (let attempt = 0; attempt < 15 && !signal.aborted; attempt++) {
    const opts: ApiOptions = { signal };
    const report = await parse(bagsPath(wallet, cursor, retry && attempt === 0), BagReportSchema, opts);
    if (signal.aborted) return;
    update(report);
    if (!report.holdings.some(r => r.status === 'pending') || attempt === 14) return;
    await pause(700, signal);
  }
}
function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function bagMeta(id: string, origin: string, apiBase: string) {
  const title = 'EKO · Bag report';
  return { title, 'og:title': title, 'og:description': `Bag report · ${DYOR}`,
    'og:url': `${origin}/bags/r/${encodeURIComponent(id)}`, 'og:image': `${apiBase}/og/bags/${encodeURIComponent(id)}.png`,
    'twitter:card': 'summary_large_image', 'twitter:image': `${apiBase}/og/bags/${encodeURIComponent(id)}.png` };
}
