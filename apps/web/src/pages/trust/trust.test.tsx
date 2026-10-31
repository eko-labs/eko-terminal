import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReceiptLookupSchema, ScoreboardResponseSchema, type ScoreboardRow } from '@eko/shared';
import { resolveRoute } from '../../routes';
import { ApiError, fetchParsed } from '../../lib/api';
import current from '../../../../../packages/shared/test/fixtures/receipts/guard-v2.json';
import Scoreboard, { CohortRows, RecordRows, ScoreboardHeadlines } from './Scoreboard';
import Receipt, { lookupReceipt, ReceiptContents } from './Receipt';
import { collapsePendingCalls, counterText, NOT_CHECKED, recordTime, RECORD_NOT_STARTED, safePostMortem, shortCoin } from './scoreboardModel';
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), fetchParsed: vi.fn() }));
const data = ScoreboardResponseSchema.parse({ rows: [], cursor: null, snapshot: '1', counters: { refused: null, missed: null, since: null }, availability: {
  refused: { status: 'unavailable', reason: 'monitoring_missing' }, missed: { status: 'unavailable', reason: 'coverage_gap' },
  grades: { status: 'unavailable', reason: 'outcomes_unaccepted' }, forecasts: { status: 'unavailable', reason: 'forecast_dependency' },
  cohort: { status: 'unavailable', reason: 'outcomes_unaccepted' }, milestones: { status: 'unavailable', reason: 'd0_gated' },
} });
const item = current.items[0]!;
const pending = ReceiptLookupSchema.parse({ id: item.id, kind: item.kind, hash: item.hash, leaf: item.leaf, canonicalization: 'jcs-rfc8785/v1', status: 'pending' });
const anchor = { ...pending, status: 'anchored', merkleRoot: current.root, proof: current.proofs[0], batchId: 1, block: 100,
  blockHash: `0x${'12'.repeat(32)}`, txHash: `0x${'34'.repeat(32)}`, registry: `0x${'ab'.repeat(20)}`, chainId: 4663, logIndex: 1 };
