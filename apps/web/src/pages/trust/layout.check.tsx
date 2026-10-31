import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { ReceiptLookupSchema, ScoreboardResponseSchema } from '@eko/shared';
import { ReceiptContents } from './Receipt';
import { CohortRows, RecordRows, ScoreboardHeadlines } from './Scoreboard';

// Offline layout check: real component markup/CSS, browser pipe, no server or RPC.
it('fits long receipts, equal counters and cohort cards at mobile and desktop widths', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const receipt = ReceiptLookupSchema.parse({ id: 'sample-receipt', kind: 'harness_private', hash: `0x${'12'.repeat(32)}`, leaf: `0x${'34'.repeat(32)}`, status: 'pending', canonicalization: 'jcs-rfc8785/v1' });
    const unavailable = { status: 'unavailable', reason: 'outcomes_unaccepted' };
    const data = ScoreboardResponseSchema.parse({ rows: [], cursor: null, snapshot: '1', counters: { refused: null, missed: null, since: null }, availability: { refused: unavailable, missed: unavailable, grades: unavailable, forecasts: unavailable, cohort: unavailable, milestones: unavailable } });
    const markup = renderToStaticMarkup(<div className="page trust-page"><ScoreboardHeadlines data={data} /><RecordRows rows={[{ kind: 'calls', id: 'sample-call', ts: '2026-10-01', coin: `0x${'ab'.repeat(20)}`, receiptId: 'sample-receipt', detail: {} }]} /><CohortRows rows={['clear', 'all'].map(group => ({ kind: 'cohort', id: group, ts: '2026-10-01', detail: { group, week: '2026-09-21', eligible: 4, immature: 4, evaluated: 0, ungraded: 0, censored: 0, rugRateStatus: 'unavailable', medianStatus: 'unavailable', rugDenominator: 0, medianDenominator: 0, horizonSec: 86400, membershipHash: 'ab'.repeat(32) } }))} /><ReceiptContents receipt={receipt} result={null} registryAvailable={false} onVerify={() => {}} /></div>);
    const css = readFileSync(new URL('./trust.css', import.meta.url), 'utf8');
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      await page.route('**/*', route => route.abort());
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}.page{padding:16px} ${css}</style>${markup}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const counters = await page.locator('.scoreboard-counter').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
      expect(counters[0]).toBe(counters[1]);
      const cards = await page.locator('.scoreboard-cohorts article').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })));
      if (width === 390) { expect(cards[0]!.x).toBe(cards[1]!.x); expect(cards[1]!.y).toBeGreaterThan(cards[0]!.y); }
      else expect(cards[0]!.y).toBe(cards[1]!.y);
      expect(await page.getByRole('button', { name: 'Verify', exact: true }).isDisabled()).toBe(true);
      await page.close();
    }
  } finally { await browser.close(); }
});
