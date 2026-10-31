import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PublicBagReportSchema, type BagReport } from '@eko/shared';
import { createApi } from '../../lib/api';
import { bagCounts, bagMeta, bagPreview, bagsPath, pollBags, rowComplete, shareBags, sharedBalance } from '../../lib/bags';
import Bags, { BagCard, BagHolding, BagTable, BagsConnect } from './Bags';

import { wallet, bagFixture as report } from '../../mocks/bags';
const coin = report.holdings[0].coin.address;
const id = '00000000-0000-4000-8000-000000000110';
const options = { includeValues: false, includeWallet: false };
const publicReport = bagPreview(report, options);
function client(replies: unknown[], calls: { url: string; body?: unknown }[]) {
  return createApi('/v1', async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  }).parse;
}
describe('bags report port', () => {
  it.each([false, true])('independently redacts values and identity with includeValues=%s', includeValues => {
    for (const includeWallet of [false, true]) {
      const preview = bagPreview(report, { includeValues, includeWallet });
      expect(preview.wallet).toBe(includeWallet ? wallet : undefined);
      expect(preview.holdings[0].valueUsd).toBe(includeValues ? report.holdings[0].valueUsd : undefined);
      for (const key of ['priceUsd', 'liquidityUsd', 'marketCapUsd'] as const) expect(preview.holdings[0].coin[key]).toBe(includeValues ? report.holdings[0].coin[key] : undefined);
      expect(preview.summary.valueUsd).toBe(includeValues ? report.summary.valueUsd : undefined);
      expect(preview.holdings[0].balance).toBe('1200');
      expect(preview.holdings[0].coin).not.toHaveProperty('guardV2');
      const html = render(<BagCard report={preview} />);
      expect(html.includes(wallet)).toBe(includeWallet);
      expect(html.includes('$4K')).toBe(includeValues);
    }
  });
  it.each([['0', '0'], ['0.00999', '0.01'], ['999', '1000'], ['12345678901234567890123', '12000000000000000000000']])('matches server rounding for %s', (input, output) => expect(sharedBalance(input)).toBe(output));
  it('keeps unknown balances and values unknown, never measured zero', () => {
    const unknown = { ...report, holdings: [{ ...report.holdings[0], balance: null, valueUsd: undefined, exitCost1kPct: null }], summary: { ...report.summary, valueUsd: undefined } };
    expect(bagPreview(unknown, { includeValues: true, includeWallet: false }).holdings[0].balance).toBeNull();
    const html = render(<BagHolding row={unknown.holdings[0]} retry={() => {}} busy={false} watching={false} watchAvailable={false} toggleWatch={() => {}} />);
    expect(html).toContain('Not checked yet'); expect(html).not.toContain('$0');
  });
  it.each([{ status: 'pending' as const }, { status: 'error' as const }, { status: 'unavailable' as const }, { coin: { ...report.holdings[0].coin, verdict: 'pending' as const } }, { coin: { ...report.holdings[0].coin, verdictPending: true } }, { coin: { ...report.holdings[0].coin, evaluatedPlaybooks: [] } }, { coin: { ...report.holdings[0].coin, evaluatedPlaybooks: undefined } }, { unavailable: ['card' as const] }])('excludes incomplete rows from confirmed matches: %j', patch => {
    const incomplete = { ...report, holdings: [{ ...report.holdings[0], ...patch }] };
    expect(rowComplete(incomplete.holdings[0])).toBe(false);
    expect(bagCounts(incomplete)).toMatchObject({ matched: 0, danger: 0, incomplete: 1 });
    expect(render(<BagCard report={bagPreview(incomplete, options)} />)).toContain('excluded from confirmed matches');
  });
  it('renders the same redacted card in preview and public snapshot with inert token text', () => {
    const snapshot = PublicBagReportSchema.parse(JSON.parse(JSON.stringify(publicReport)));
    expect(render(<BagCard report={snapshot} />)).toBe(render(<BagCard report={publicReport} />));
    const rowHtml = render(<BagHolding row={report.holdings[0]} retry={() => {}} busy={false} watching watchAvailable toggleWatch={() => {}} />);
    expect(rowHtml).toContain('&lt;img'); expect(rowHtml).not.toContain('<img');
    expect(rowHtml).toContain('<details><summary>Evidence and limits</summary>');
    expect(rowHtml).toContain('aria-pressed="true"'); expect(rowHtml).toContain('Exit cost at $1,000');
    expect(rowHtml).toMatch(/<button[^>]*disabled=""[^>]*>Sell through the guard/);
    expect(rowHtml).not.toMatch(/0\.5%|0% on Pons/);
  });
  it('ports the desktop holdings table and keeps actions unavailable with no service', () => {
    const html = render(<BagTable report={report} busy={false} watch={new Set()} watchAvailable={false} retry={() => {}} toggleWatch={() => {}} />);
    expect(html).toContain('<table'); expect(html).toContain('scope="col"'); expect(html).toContain('Exit cost at $1,000');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sell through the guard/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Watch/);
  });
  it('offers real wallet discovery and a public page without accessing a wallet provider', () => {
    expect(render(<BagsConnect />)).toContain('Connect wallet');
    const html = render(<Bags params={{ id }} />);
    expect(html).toContain('no wallet connection required'); expect(html).not.toContain('Connect wallet');
  });
  it('renders per-row retry and indexed empty report disclosure', () => {
    const html = render(<BagHolding row={{ ...report.holdings[0], status: 'error', error: 'scan_failed' }} retry={() => {}} busy={false} watching={false} watchAvailable={false} toggleWatch={() => {}} />);
    expect(html).toContain('Couldn&#x27;t scan — retry.'); expect(html).toContain('Retry scans on this page');
    const empty = render(<BagCard report={{ ...publicReport, holdings: [], summary: { coins: 0, flagged: 0, danger: 0 } }} />);
    expect(empty).toContain('Indexed holdings only'); expect(empty).toContain('0<span>/0');
  });
  it('polls progressively, retries only once, and preserves page identity', async () => {
    const calls: { url: string; body?: unknown }[] = [], updates: BagReport[] = [], pauses: number[] = [];
    const pending = { ...report, holdings: [{ ...report.holdings[0], status: 'pending' }] };
    await pollBags(wallet, coin, true, new AbortController().signal, r => updates.push(r), client([pending, report], calls), async ms => { pauses.push(ms); });
    expect(updates.map(r => r.holdings[0].status)).toEqual(['pending', 'ready']); expect(pauses).toEqual([700]);
    expect(calls.map(c => c.url)).toEqual([`/v1${bagsPath(wallet, coin, true)}`, `/v1${bagsPath(wallet, coin)}`]);
  });
  it('bounds pending polling and supports cancellation without further publication', async () => {
    const pending = { ...report, holdings: [{ ...report.holdings[0], status: 'pending' }] }, calls: { url: string }[] = [], ac = new AbortController();
    await pollBags(wallet, undefined, false, ac.signal, () => {}, client(Array(15).fill(pending), calls), async () => {});
    expect(calls).toHaveLength(15);
    let updates = 0;
    await pollBags(wallet, undefined, false, ac.signal, () => { updates++; ac.abort(); }, client([pending], []), async () => {});
    expect(updates).toBe(1);
  // Fifteen reads of one resource are spaced a second apart by the shared request control.
  }, 30_000);
  it('reports failed refreshes and returns the actual stored snapshot after explicit share', async () => {
    await expect(pollBags(wallet, undefined, false, new AbortController().signal, () => {}, createApi('/v1', async () => new Response('{}', { status: 503 })).parse)).rejects.toMatchObject({ status: 503 });
    const calls: { url: string; body?: unknown }[] = [], snapshot = { ...publicReport, asOfBlock: 43 };
    const shared = await shareBags(wallet, options, undefined, client([{ id, shareUrl: `/bags/r/${id}` }, snapshot], calls));
    expect(calls).toEqual([{ url: `/v1/wallets/${wallet}/bags/share`, body: options }, { url: `/v1/bags/${id}`, body: undefined }]);
    expect(shared.report.asOfBlock).toBe(43);
    expect(render(<BagCard report={shared.report} />)).toContain('Block 43');
  });
  it('keeps share metadata free of wallet, values and untrusted token names', () => {
    const meta = bagMeta(id, 'https://example.invalid', 'https://example.invalid/v1');
    expect(meta['og:image']).toBe(`https://example.invalid/v1/og/bags/${id}.png`);
    expect(JSON.stringify(meta)).not.toMatch(/DEMO|0x1111|4012/);
  });
});
