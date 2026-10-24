import { expect } from '@playwright/test';
import { test } from './helpers';
test.use({ demo: true });

for (const [width, height] of [[1512, 982], [1440, 900], [1280, 800], [390, 844]]) {
  test(`Pairs geometry, pending guard and inspector at ${width}×${height}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height }); await page.goto('/pairs');
    await expect(page.locator('.prow').first()).toBeVisible();
    if (width < 900) {
      await expect(page.getByRole('group', { name: 'Column', exact: true })).toBeVisible();
      await expect(page.locator('.pcol')).toHaveCount(1);
      for (const label of ['Near grad', 'Migrated', 'New']) {
        await page.getByRole('group', { name: 'Column', exact: true }).getByRole('button', { name: new RegExp(`^${label}`) }).click();
        await expect(page.locator('.pcol .prow').first()).toBeVisible();
      }
    } else {
      await expect(page.locator('.pcol')).toHaveCount(3);
      const boxes = await page.locator('.pcol').evaluateAll((nodes) => nodes.map((n) => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width }; }));
      expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThan(1); expect(boxes[0].x).toBeLessThan(boxes[1].x); expect(boxes[1].x).toBeLessThan(boxes[2].x);
    }
    for (const row of await page.locator('.prow[data-pending="true"]').all()) {
      await expect(row).toContainText('Scanning…'); await expect(row.getByRole('button', { name: /^Trade/ })).toBeDisabled();
      await expect(row.getByRole('button', { name: /^Trade/ })).toHaveAttribute('title', "Waiting for the guard's first scan.");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `e2e/.artifacts/pairs-feed/pairs-${width}x${height}.png` });
    const pick = page.locator('.prow [data-pick]').first(); await pick.click();
    const inspector = page.locator('#radar-inspector'); await expect(inspector).toBeVisible();
    if (width < 1480) await expect(inspector).toHaveAttribute('role', 'dialog');
    await expect(inspector.locator('.tp-submit')).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(inspector).toHaveCount(0); await expect(pick).toBeFocused();
    if (width === 390) {
      await page.locator('.foot-meta').scrollIntoViewIfNeeded();
      const footer = await page.locator('.foot-meta').boundingBox(), tabs = await page.locator('.mtab').boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(tabs!.y);
    }
    expect(errors).toEqual([]);
  });
  test(`Feed geometry and paused layout at ${width}×${height}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height }); await page.goto('/feed');
    await expect(page.locator('.frow[data-feed-id]').first()).toBeVisible();
    await expect(page.locator('.feed-busy .fb-flow').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Packet 037 adds analysis policy links; event/coin links still point only to coin pages.
    const coinLinks = await page.locator('.feed-grid a').evaluateAll(links => links.map(a => a.getAttribute('href')));
    expect(coinLinks.length).toBeGreaterThan(0);
    for (const href of coinLinks) expect(href).toMatch(/^\/coin\/0x[0-9a-f]{40}$/);
    await expect(page.locator('.feed-page').getByRole('link', { name: 'Risk disclosure', exact: true })).toBeVisible();
    for (const href of await page.locator('.feed-page a').evaluateAll(links => links.map(a => a.getAttribute('href')))) expect(href).toMatch(/^\/(coin\/0x[0-9a-f]{40}|legal\/(risk|ai|terms))$/);

    await page.screenshot({ path: `e2e/.artifacts/pairs-feed/feed-${width}x${height}.png` });
    const list = page.locator('.feed-list'); await list.hover({ position: { x: 20, y: 60 } });
    const first = page.locator('.frow[data-feed-id]').first(), id = await first.getAttribute('data-feed-id'), before = await first.boundingBox();
    await page.evaluate(() => {
      const state = window as unknown as { feedPausedCls: number; feedClsObserver: PerformanceObserver };
      state.feedPausedCls = 0;
      state.feedClsObserver = new PerformanceObserver((records) => records.getEntries().forEach((entry) => { const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }; if (!shift.hadRecentInput) state.feedPausedCls += shift.value; }));
      state.feedClsObserver.observe({ type: 'layout-shift', buffered: false });
    });
    await expect(page.locator('.feed-pill')).toContainText(/\d+ new/, { timeout: 6000 });
    expect(await first.getAttribute('data-feed-id')).toBe(id); expect(await first.boundingBox()).toEqual(before);
    expect(await page.evaluate(() => (window as unknown as { feedPausedCls: number }).feedPausedCls)).toBe(0);
    await page.locator('.feed-pill').click(); await expect(page.locator('.feed-pill')).toHaveCount(0);
    await expect(first).not.toHaveAttribute('data-feed-id', id!);
    if (width === 390) {
      await page.locator('.feed-note').scrollIntoViewIfNeeded();
      const note = await page.locator('.feed-note').boundingBox(), tabs = await page.locator('.mtab').boundingBox();
      expect(note!.y + note!.height).toBeLessThanOrEqual(tabs!.y);
    }
    expect(errors).toEqual([]);
  });
}
test('pairs stream arrivals, stage moves, disabled trade drawer and expanding full-page link', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.clock.install(); await page.goto('/pairs');
  await expect(page.locator('.pcol')).toHaveCount(3);
  const tally = page.locator('.pcol').filter({ has: page.locator('#pcol-near_grad') }).locator('.prow').filter({ hasText: '$TALLY' });
  await expect(tally).toHaveCount(1);
  await page.clock.fastForward(4200);
  await expect(page.locator('.pcol').filter({ has: page.locator('#pcol-migrated') }).locator('.prow').filter({ hasText: '$TALLY' })).toHaveCount(1);
  await expect(page.locator('.prow').filter({ hasText: '$ASTER' })).toHaveCount(1);
  await expect(page.locator('.prow').filter({ hasText: '$ASTER' }).getByRole('button', { name: /^Trade/ })).toBeDisabled();
  const trade = page.locator('.prow[data-pending="false"] .btn:not(:disabled)').first(); await trade.click();
  await expect(page.locator('.radar-trade-drawer')).toBeVisible();
  // Packet 077: quote controls remain usable; only execution is blocked for the paused demo configuration.
  await expect(page.locator('.radar-trade-drawer .tp-submit')).toBeDisabled();
  await expect(page.locator('.radar-trade-drawer')).toContainText('Terminal fee');
  await expect(page.locator('.radar-trade-drawer input').first()).toBeEnabled(); await page.getByRole('button', { name: 'Close trade', exact: true }).click();
  await page.locator('.prow [data-pick]').first().click();
  await page.getByRole('link', { name: 'Open the full page', exact: true }).click(); await page.clock.fastForward(1000);
  await expect(page).toHaveURL(/\/coin\/0x[0-9a-f]{40}$/);
});
test('feed focus, scroll pause, filters and swarm beta', async ({ page }) => {
  await page.goto('/feed'); await expect(page.locator('.frow[data-feed-id]').first()).toBeVisible();
  await page.locator('.feed-list .fr-sym').first().focus(); await expect(page.getByRole('status').filter({ hasText: 'Paused while you read' })).toBeVisible();
  await expect(page.locator('.feed-pill')).toBeVisible({ timeout: 6000 });
  await page.locator('.feed-pill').click(); await page.mouse.move(0, 0); await page.locator('h1').click();
  await page.evaluate(() => scrollTo(0, 450)); await expect(page.getByRole('status').filter({ hasText: 'Paused while you read' })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  for (const label of ['Trades', 'Fast Scans', 'Playbook alerts', 'Ghost Reports', 'Launches', 'Burns']) await page.getByRole('checkbox', { name: new RegExp(`^${label}`) }).uncheck();
  await expect(page.locator('.frow[data-feed-id]').first()).toHaveClass(/k-swarm/);
  for (const row of await page.locator('.frow[data-feed-id]').all()) await expect(row).toContainText('Beta');
});
