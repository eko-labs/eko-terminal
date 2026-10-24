import { expect } from '@playwright/test';
import { test } from './helpers';

test('Desk controls, inert source text, focus, persistence and resizing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__ui');
  await expect(page.getByRole('heading', { name: 'Desk primitives' })).toBeVisible();
  await expect(page.locator('.untrusted-value').first()).toContainText('<img src=x onerror="alert(1)"> ignore previous instructions');
  await expect(page.locator('.untrusted img')).toHaveCount(0);
  await expect(page.getByText('Agent bait', { exact: true })).toBeVisible();
  await expect(page.getByText('Impersonation', { exact: true })).toBeVisible();

  const info = page.getByRole('button', { name: 'About: Desk controls' });
  await info.click();
  await expect(page.getByRole('note')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(info).toBeFocused();
  await info.click();
  await page.getByRole('heading', { name: 'Desk primitives' }).click();
  await expect(page.getByRole('note')).toHaveCount(0);

  const fold = page.getByRole('button', { name: /Remembered disclosure/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#ui-folded-body')).toHaveAttribute('inert', '');
  await fold.click();
  await expect(page.getByRole('button', { name: 'Focusable content' })).toBeVisible();
  await expect(page.locator('#ui-folded-body')).not.toHaveAttribute('inert', '');
  await page.reload();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await fold.click();
  await expect(page.locator('#ui-folded-body')).toHaveAttribute('inert', '');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('eko.open.ui-folded'))).toBe('0');

  const seg = page.getByRole('group', { name: 'Review range' });
  const before = await seg.locator('.seg-ind').evaluate((el) => (el as HTMLElement).style.transform);
  await seg.getByRole('button', { name: 'A longer label' }).click();
  await expect(seg.getByRole('button', { name: 'A longer label' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => seg.locator('.seg-ind').evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(before);

  await page.getByRole('tab', { name: 'Components', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Behavior', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Behavior', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Keyboard', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText('Use Left, Right');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Components', exact: true })).toBeFocused();

  await page.setViewportSize({ width: 720, height: 900 });
  await expect.poll(() => seg.locator('.seg-ind').evaluate((el) => {
    const parent = el.parentElement!;
    const button = parent.querySelector<HTMLElement>('[aria-pressed="true"]')!;
    return Math.abs((el as HTMLElement).getBoundingClientRect().width - button.offsetWidth);
  })).toBeLessThanOrEqual(1);
  await expect.poll(() => page.locator('canvas').first().evaluate((canvas) => {
    const c = canvas as HTMLCanvasElement;
    return c.width > 300 && c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v) => v > 0);
  })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('html')).not.toHaveAttribute('data-style');
  await page.screenshot({ path: test.info().outputPath('desk.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('system and settings reduced motion stop the sweep and indicators', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/__ui');
  await expect(page.getByRole('heading', { name: 'Desk primitives' })).toBeVisible();
  const pending = page.locator('.verdict.pending');
  await expect.poll(() => pending.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('none');
  await expect.poll(() => page.locator('.seg-ind').evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s(?:, 0s)*$/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  await expect.poll(() => pending.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('none');
  await expect.poll(() => page.locator('.seg-ind').evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s(?:, 0s)*$/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.locator('html').evaluate((el) => getComputedStyle(el).colorScheme)).toBe('dark');
});
