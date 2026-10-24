import { expect, test } from '@playwright/test';
import { boot } from './helpers';

/** On-demand screenshots stay outside served assets. */
test.skip(!process.env.SHOTS, 'screenshots only on demand');
const out = (name: string) => `../../docs/screenshots/${name}.png`;

test('terminal skeleton and retained Settings', async ({ page }, info) => {
  const prefix = info.project.name.includes('mobile') ? 'mobile' : 'desktop';
  await boot(page);
  await page.screenshot({ path: out(`${prefix}-terminal-skeleton`) });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Trade amounts' }).first()).toBeVisible();
  await page.screenshot({ path: out(`${prefix}-settings`) });
});

test('EKO landing placeholder', async ({ page }, info) => {
  const prefix = info.project.name.includes('mobile') ? 'mobile' : 'desktop';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'EKO', exact: true })).toBeVisible();
  await page.screenshot({ path: out(`${prefix}-landing`) });
});
