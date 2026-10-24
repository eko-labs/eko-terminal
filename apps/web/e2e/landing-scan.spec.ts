import { expect } from '@playwright/test';
import { test } from './helpers';
import fixtures from '../src/mocks/contracts.json' with { type: 'json' };

// Synthetic HTTP responses; these checks do not establish live latency or coverage.
const id = `scan-${'a'.repeat(64)}`;
const address = fixtures.CoinCard.identity.address;
const ready = { id, status: 'ready', shareUrl: `/scan/${id}`, card: fixtures.CoinCard };
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/config', route => route.fulfill({ json: { ...fixtures.PublicConfig, exampleScans: [address] } }));
  await page.route('**/v2/radar', route => route.fulfill({ json: { rows: [], cursor: null, delayedSec: 60 } }));
  await page.route('**/v1/scoreboard?*', route => route.fulfill({ json: { counters: { refused: 8, missed: null, since: '2026-10-01T00:00:00Z' } } }));
});
test('mobile input above the fold, validation, candidate selection and persisted reload', async ({ page }) => {
  // Packet 107: scan IDs are keyed by query; a selected CA has a different persisted ID than a ticker.
  const selectedId = `scan-${'b'.repeat(64)}`;
  const selectedReady = { ...ready, id: selectedId, shareUrl: `/scan/${selectedId}` };
  let selected = false;
  await page.route('**/v1/scan', async route => {
    const query = route.request().postDataJSON().query;
    selected = query === address;
    await route.fulfill({ json: selected ? selectedReady : { id, status: 'ambiguous', shareUrl: `/scan/${id}`, candidates: [{ ...fixtures.CoinSummary, address }] } });
  });
  await page.route(`**/v1/scan/${id}`, route => route.fulfill({ json: selected ? ready : { id, status: 'ambiguous', shareUrl: `/scan/${id}`, candidates: [{ ...fixtures.CoinSummary, address }] } }));
  await page.route(`**/v1/scan/${selectedId}`, route => route.fulfill({ json: selectedReady }));
  await page.goto('/');
  const input = page.getByLabel('Paste any contract address or $ticker');
  await expect(input).toBeInViewport(); await expect(input).toHaveAttribute('enterkeyhint', 'go');
  expect((await input.boundingBox())!.y + (await input.boundingBox())!.height).toBeLessThan(844);
  await input.fill('bad-address'); await input.press('Enter'); await expect(page.getByRole('alert')).toContainText('Enter a contract address');
  await input.fill('$DEMO'); await input.press('Enter'); await expect(page).toHaveURL(new RegExp(`/scan/${id}$`));
  await expect(page.getByRole('heading', { name: 'Choose the coin you meant' })).toBeVisible();
  await page.locator('.scan-candidates button').click(); await expect(page.getByRole('link', { name: 'Open coin', exact: true })).toBeVisible();
  expect(selected).toBe(true); await expect(page).toHaveURL(new RegExp(`/scan/${selectedId}$`)); await page.reload(); await expect(page.getByRole('link', { name: 'Scan my bags', exact: true })).toBeVisible();
});
test('pending-to-ready and stale cards keep evidence available', async ({ page }) => {
  // Packet 107's persisted polling can mount twice under StrictMode; hold pending until asserted.
  let complete = false;
  await page.route(`**/v1/scan/${id}`, route => route.fulfill({ json: !complete ? { id, status: 'pending', shareUrl: `/scan/${id}` } : { ...ready, card: { ...ready.card, freshness: { block: 1, ageSec: 45 } } } }));
  await page.goto(`/scan/${id}`); await expect(page.getByText('Scanning… usually under 5 s', { exact: true })).toBeVisible();
  complete = true;
  await expect(page.getByText(/Stale snapshot/)).toBeVisible(); await expect(page.getByRole('link', { name: 'Verify receipt', exact: true })).toBeVisible();
});