const renderReceipt = (receipt: unknown, registryAvailable = true) => renderToStaticMarkup(<ReceiptContents receipt={ReceiptLookupSchema.parse(receipt)} result={null} registryAvailable={registryAvailable} onVerify={() => {}} />);
describe('Scoreboard and receipt UI', () => {
  it('loads both real public routes without flags or authentication', async () => {
    for (const [path, component] of [['/scoreboard', Scoreboard], ['/receipt/sample-receipt', Receipt]] as const) {
      const { route } = resolveRoute(path)!;
      expect(route).toMatchObject({ auth: 'public', stage: 'T' });
      expect((await route.load()).default).toBe(component);
    }
    const html = renderToStaticMarkup(<Scoreboard />);
    expect(html.indexOf('Misses first')).toBeLessThan(html.indexOf('Scoreboard records'));
    expect(html).not.toContain('sample-receipt');
    expect(html).not.toMatch(/milestone/i); // milestone buys were dropped; the record kind has no tab
  });
  it('keeps equal headline classes and unknown counters separate from observed zero', () => {
    // Unmeasured: one explanation instead of two empty figures; still never confused with an observed zero.
    let html = renderToStaticMarkup(<ScoreboardHeadlines data={data} />);
    expect(html.match(/class="scoreboard-counter scoreboard-explainer"/g)).toHaveLength(1);
    expect(html).not.toContain('scoreboard-figure'); expect(html).toContain(RECORD_NOT_STARTED);
    expect(counterText(data, 'missed')).toBe(NOT_CHECKED);
    expect(html).not.toContain('0 missed since');
    const observed = structuredClone(data);
    observed.counters = { refused: 5, missed: 0, since: '2026-10-01T00:00:00Z' };
    observed.availability.missed = observed.availability.refused = { status: 'observed', since: '2026-10-01T00:00:00Z', through: '2026-10-02T00:00:00Z' };
    html = renderToStaticMarkup(<ScoreboardHeadlines data={observed} />);
    expect(html.match(/class="scoreboard-counter"/g)).toHaveLength(2);
    expect(html.match(/class="scoreboard-figure num"/g)).toHaveLength(2);
    expect(html).toContain('0 missed since');
    expect(counterText(observed, 'refused')).toBe('5');
  });
  it('renders original and correction receipts plus a real post-mortem, and escapes text', () => {
    const rows: ScoreboardRow[] = [{ kind: 'honeypots_missed', id: 'original', ts: '2026-10-01', receiptId: 'receipt:original', detail: {} },
      { kind: 'honeypots_missed', id: 'correction', ts: '2026-10-02', receiptId: 'receipt:correction', detail: { correctionOf: 'original', event: '<script>sample</script>', postMortemUrl: '/record/sample' } }];
    const html = renderToStaticMarkup(<RecordRows rows={rows} />);
    expect(html).toContain('href="/receipt/receipt%3Aoriginal"');
    expect(html).toContain('href="/receipt/receipt%3Acorrection"');
    expect(html).toContain('href="/record/sample"');
    expect(html).toContain('Post-mortem pending');
    expect(html).not.toContain('<script>');
    for (const url of ['javascript:alert(1)', '//example.invalid', '/record/<script>', 'https://example.invalid']) expect(safePostMortem(url)).toBe(false);
  });
  it('formats record times and coins, and collapses repeated ungraded calls per coin', () => {
    const coin = `0x${'ab'.repeat(20)}` as const;
    expect(recordTime('2026-10-04T13:22:29.051Z')).toBe('2026-10-04 13:22 UTC'); expect(recordTime('2026-10-02')).toBe('2026-10-02');
    expect(shortCoin(coin)).toBe('0xabab…abab');
    const rows: ScoreboardRow[] = [1, 2, 3].map(n => ({ kind: 'calls', id: `c${n}`, ts: '2026-10-04', coin, detail: {} }));
    const collapsed = collapsePendingCalls(rows);
    expect(collapsed.rows.map(row => row.id)).toEqual(['c1']); expect(collapsed.earlier.get(coin)).toBe(2);
    expect(renderToStaticMarkup(<RecordRows rows={rows} />)).toContain('+2 earlier ungraded calls');
  });
  it('puts wrong graded calls before other call records', () => {
    const html = renderToStaticMarkup(<RecordRows rows={[{ kind: 'calls', id: 'hit', ts: '2026-10-02', grade: 'hit', detail: {} }, { kind: 'calls', id: 'miss', ts: '2026-10-01', grade: 'miss', detail: {} }]} />);
    expect(html.indexOf('id="record-miss"')).toBeLessThan(html.indexOf('id="record-hit"'));
  });
  it('keeps actual measured cohort horizons, denominators and immature/unavailable values', () => {
    const rows: ScoreboardRow[] = [{ id: 'week-clear', kind: 'cohort', ts: '2026-10-02', detail: { week: '2026-09-21', group: 'clear', eligible: 8, evaluated: 2, immature: 3, censored: 1, ungraded: 2, rugRateStatus: 'unavailable', medianStatus: 'unavailable', rugDenominator: 0, medianDenominator: 0, horizonSec: 86400 } }];
    const html = renderToStaticMarkup(<CohortRows rows={rows} />);
    expect(html).toContain('No flags cohort'); expect(html).toContain('86400 seconds');
    expect(html).toContain('<dt>Immature</dt><dd>3</dd>'); expect(html).toContain(`${NOT_CHECKED} · denominator 0`);
    expect(html).not.toContain('48 h');
  });
  it('disables pending and unconfigured verification and never requests a private payload', () => {
    expect(renderReceipt(pending)).toContain('disabled=""');
    expect(renderReceipt(pending)).toContain('Pending · receipts are committed');
    expect(renderReceipt(anchor, false)).toContain('disabled=""');
    expect(renderReceipt(anchor)).not.toContain('disabled=""');
    const html = renderReceipt({ ...anchor, kind: 'harness_private' });
    expect(html).toContain('Private — only the owner can reveal this.');
    expect(html).toContain('salted commitment only'); expect(html).not.toContain('<pre');
  });
  it('shows expired payloads and their summary without promising a later reveal', () => {
    const summary={coin:`0x${'ab'.repeat(20)}`,receiptId:item.id,revisionId:item.id,recordedAt:'2026-10-01T00:00:00Z',
      rulesVersion:'1.0.0',level:'clear',supersedes:null,reorgOf:null,window:{kind:'snapshot',blockNumber:1,blockHash:null}};
    for(const receipt of [pending,anchor]) {
      const html=renderReceipt({...receipt,payloadStatus:'expired',summary});
      expect(html).toContain('Receipt payload expired');expect(html).toContain('Receipt summary');
      expect(html).toContain(item.id);expect(html).not.toContain('Payload not revealed yet');
    }
  });
  it('renders JSON as inert text with no HTML, images, links or scripts', () => {
    const html = renderReceipt({ ...anchor, revealed: { '<img src=x onerror=alert(1)>': '</pre><script>sample</script>', url: 'javascript:alert(1)' }, canonicalPayload: '{}' });
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
  });
  it('handles unknown receipts and rejects a swapped lookup identity', async () => {
    vi.mocked(fetchParsed).mockRejectedValueOnce(new ApiError(404, 'not_found', 'not found'));
    await expect(lookupReceipt('unknown')).rejects.toMatchObject({ status: 404 });
    vi.mocked(fetchParsed).mockResolvedValueOnce(pending);
    await expect(lookupReceipt('swapped')).rejects.toThrow('different receipt');
    expect(fetchParsed).toHaveBeenLastCalledWith('/receipts/swapped', ReceiptLookupSchema, { signal: undefined });
  });
  it('keeps mobile long hashes inside the page and stacks cohort cards and metadata', () => {
    const css = readFileSync(new URL('./trust.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 700px)');
    expect(css).toContain('.scoreboard-cohorts { grid-template-columns: minmax(0, 1fr); }');
    expect(css).toContain('.receipt-metadata { grid-template-columns: minmax(0, 1fr); gap: 4px; }');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('min-height: 44px');
  });
});
