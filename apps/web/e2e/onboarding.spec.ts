import { expect } from '@playwright/test';
import { test } from './helpers';
import fixtures from '../src/mocks/contracts.json' with { type: 'json' };

// Synthetic HTTP responses; this suite is not live-chain evidence.
const id = `scan-${'a'.repeat(64)}`;
const ready = { id, status: 'ready', shareUrl: `/scan/${id}`, card: fixtures.CoinCard };
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/config', route => route.fulfill({ json: fixtures.PublicConfig }));
  await page.route('**/v1/me', route => route.fulfill({ status: 401, json: { error: 'wallet_auth_required', message: 'Sign in required' } }));
  await page.route(`**/v1/scan/${id}`, route => route.fulfill({ json: ready }));
});

test('value precedes the tour offer, keyboard dismissal and progress survive reload', async ({ page }) => {
  await page.goto('/scan');
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await expect(page.getByTestId('tour-pill')).toHaveCount(0);
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.goto(`/scan/${id}`);
  await expect(page.getByRole('link', { name: 'Open coin', exact: true })).toBeVisible();
  await expect(page.getByTestId('tour-pill')).toBeVisible();
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await page.getByTestId('tour-pill').click();
  await expect(page.getByTestId('tour-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('checklist-pill')).toBeVisible();
  await expect(page.getByTestId('tour-pill')).toHaveCount(0);
  await page.getByTestId('checklist-pill').click();
  await expect(page.getByTestId('checklist-scan_coin')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('checklist-guarded_trade')).toHaveAttribute('data-done', 'false');
  await expect(page.locator('.ob-cl-item')).toHaveCount(5);
});

test('the off bypass disables automatic onboarding after a scan', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('eko.onboarding', 'off'));
  await page.goto(`/scan/${id}`);
  await expect(page.getByRole('link', { name: 'Open coin', exact: true })).toBeVisible();
  await expect(page.getByTestId('tour-pill')).toHaveCount(0);
  await expect(page.getByTestId('checklist-pill')).toHaveCount(0);
  await expect(page.getByTestId('welcome')).toHaveCount(0);
});

test('mobile tours skip missing trade anchors and stop under reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/scan/${id}`);
  await page.getByTestId('tour-pill').click();
  await expect(page.getByTestId('tour-card')).toBeVisible();
  const steps: string[] = [];
  while (await page.getByTestId('tour').count()) {
    const card = page.getByTestId('tour-card');
    await expect(card).toBeVisible();
    steps.push((await card.getAttribute('data-step'))!);
    expect(await card.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.getByTestId('tour-next').click();
  }
  expect(steps).not.toContain('trade');
  expect(steps).not.toContain('fee-lines');
  expect(steps.length).toBeGreaterThan(0);
  await expect(page.getByTestId('welcome')).toHaveCount(0);
});
