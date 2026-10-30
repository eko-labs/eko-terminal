import { RECORD_NOT_STARTED } from '../trust/scoreboardModel';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanResult } from '@eko/shared';
import { SCAN_COPY as C } from '../../copy/scan';
import { DYOR, NON_AFFILIATION } from '../../copy';
import { createRadarRows, createRadarCard } from '../../mocks/demo/radar';
import { CoinCardV2Schema } from '@eko/shared';
import { card as guardFixture } from '../../../../../packages/shared/test/fixtures/contracts/guard-v2';
import Landing from './Landing';
import { ProofCounters, RadarPreview } from './LandingDetails';
import { ScanInput } from './ScanInput';
import { ScanResultCard, ScanState } from './ScanResult';
import { pollScan, ScanCountersSchema, SCAN_TARGETS, shareLinks, submitScan, takeScanTiming, validScanQuery, type ScanRead, type ScanView } from './scanModel';
import * as apiModule from '../../lib/api';

const rows = createRadarRows();
const ready: ScanResult = { id: 'scan-fixture', status: 'ready', shareUrl: '/scan/scan-fixture', card: createRadarCard(rows[0].address)! };
const pending: ScanResult = { id: ready.id, status: 'pending', shareUrl: ready.shareUrl };
const view = (result: ScanResult | null): ScanView => ({ result, error: false, timedOut: false, receivedAt: Date.now() });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('landing and persisted Scan', () => {
  it.each(['$A', '$demo_123', '$ABCDEFGHIJKLMNOPQRST', rows[0].address, ` ${rows[0].address} `])('accepts address or bounded ticker %s', value => expect(validScanQuery(value)).toBe(true));
  it.each(['', 'DEMO', '$', '$abcdefghijklmnopqrstu', '$a b', '$<script>', '0x123', 'https://example.invalid'])('rejects invalid input %s', value => expect(validScanQuery(value)).toBe(false));
  it('renders the mobile input before all previews and disclosures with Go', () => {
    const html = render(<Landing />);
    expect(html).toContain('id="main" tabindex="-1"');
    expect(html).toContain('class="skip" href="#main"');
    expect(html).toContain('landing-details');
    expect(html.indexOf('id="landing-scan"')).toBeLessThan(html.indexOf('landing-details'));
    expect(html).toContain('enterKeyHint="go"'); expect(html).toContain(DYOR); expect(html).toContain(NON_AFFILIATION);
    expect(html).not.toContain('Buy EKO');
    expect(render(<ScanInput examples={rows.slice(0, 4).map(row => row.address)} />).match(/class="btn btn-sm"/g)).toHaveLength(3);
  });
  it('shows real counts, including measured zero, and never invents missing observation', () => {
    const measured = render(<ProofCounters counters={ScanCountersSchema.parse({ counters: { refused: 27, missed: 2, since: '2026-10-01T00:00:00Z' } }).counters} />);
    expect(measured).toContain('>27</strong>'); expect(measured).toContain('>2</strong>'); expect(measured).toContain(C.missed);
    expect(render(<ProofCounters counters={{ refused: 1, missed: 0, since: '2026-10-01T00:00:00Z' }} />)).toContain('>0</strong>');
    // Never measured: one explanation and no figures. Measured with one counter missing: that counter says so.
    for (const counters of [null, undefined, {}, { refused: 0, missed: 0 }]) {
      const html = render(<ProofCounters counters={counters} />); expect(html).toContain(RECORD_NOT_STARTED); expect(html).not.toContain('</strong>');
    }
    const partial = render(<ProofCounters counters={{ since: '2026-10-01T00:00:00Z', refused: 2, missed: null }} />);
    expect(partial).toContain(C.unavailable); expect(partial).not.toContain('>0</strong>');
    const css = readFileSync('src/pages/scan/scan.css', 'utf8'); expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
  });
  it('shows six supplied preview cards with delay and named field gaps', () => {
    const html = render(<RadarPreview rows={rows} delayedSec={60} />);
    expect(html.match(/class="panel scan-preview"/g)).toHaveLength(6); expect(html).toContain('Data delay: 60 s');
    const unavailable = render(<RadarPreview rows={[{ ...rows[0], unavailable: ['exitCost', 'flow'] }]} delayedSec={60} />);
    expect(unavailable).toContain('Exit cost at $1K: not checked yet'); expect(unavailable).not.toContain('0% agents');
  });
  it('renders ambiguity as inert candidates with address, available age and launchpad', () => {
    const candidate = { ...rows[0], symbol: { text: '<img onerror=alert(1)>', flags: [] as [], truncated: false }, ageSec: 600 };
    const html = render(<ScanState view={view({ ...pending, status: 'ambiguous', candidates: [candidate, { ...rows[1], ageSec: 0 }] })} retry={() => {}} />);
    expect(html).toContain(C.ambiguous); expect(html).toContain(candidate.address); expect(html).toContain('10m'); expect(html).toContain(C.ageUnavailable);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).toContain('<button');
  });
  it('submits a selected candidate address through POST and records completion separately', async () => {
    const request = vi.spyOn(apiModule, 'fetchParsed').mockResolvedValue(ready);
    await submitScan(rows[0].address, new AbortController().signal);
    expect(request).toHaveBeenCalledWith('/scan', expect.anything(), expect.objectContaining({ method: 'POST', body: { query: rows[0].address } }));
    expect(takeScanTiming(ready.id, { ...ready, card: { ...ready.card!, verdict: { ...ready.card!.verdict, level: 'pending' } } })).toBeNull();
    expect(takeScanTiming(ready.id, ready)?.metric).toBe('ui.scan_to_verdict_ms.indexed'); expect(takeScanTiming(ready.id, ready)).toBeNull();
    request.mockResolvedValueOnce(pending); await submitScan('$DEMO', new AbortController().signal);
    expect(takeScanTiming(ready.id, ready)?.metric).toBe('ui.scan_to_verdict_ms.pending');
    expect(SCAN_TARGETS).toEqual({ indexedP50Ms: 3000, newPairP95Ms: 5000 });
  });
  it('polls pending-to-ready at 700ms and stops on a completed result', async () => {
    vi.useFakeTimers(); const emit = vi.fn(); const request = vi.fn<ScanRead>().mockResolvedValueOnce(pending).mockResolvedValueOnce(ready);
    const cancel = pollScan(ready.id, emit, null, request); await vi.advanceTimersByTimeAsync(0);
    expect(emit.mock.calls[0][0].result.status).toBe('pending'); await vi.advanceTimersByTimeAsync(699); expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(emit.mock.calls.at(-1)![0].result.status).toBe('ready');
    await vi.advanceTimersByTimeAsync(20000); expect(request).toHaveBeenCalledTimes(2); cancel();
  });
  it('backs off transient failures and bounds pending reads at ten seconds', async () => {
    vi.useFakeTimers(); const request = vi.fn<ScanRead>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(pending), emit = vi.fn();
    const cancel = pollScan(ready.id, emit, null, request); await vi.advanceTimersByTimeAsync(1399); expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8600); expect(emit.mock.calls.at(-1)![0].timedOut).toBe(true);
    const count = request.mock.calls.length; await vi.advanceTimersByTimeAsync(20000); expect(request).toHaveBeenCalledTimes(count); cancel();
  });
  it('aborts in-flight requests and ignores late results after navigation', async () => {
    vi.useFakeTimers(); let complete!: (result: ScanResult) => void; let signal!: AbortSignal;
    const request: ScanRead = (_id, incoming) => { signal = incoming; return new Promise(resolve => { complete = resolve; }); };
    const emit = vi.fn(), cancel = pollScan(ready.id, emit, null, request); cancel(); expect(signal.aborted).toBe(true);
    complete(ready); await vi.advanceTimersByTimeAsync(20000); expect(emit).not.toHaveBeenCalled();
  });
  it('bounds a hanging request and retains prior evidence on a degraded refresh', async () => {
    vi.useFakeTimers(); const emit = vi.fn(), cancel = pollScan(ready.id, emit, ready, async () => pending);
    await vi.advanceTimersByTimeAsync(0); expect(emit.mock.calls.at(-1)![0].result).toBe(ready); expect(emit.mock.calls.at(-1)![0].error).toBe(true); cancel();
    const hanging = vi.fn<ScanRead>(() => new Promise(() => {})); const stop = pollScan(ready.id, emit, ready, hanging);
    await vi.advanceTimersByTimeAsync(10000); expect(hanging.mock.calls[0][1].aborted).toBe(true); expect(emit.mock.calls.at(-1)![0].timedOut).toBe(true); stop();
  });
  it('retains stale results, evidence and named unavailable costs without structural zeros', () => {
    const card = { ...ready.card!, freshness: { block: 1, ageSec: 45 }, meta: { tradeability: { confidence: 0, asOfBlock: 1, missing: ['exitCosts', 'simulations'] }, flow: { confidence: 0, asOfBlock: 1, missing: ['agentPct'] } } };
    const html = render(<ScanState view={{ ...view({ ...ready, card }), error: true }} retry={() => {}} />);
    expect(html).toContain(C.stale); expect(html).toContain(C.refreshFailed); expect(html).toContain('buy-then-sell simulation');
    expect(html).toContain(C.receipt); expect(html).toContain(C.bags); expect(html).toContain(C.share); expect(html).toContain('Evidence');
    expect(html).not.toContain('>0.0%</dd>'); expect(html).not.toContain('0% agents'); expect(html).toContain('not checked yet');
  });
  it('uses the Guard compact adapter and full card for negotiated V2 without activating shadow', () => {
    const guardCard = CoinCardV2Schema.parse(guardFixture);
    const html = render(<ScanResultCard result={{ ...ready, guardCard }} />);
    expect(html).toContain('guard-compact'); expect(html).toContain('guard-card'); expect(html).toContain('Shadow assessment'); expect(html).toContain(NON_AFFILIATION);
  });
  it('provides neutral encoded share URLs and not-found/retry states', () => {
    const links = shareLinks('scan-fixture', 'https://example.invalid'); expect(links.url).toBe('https://example.invalid/scan/scan-fixture');
    expect(links.x).toContain('EKO%20buyer-risk%20assessment'); expect(links.telegram).toContain(encodeURIComponent(links.url));
    expect(render(<ScanState view={view({ ...pending, status: 'not_found' })} retry={() => {}} />)).toContain(C.notFound);
    expect(render(<ScanState view={{ ...view(null), error: true }} retry={() => {}} />)).toContain(C.error);
  });
  it('keeps wallet libraries outside the statically loaded landing import graph', () => {
    const seen = new Set<string>();
    function visit(file: string) {
      if (seen.has(file)) return; seen.add(file);
      const source = readFileSync(file, 'utf8'); expect(source).not.toMatch(/from ['"](?:wagmi|@wagmi|@walletconnect)/);
      const imports = [...source.matchAll(/import\s+(?!type\b)(?:[^;]*?from\s*)?['"]([^'"]+)['"]/g)];
      for (const match of imports) {
        if (!match[1].startsWith('.')) continue;
        const base = resolve(dirname(file), match[1]);
        const next = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => base + ext).find(existsSync);
        if (next) visit(next);
      }
    }
    visit(resolve('src/main.tsx'));
  });
});
