import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import fixtures from '../src/mocks/contracts.json' with { type: 'json' };

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
test.skip(process.env.EKO_PERFORMANCE !== '1', 'Opt-in local production-build measurement');
// TODO(spec): §12 does not pin a handset/4G profile or sample count. Use the recorded fixed profile and five cold contexts.
const PROFILE = { cpuSlowdown: 4, latencyMs: 150, downloadBytesPerSec: 200_000, uploadBytesPerSec: 93_750 };
const SAMPLES = 5, EVENTS = 20;
type Metrics = { lcp: number[]; inp: number[]; cls: number[]; scan: number[]; ws: number[]; quote: number[]; chart: number[]; approval: number[] };
const q = (values: number[], percentile: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * percentile) - 1)];

test('mid-tier phone / 4G frontend budgets on localhost fixtures', async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  expect(browser.version(), 'pinned installed Chrome').toBe('154.0.8037.93');
  expect(JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version, 'pinned Playwright').toBe('1.63.0');
  const root = path.resolve('../..'), metrics: Metrics = { lcp: [], inp: [], cls: [], scan: [], ws: [], quote: [], chart: [], approval: [] }, errors: string[] = [];
  const transportProbeMs: number[] = [];
  const layoutShifts: unknown[] = [];
  const pin = createHash('sha256');
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web', 'packages/shared', 'packages/untrusted', 'packages/receipts-verifier', 'scripts/check-web-budgets.mjs', 'scripts/measure-web-performance.mjs', 'scripts/test/web-budgets.test.mjs', 'scripts/test/staging-identity.test.mjs', 'package.json', 'pnpm-lock.yaml'], { cwd: root, encoding: 'utf8' }).trim().split('\n').sort();
  for (const file of [...new Set(paths)]) { if (file) pin.update(file).update(readFileSync(path.join(root, file))); }
  const sourceSha256 = pin.digest('hex'), revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const distPin = createHash('sha256');
  for (const file of readdirSync('dist/assets').filter(f => f.endsWith('.js')).sort()) distPin.update(file).update(readFileSync(`dist/assets/${file}`));
  const assetSha256 = distPin.digest('hex');
  let approvalStatus = 'not measured: approvals flag disabled on this T fixture';
  const blockRules = [
    ...['http', 'ws'].flatMap(protocol => ['localhost', '127.0.0.1'].map(host => ({ urlPattern: `${protocol}://${host}:*/*`, block: false }))),
    ...['http', 'https', 'ws', 'wss'].map(protocol => ({ urlPattern: `${protocol}://*`, block: true })),
  ];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      const w = window as unknown as { perfFixture: { lcp: number; interactions: Record<string, number>; shifts: { at: number; value: number }[]; scanStart: number; scan: number[]; ws: number[]; quote: number[]; chart: number[]; wsStarts: Record<string, number>; chartStart: number | null } };
      const state: typeof w.perfFixture = w.perfFixture = { lcp: 0, interactions: {}, shifts: [], scanStart: 0, scan: [], ws: [], quote: [], chart: [], wsStarts: {}, chartStart: null };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) state.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) { const e = entry as PerformanceEntry & { interactionId: number }; if (e.interactionId) state.interactions[e.interactionId] = Math.max(state.interactions[e.interactionId] ?? 0, e.duration); } }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
      new PerformanceObserver(list => { for (const entry of list.getEntries()) { const e = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }; if (!e.hadRecentInput) state.shifts.push({ at: e.startTime, value: e.value, sources: (e as any).sources?.map((s: any) => ({ tag: s.node?.nodeName, class: s.node?.className, previous: s.previousRect.toJSON(), current: s.currentRect.toJSON() })) } as any); } }).observe({ type: 'layout-shift', buffered: true });
      // rAF + task runs after the browser's rendering opportunity. This is an after-paint
      // proxy, not physical display/compositor timing; include that limitation in the report.
      const afterPaint = (fn: () => void) => requestAnimationFrame(() => setTimeout(fn, 0));
      document.addEventListener('submit', () => { state.scanStart = performance.now(); }, true);
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.t === 'ev' && m.ch === 'feed') state.wsStarts[m.data.id] = performance.now(); });
        }
      };
      const nativeFetch = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]), start = performance.now(), response = await nativeFetch(...args);
        const text = response.text.bind(response);
        response.text = async () => { const body = await text(); if (url.includes('/trade/quote') && response.ok) state.quote.push(performance.now() - start); if (url.includes('/candles?') && response.ok) state.chartStart = performance.now(); return body; };
        return response;
      };
      new MutationObserver(() => {
        if (state.scanStart && document.querySelector('[data-tour="coin-card"] .verdict')) { const start = state.scanStart; state.scanStart = 0; afterPaint(() => state.scan.push(performance.now()-start)); }
        for (const [id, start] of Object.entries(state.wsStarts)) if (document.querySelector(`[data-feed-id="${id}"]`)) { delete state.wsStarts[id]; afterPaint(() => state.ws.push(performance.now()-start)); }
        if (state.chartStart !== null && document.querySelector('.coin-chart[data-slot] .coin-ohlc')?.textContent) { const start = state.chartStart; state.chartStart = null; afterPaint(() => state.chart.push(performance.now()-start)); }
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => console.log(`Browser error: ${error.message}`));
    await cdp.send('Network.enable');
    // Browser-native ordered block rules preserve network throttling and HTTP caching.
    await cdp.send('Network.setBlockedURLs', { urlPatterns: blockRules });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: PROFILE.latencyMs, downloadThroughput: PROFILE.downloadBytesPerSec, uploadThroughput: PROFILE.uploadBytesPerSec, connectionType: 'cellular4g' });
    try {
      console.log(`Performance sample ${sample+1}/${SAMPLES}`);
      await page.goto(baseURL!);
      const probe = await page.evaluate(async () => { const start = performance.now(); await (await fetch('/v1/health')).text(); return performance.now()-start; });
      transportProbeMs.push(probe);
      if (probe < PROFILE.latencyMs * .8) throw new Error(`4G latency inactive: health request took ${probe.toFixed(1)} ms`);
      const input = page.getByLabel('Paste any contract address or $ticker');
      await expect(input).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(2500);
      await input.tap(); await input.pressSequentially('$DEMO', { delay: 100 });
      await page.waitForTimeout(100);
      const landing = await page.evaluate(() => {
        const s = (window as any).perfFixture;
        let max = 0, sum = 0, first = 0, last = 0;
        for (const shift of s.shifts) { if (shift.at-last > 1000 || shift.at-first > 5000) { sum = 0; first = shift.at; } sum += shift.value; last = shift.at; max = Math.max(max, sum); }
        return { lcp: s.lcp, inp: Math.max(0, ...Object.values(s.interactions) as number[]), interactions: Object.keys(s.interactions).length, cls: max, shifts: s.shifts };
      });
      if (!landing.lcp || !landing.interactions) throw new Error('Missing LCP or Event Timing interactions');
      layoutShifts.push(landing.shifts);
      metrics.lcp.push(landing.lcp); metrics.inp.push(landing.inp); metrics.cls.push(landing.cls);
      console.log(`Sample ${sample+1}: scan`);
      await input.press('Enter');
      await page.waitForFunction(() => (window as any).perfFixture.scan.length > 0);
      metrics.scan.push(await page.evaluate(() => (window as any).perfFixture.scan[0]));
      console.log(`Sample ${sample+1}: feed`);
      await page.goto(`${baseURL}/feed`);
      await expect(page.getByTestId('stream-status')).toContainText('Live');
      await expect(page.locator('.feed-list')).toBeVisible();
      await expect(page.locator('.feed-list .skel')).toHaveCount(0);
      for (let index = 0; index < EVENTS; index++) {
        const sent = await page.evaluate(async index => (await fetch('/v1/perf/event', { method: 'POST', body: JSON.stringify({ index }) })).json(), index);
        if (!sent.delivered) throw new Error('Fixture WS had no feed subscriber');
        await page.waitForTimeout(200);
      }
      await page.waitForFunction(n => (window as any).perfFixture.ws.length === n, EVENTS);
      metrics.ws.push(...await page.evaluate(() => (window as any).perfFixture.ws));
      console.log(`Sample ${sample+1}: coin`);
      await page.goto(`${baseURL}/coin/${fixtures.Address}`);
      await page.waitForFunction(() => (window as any).perfFixture.chart.length > 0);
      metrics.chart.push(await page.evaluate(() => (window as any).perfFixture.chart[0]));
      await page.getByRole('button', { name: 'Expand', exact: true }).click();
      await page.locator('.tpanel input[type=number]').first().scrollIntoViewIfNeeded();
      await page.waitForFunction(() => (window as any).perfFixture.quote.length > 0);
      const quoteMs = await page.evaluate(() => (window as any).perfFixture.quote[0]);
      metrics.quote.push(quoteMs);
      if (quoteMs < PROFILE.latencyMs * .8) throw new Error(`4G latency inactive on quote: ${quoteMs.toFixed(1)} ms`);
      const config = await page.evaluate(async () => (await fetch('/v1/config')).json());
      if (config.flags.approvals) {
        approvalStatus = 'ERROR: warm PWA coverage unavailable: worker CDP throttling failed; no readiness evidence accepted';
        throw new Error(approvalStatus);
      }
    } catch (error) { console.log('Coverage diagnostic', await page.evaluate(() => ({ wsPaints: (window as any).perfFixture.ws.length, wsPending: Object.keys((window as any).perfFixture.wsStarts), rows: document.querySelectorAll('[data-feed-id]').length })).catch(() => null)); errors.push(`Sample ${sample+1}: ${String(error).split('\n')[0]}`); break; }
    finally { await context.close(); }
  }
  const checks = [
    ['LCP max', metrics.lcp, 1, 2000, SAMPLES], ['INP max (scripted landing interactions)', metrics.inp, 1, 200, SAMPLES], ['CLS max session window', metrics.cls, 1, .05, SAMPLES],
    ['Indexed scan p50', metrics.scan, .5, 3000, SAMPLES], ['WS event to after-paint p90', metrics.ws, .9, 50, EVENTS*SAMPLES], ['Quote round-trip p50', metrics.quote, .5, 800, SAMPLES], ['Chart ready after data max', metrics.chart, 1, 300, SAMPLES],
  ] as const;
  const rows: { name: string; value: number | null; limit: number; samples: number; pass: boolean }[] = checks.map(([name, values, percentile, limit, count]) => ({ name, value: q(values, percentile) ?? null, limit, samples: values.length, pass: values.length === count && q(values, percentile)! <= limit }));
  if (process.env.EKO_PERF_APPROVALS === '1') rows.push({ name: 'Warm approval link readiness max', value: q(metrics.approval, 1) ?? null, limit: 1500, samples: metrics.approval.length, pass: metrics.approval.length === SAMPLES && q(metrics.approval, 1)! <= 1500 });
  const report = { measuredAt: new Date().toISOString(), revision, sourceSha256, assetSha256, browser: browser.version(), playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version, profile: PROFILE, transportProbeMs, layoutShifts, viewport: '390x844, DPR 2.75, touch; Chrome mobile emulation', sampleCount: SAMPLES, wsEventsPerSample: EVENTS, fixture: 'service workers blocked; contracts.json; loopback HTTP + real WS; production Vite preview; T flags (optional approvals-only D0 fixture override via EKO_PERF_APPROVALS=1); no RPC, database, worker, or live trading', approvalStatus, metrics, rows, errors, build: JSON.parse(readFileSync('dist/budget-result.json', 'utf8')) };
  const before = JSON.parse(readFileSync(`${root}/docs/reports/137-performance-before-2026-10-03.json`, 'utf8'));
  const comparison = { before: { measuredAt: before.measuredAt, revision: before.revision, sourceSha256: before.sourceSha256, assetSha256: before.assetSha256, browser: before.browser, profile: before.profile, sampleCount: before.sampleCount, rows: before.rows, build: before.build }, after: { rows, build: report.build } };
  Object.assign(report, { comparison });
  const dated = `${root}/docs/reports/137-performance-${report.measuredAt.slice(0,10)}`;
  writeFileSync(`${dated}.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`${dated}.md`, `# Task 137 frontend fixture performance\n\nMeasured ${report.measuredAt}. Candidate ${revision}, uncommitted source digest ${sourceSha256}; production JS digest ${assetSha256}.\n\nChrome ${report.browser}; Playwright ${report.playwright}; ${report.viewport}. CPU ${PROFILE.cpuSlowdown}× slowdown, 4G ${PROFILE.latencyMs} ms latency, ${PROFILE.downloadBytesPerSec} B/s down, ${PROFILE.uploadBytesPerSec} B/s up. ${SAMPLES} fresh contexts; ${EVENTS} sequential WS events per context. Actual event cadence includes the throttled fixture trigger HTTP round-trip plus 200 ms; this is not the 100-card/5 ev/s Radar gate.\n\n${report.fixture}. The separate landing project is unavailable in this worktree: / measures the Scan fallback. Service workers are blocked for core measurements: Chrome worker CDP attachment failed, so a warm PWA measurement is unavailable. Chrome ordered block rules restrict page traffic to localhost; every HTTP request uses page CDP throttling. Each context verifies health and quote round-trips of at least 120 ms. HTTP caches are available within each fresh context; service workers are blocked. Approval readiness: ${approvalStatus}.\n\nLocal fixtures are NOT production field evidence. INP is the maximum Event Timing interaction group duration from a short scripted landing session; it is not a production percentile. LCP and CLS are observed through the pre-scan landing session (2.5 seconds after fonts). WS/scan/chart paint uses a rendering-opportunity proxy (rAF followed by a task), not physical display timing. Quote includes fetch and body consumption, not engine execution. Chart begins at candle body consumption and ends at first populated canvas/readout, not completion of its decorative animation. Server pair-to-verdict p95 belongs to 053/087 and is not measured. Lighthouse is not used: no installation or downloads. Worker control attempts: browser auto-attach rejected non-flattened sessions; manual nested attachment stalled for 300 seconds. Warm PWA coverage remains blocked; its threshold is unchanged. TODO(spec): §12 leaves the exact handset/4G profile and sample count unspecified; this harness pins the values above.\n\n| Metric | Before | After (ms; CLS unitless) | Limit | Samples | Result |\n|---|---:|---:|---:|---:|---|\n${rows.map(r => `| ${r.name} | ${before.rows.find((b: any) => b.name === r.name)?.value?.toFixed(r.name.startsWith('CLS') ? 6 : 2) ?? 'missing'} | ${r.value === null ? 'missing' : r.value.toFixed(r.name.startsWith('CLS') ? 6 : 2)} | ${r.limit} | ${r.samples} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n')}\n\nBefore measured ${before.measuredAt}, source ${before.sourceSha256}, assets ${before.assetSha256}; Chrome ${before.browser}, same profile and five samples (raw evidence: [before JSON](137-performance-before-2026-10-03.json)). Build budgets use decimal kB, gzip level 9, deduplicated static import closures. Landing means first-paint entry JS; validated examples load after a rendering opportunity, lower landing panels on intersection, and scan validation on submission. Their deferred transfers remain subject to the 80 kB chunk cap. This does not claim the entire landing session downloads only 90 kB. The public shell includes App and its static dependencies; wallet routes and wallet actions load the provider/transaction runtime. No threshold was changed or removed from test:checks.

| Build budget | Before (bytes) | After (bytes) | Limit | Result |
|---|---:|---:|---:|---|
| Landing entry | ${before.build.landing} | ${report.build.landing} | 90000 | ${report.build.landing <= 90000 ? 'PASS' : 'FAIL'} |
| Initial public shell | ${before.build.shell} | ${report.build.shell} | 220000 | ${report.build.shell <= 220000 ? 'PASS' : 'FAIL'} |
| Largest deferred chunk | ${before.build.largestRoute} | ${report.build.largestRoute} | 80000 | ${report.build.largestRoute <= 80000 ? 'PASS' : 'FAIL'} |

Landing wallet/stream exclusion and chart-only-coin checks pass when build failures below are empty. Initial public shell wallet exclusion is additionally enforced. Original packet baseline before mock transport splitting was landing 162467, shell 301959, largest deferred chunk 161327 bytes. The follow-up baseline above already includes that fix. Moving wallet code out of the shell increases the largest deferred chunk while keeping it below 80000.\n${report.build.failures.map((f: string) => `- FAIL: ${f}`).join('\n')}\n\n${errors.map(e => `- ERROR: ${e}`).join('\n')}\n\nReproduce: \`pnpm perf:measure\` (builds the same local candidate; uses repository Playwright config with E2E_WEB_PORT=5491 E2E_API_PORT=8991). Raw samples and build graph sizes are in the adjacent JSON. No paid runs or deployment.\n`);
  console.log(JSON.stringify({ rows, errors, approvalStatus, report: path.relative(root, `${dated}.md`) }, null, 2));
  expect(errors, 'measurement coverage errors').toEqual([]);
  expect(rows.filter(r => !r.pass), 'unchanged frontend timing budgets').toEqual([]);
  expect(approvalStatus).not.toContain('ERROR');
});
