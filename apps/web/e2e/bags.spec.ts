import { expect, type Page } from '@playwright/test';
import { test, connectWallet, verifyWallet } from './helpers';
import { generatePrivateKey } from 'viem/accounts';
import { bagFixture } from '../src/mocks/bags';
import type { BagReport, PublicBagReport } from '@eko/shared';

// Expected public API projection for the fixed synthetic holding, independent of the frontend adapter.
function snapshot(report: BagReport, options: { includeValues: boolean; includeWallet: boolean }): PublicBagReport {
  const { wallet, ...rest } = report;
  return { ...rest, ...(options.includeWallet ? { wallet } : {}),
    holdings: report.holdings.map(row => {
      const { priceUsd, liquidityUsd, marketCapUsd, guardV2: _guard, ...coin } = row.coin;
      const { valueUsd, ...holding } = row;
      return { ...holding, balance: '1200', coin: { ...coin, ...(options.includeValues ? { priceUsd, liquidityUsd, marketCapUsd } : {}) }, ...(options.includeValues ? { valueUsd } : {}) };
    }),
    summary: { coins: 1, flagged: 1, danger: 1, ...(options.includeValues ? { valueUsd: report.summary.valueUsd } : {}) },
  };
}
import { installMockWallet } from './mockWallet';

const id = '00000000-0000-4000-8000-000000000110';
async function shareMetadata(page: Page) {
  // Packet 111: metadata is a separate public projection, independent of private holdings.
  await page.route('**/v1/share-meta?*', route => {
    const origin = new URL(route.request().url()).origin;
    return route.fulfill({ json: { title: 'EKO · Shared bag report', description: '1 coins · 1 flagged · 1 danger · DYOR · Not financial advice · AI-generated analysis', url: `${origin}/bags/r/${id}`, image: `${origin}/og/bags/${id}.png` } });
  });
}
// API responses and wallet below are synthetic; no live wallet, RPC, billing or SIWE verification evidence.
async function fixture(page: Page, wallet: string) {
  await shareMetadata(page);
  const report = { ...bagFixture, wallet: wallet.toLowerCase() as `0x${string}` };
  let calls = 0, failed = true, options = { includeValues: false, includeWallet: false };
  const payloads: unknown[] = [];
  // Keep real SIWE and /me identity; only holdings/watch data are synthetic.
  await page.route('**/v1/watch', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/v1/wallets/*/bags**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/share')) {
      options = route.request().postDataJSON(); payloads.push(options);
      await route.fulfill({ status: 201, json: { id, shareUrl: `/bags/r/${id}` } }); return;
    }
    calls++;
    if (url.searchParams.has('retry')) failed = false;
    const status = calls === 1 ? 'pending' : failed ? 'error' : 'ready';
    await route.fulfill({ json: { ...report, holdings: [{ ...report.holdings[0], status, ...(status === 'error' ? { error: 'scan_failed' } : {}) }] } });
  });
  await page.route(`**/v1/bags/${id}`, route => route.fulfill({ json: snapshot(report, options) }));
  return { report, payloads };
}
for (const [width, height] of [[1512, 982], [1440, 900], [1280, 800], [390, 844]]) {
  test(`Bags connect, retry, disclosures and share parity at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const account = await installMockWallet(page, { key: generatePrivateKey(), chainId: 4663 });
    const data = await fixture(page, account.address);
    await page.goto('/bags');
    await expect(page.getByRole('heading', { name: 'Connect a wallet to scan what you hold' })).toBeVisible();
    await connectWallet(page);
    await expect(page.getByRole('heading', { name: 'Connect a wallet to scan what you hold' })).toBeVisible();
    await verifyWallet(page);
    await expect(page.locator('.bags-page h1')).toHaveText('Scan my bags');
    const holdings = width === 390 ? page.locator('.bag-holding') : page.locator('.bags-table tbody tr');
    await expect(holdings).toContainText("Couldn't scan");
    await page.getByRole('button', { name: 'Retry scans on this page' }).click();
    await expect(holdings).toContainText('Honeypot');
    await expect(holdings.getByRole('button', { name: 'Sell through the guard' })).toBeDisabled();
    await holdings.getByText('Evidence and limits', { exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: 'Open coin evidence' })).toBeVisible();
    const share = width === 390 ? page.locator('.bag-sticky button') : page.locator('.bags-head-actions').getByRole('button', { name: 'Share bag report' });
    if (width === 390) { await expect(share).toBeVisible(); expect(await page.locator('.bag-sticky').evaluate(el => getComputedStyle(el).position)).toBe('sticky'); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await share.click(); await expect(page.getByRole('link', { name: 'Open shared report' })).toBeVisible();
    expect(data.payloads).toEqual([{ includeValues: false, includeWallet: false }]);
    const defaultCard = await page.locator('.bag-card').innerText(); expect(defaultCard).not.toContain(data.report.wallet); expect(defaultCard).not.toContain('$4K');
    await page.getByLabel('Include values', { exact: true }).check(); await share.click();
    await expect(page.getByRole('link', { name: 'Open shared report' })).toBeVisible();
    expect(data.payloads.at(-1)).toEqual({ includeValues: true, includeWallet: false });
    const valuesCard = await page.locator('.bag-card').innerText(); expect(valuesCard).toContain('$4K'); expect(valuesCard).not.toContain(data.report.wallet);
    await page.getByLabel('Show wallet address', { exact: true }).check(); await share.click();
    await expect(page.getByRole('link', { name: 'Open shared report' })).toBeVisible();
    expect(data.payloads.at(-1)).toEqual({ includeValues: true, includeWallet: true });
    const card = await page.locator('.bag-card').innerText(); expect(card).toContain(data.report.wallet);
    // Reload the issued snapshot independently of the private report view.
    await page.goto(`/bags/r/${id}`);
    await expect(page.locator('.bag-public .bag-card')).toBeVisible();
    expect(await page.locator('.bag-card').innerText()).toBe(card);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
test('Public bag snapshot needs no wallet and retries failed reads', async ({ page }) => {
  await shareMetadata(page);
  const publicSnapshot = snapshot(bagFixture, { includeValues: false, includeWallet: false });
  let failed = true;
  await page.route(`**/v1/bags/${id}`, route => route.fulfill(failed ? { status: 503, json: { error: 'internal_error', message: 'Unavailable' } } : { json: publicSnapshot }));
  await page.goto(`/bags/r/${id}`); await expect(page.getByRole('alert')).toContainText('Could not load');
  failed = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.bag-card')).toContainText('Wallet hidden');
  await expect(page.locator('.bag-card')).not.toContainText(bagFixture.wallet!);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', new RegExp(`/og/bags/${id}.png$`));
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/bags/r/${id}$`));
  await expect(page).toHaveTitle('EKO · Shared bag report');
  expect(await page.locator('meta[property="og:description"]').getAttribute('content')).not.toMatch(/0x|\$4K/);
});
