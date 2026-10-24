import { expect } from '@playwright/test';
import { test } from './helpers';
import { generatePrivateKey } from 'viem/accounts';
import { boot, connectWallet, verifyWallet } from './helpers';
import { installMockWallet } from './mockWallet';

test.describe('EKO day-one shell', () => {
  test('the terminal renders without retired feed, analyst or paper controls', async ({ page }) => {
    await boot(page);
    await expect(page.getByRole('heading', { name: 'Radar', exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Risk mode', exact: true })).toBeVisible();
    await expect(page.locator('#main')).not.toContainText('The terminal is being built.');
    for (const selector of ['.ml', '.sig-pill', '.tc-analyst', '.pm-switch', '.positions-panel']) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
    for (const path of ['/bots', '/bots/tideline', '/portfolio', '/publish', '/brand']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
    }
  });

  test('wrong-network detection, switching and Sign-In With Ethereum', async ({ page }) => {
    const acct = await installMockWallet(page, { key: generatePrivateKey(), chainId: 1 });
    await boot(page);
    // Exercise the retained network banner explicitly; signing also enforces chain 4663.
    await page.evaluate(() => (window as unknown as { __eko: { getState(): { setMode(m: string): void } } }).__eko.getState().setMode('live'));
    await connectWallet(page);
    await expect(page.getByTestId('wallet-button').filter({ visible: true })).toContainText(acct.address.slice(0, 6));
    // Wallet is on Ethereum mainnet → the account menu offers the switch, then SIWE.
    await page.getByRole('menuitem', { name: /Switch to Robinhood Chain/ }).click();
    await expect(page.getByRole('menuitem', { name: /Switch to Robinhood Chain/ })).toHaveCount(0);
    await verifyWallet(page);
    // Verified once the session rotated to the wallet account (asking the server any earlier would race the rotation).
    await expect(page.getByRole('menuitem', { name: /Verify wallet/ })).toHaveCount(0);
    await expect(page.getByTestId('wallet-button').filter({ visible: true })).toContainText(acct.address.slice(0, 6));
    await expect.poll(async () => (await (await page.request.get('/v1/me')).json()).account).toMatchObject({ wallet: acct.address.toLowerCase() });
  });

  test('keyboard navigation and the command palette still work', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/settings$/);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill('Radar');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/radar$/);
    await expect(page.getByRole('heading', { name: 'Radar', exact: true })).toBeVisible();
  });

  test('Settings persists trade preferences without the retired portfolio UI', async ({ page }) => {
    await boot(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Trading' }).first()).toBeVisible();
    await page.getByRole('spinbutton', { name: 'Trade amount 4', exact: true }).fill('1000');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Preferences saved');
    await page.reload();
    await expect(page.getByRole('spinbutton', { name: 'Trade amount 4', exact: true })).toHaveValue('1000');
    const preferences = await (await page.request.get('/v1/me/preferences')).json();
    expect(preferences.quickAmounts).toContain(1000);
  });

  test('the landing page carries EKO identity and non-affiliation copy', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('EKO · Every move has a cause.');
    await expect(page.getByRole('heading', { name: 'Every move has a cause.', exact: true })).toBeVisible();
    await expect(page.locator('.landing-disclosures').getByText(/Built on Robinhood Chain/)).toBeVisible();
    await expect(page.locator('footer').getByText(/Not affiliated with, endorsed by, or officially connected with Robinhood Markets/)).toBeVisible();
    await expect(page.locator('img[src^="/brand/"]')).toHaveCount(0);
  });
});
