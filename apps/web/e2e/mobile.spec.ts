import { expect } from '@playwright/test';
import { test } from './helpers';
import { boot } from './helpers';

test('mobile: the Radar and wallet render without paper trading controls', async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId('wallet-button').filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId('mode-switch')).toHaveCount(0);
  await expect(page.getByTestId('trade-buy')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Radar', exact: true })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(tabs.getByRole('link')).toHaveCount(3);
  await tabs.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trading', exact: true })).toBeVisible();
});
