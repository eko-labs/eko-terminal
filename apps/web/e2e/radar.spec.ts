import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { PublicConfig } from '@eko/shared';
import { TRADING_PAUSED_TITLE } from '../src/copy/availability';
import { test, configureContext, patchDemoResponse } from './helpers';
test.use({ demo: true });

for (const [width,height] of [[1512,982],[1440,900],[1280,800],[390,844]]) test(`Radar geometry and inspector at ${width}×${height}`, async ({page}) => {
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height}); await page.goto('/radar');
  await expect(page.locator('.rt tbody tr[data-address]')).toHaveCount(30);
  await expect(page.locator('.htile')).toHaveCount(3);
  // Packet 118 retired the invented demo accusation; only reviewed public records may render.
  await expect(page.locator('.ghost-report')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Reviewed Ghost Report' })).toHaveCount(0);
  await expect(page.locator('.radar')).toContainText('30 of 30');
  const inspector=page.locator('#radar-inspector');
  if(width>=1480){await expect(inspector).toBeVisible(); await page.getByRole('button',{name:'Close details',exact:true}).last().click();}
  else await expect(inspector).toHaveCount(0);
  const row=page.locator('[data-pick]').first(); await row.click(); await expect(inspector).toBeVisible();
  await expect(inspector.getByText('Signal · five readings')).toBeVisible();
  await expect(inspector.getByText('FDV', { exact: true })).toBeVisible();
  await expect(inspector.locator('.tp-submit')).toBeDisabled();
  if(width<1480){await expect(inspector).toHaveAttribute('role','dialog');await expect(page.locator('.insp-scrim')).toBeVisible();await expect(page.locator('.radar')).toHaveAttribute('inert','');}
  await page.keyboard.press('Escape'); await expect(inspector).toHaveCount(0); await expect(row).toBeFocused();
  // Packets 023/037: bounded identity and Guard columns drop optional readings earlier.
  const columns={'.c-liq':1160,'.c-act':1020,'.c-flow':940,'.c-spark':840,'.c-watch':740,'.c-1h':600,'.c-sig':600};
  const tableWidth=await page.locator('.rt-wrap').evaluate(e=>e.clientWidth);
  for(const [column,cutoff] of Object.entries(columns)){ const head=page.locator(`.rt thead ${column}`); if(tableWidth<=cutoff) await expect(head).toBeHidden(); else await expect(head).toBeVisible(); }
  for(const column of ['.c-coin','.c-guard','.c-exit']) await expect(page.locator(`.rt thead ${column}`)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.emulateMedia({reducedMotion:'reduce'});
  const marked=page.locator('.rt tr[class*="mk-"]').first();
  await expect(marked).toHaveCSS('animation-name','none');
  await page.screenshot({path:`e2e/.artifacts/radar/radar-${width}x${height}.png`,fullPage:false});
  expect(errors).toEqual([]);
});
test('list keys, filters, sorting, density, close memory and expansion',async({page})=>{
  await page.setViewportSize({width:1512,height:982});await page.goto('/radar');
  await expect(page.locator('.rt tbody tr[data-address]')).toHaveCount(30);
  await page.getByRole('button',{name:'Close details',exact:true}).last().click();
  const rows=page.locator('[data-pick]');await rows.first().focus();await page.keyboard.press('End');await expect(rows.last()).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Home');await expect(rows.first()).toHaveAttribute('aria-pressed','true');await page.keyboard.press('ArrowDown');await expect(rows.nth(1)).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Escape');await expect(rows.nth(1)).toBeFocused();await page.reload();await expect(page.locator('#radar-inspector')).toHaveCount(0);
  await page.getByRole('group',{name:'Row density'}).getByRole('button',{name:'Compact',exact:true}).click();await expect(page.locator('.rt')).toHaveClass(/compact/);await page.reload();await expect(page.locator('.rt')).toHaveClass(/compact/);
  await page.locator('.toolbar-sort select').selectOption('1h move');await expect(page.locator('th.c-1h')).toHaveAttribute('aria-sort','descending');
  await page.getByRole('group',{name:'Show',exact:true}).getByRole('button',{name:'Hot',exact:true}).click();await expect(page.locator('.rt tbody tr.h-avoid')).toHaveCount(0);
  await page.getByRole('group',{name:'Show',exact:true}).getByRole('button',{name:'All',exact:true}).click();
  await rows.first().click();await page.getByRole('link',{name:'Open the full page',exact:true}).click();await expect(page).toHaveURL(/\/coin\/0x[0-9a-f]{40}$/);
});
test('WS flashes update existing rows once without changing their node identity',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await page.goto('/radar');
  const rows=page.locator('.rt tbody tr[data-address]');await expect(rows).toHaveCount(30);
  await rows.evaluateAll(elements => {
    (window as unknown as { radarRows: Map<string, Element> }).radarRows = new Map(elements.map(el => [(el as HTMLElement).dataset.address!, el]));
  });
  // The prototype updates a random row. Observe whichever row flashes, then verify every node stayed mounted.
  await expect(page.locator('.rt tbody tr.pulse').first()).toHaveClass(/pulse/,{timeout:6000});
  expect(await rows.evaluateAll(elements => elements.every(el =>
    (window as unknown as { radarRows: Map<string, Element> }).radarRows.get((el as HTMLElement).dataset.address!) === el))).toBe(true);
  await expect(page.locator('.rt tbody tr[data-address]')).toHaveCount(30);
});
test('Trade stays off and says why while live trading is paused',async({page})=>{
  // The demo config pauses live trading: every Trade button is disabled with the reason; Refused rows keep the guard's.
  await page.setViewportSize({width:1512,height:982});await page.goto('/radar');
  await page.getByRole('button',{name:'Close details',exact:true}).last().click();
  const trades=page.locator('.c-act button').filter({hasText:/^Trade$/});await expect(trades.first()).toBeVisible();
  for(const trade of await trades.all()){
    await expect(trade).toBeDisabled();await expect(trade).toHaveAttribute('title',TRADING_PAUSED_TITLE);
    expect(await trade.getAttribute('aria-label')).toContain(TRADING_PAUSED_TITLE);
  }
  await expect(page.locator('.c-act button:not(:disabled)')).toHaveCount(0);
});
test('trade opens an inert drawer and returns focus',async({page})=>{
  // Serve the demo config with live trading on so Trade opens the drawer; the paused state is covered above.
  await patchDemoResponse<PublicConfig>(page,'/v1/config',config=>({...config,trading:{...config.trading,liveEnabled:true}}));
  await page.setViewportSize({width:1512,height:982});await page.goto('/radar');
  await page.getByRole('button',{name:'Close details',exact:true}).last().click();
  // The full-width list exposes its Trade column at this size.
  const trade=page.locator('.c-act button:not(:disabled)').first();await trade.click();
  await expect(page.locator('.radar-trade-drawer')).toBeVisible();await expect(page.locator('.radar-trade-drawer .tp-submit')).toBeDisabled();
  await page.keyboard.press('Escape');await expect(page.locator('.radar-trade-drawer')).toBeHidden();await expect(trade).toBeFocused();
});

test('phone scroll and top bar stay clear of the fixed navigation', async ({page}) => {
  await page.setViewportSize({width:390,height:844});await page.goto('/radar');
  const first=page.locator('[data-pick]').first(), last=page.locator('[data-pick]').last();
  await expect(first).toBeAttached();
  for(const row of [first,last]){
    await row.evaluate(el=>el.scrollIntoView({block:'end'}));
    const button=await row.boundingBox(), tabs=await page.locator('.mtab').boundingBox();
    expect(button!.y+button!.height).toBeLessThanOrEqual(tabs!.y);
    await row.click();await expect(page.locator('#radar-inspector')).toBeVisible();
    await page.keyboard.press('Escape');await expect(row).toBeFocused();
  }
  const wallet=page.locator('.mbar .wallet-btn');await expect(wallet).toBeVisible();
  await expect(wallet).toHaveClass(/btn-primary/);await expect(wallet).toHaveText('Connect wallet');
  await expect(page.locator('.mbar .trial')).toHaveText('Free · launch week');
  const trial=await page.locator('.mbar .trial-top').boundingBox();expect(trial!.height).toBeLessThan(24);
});
test('Desktop nav icons, tile labels, and mouse/touch targets', async ({page,browser,baseURL}) => {
  await page.setViewportSize({width:1440,height:900});await page.goto('/radar');
  await expect(page.locator('.side-item').first()).toBeVisible();
  expect(await page.locator('.side-item').evaluateAll(items=>items.every(item=>item.firstElementChild?.tagName.toLowerCase()==='svg'))).toBe(true);
  await expect(page.locator('.side .wallet-btn')).toHaveClass(/btn-primary/);
  const tiles=page.locator('.htile');await expect(tiles).toHaveCount(3);
  for(const tile of await tiles.all()){
    await expect(tile.locator('.htile-facts')).not.toContainText('confidence');
    await expect(tile.locator('.signal-beta')).toHaveCount(1);
    await expect(tile.locator('.htile-sym .untrusted-value')).toHaveCSS('white-space','nowrap');
  }
  const mouse=page.getByRole('group',{name:'Show',exact:true}).getByRole('button',{name:'All',exact:true});
  const mouseBox=await mouse.boundingBox();expect(mouseBox!.height).toBeGreaterThanOrEqual(24);expect(mouseBox!.height).toBeLessThan(44);
  const touchContext=await browser.newContext({baseURL,hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
  await configureContext(touchContext, true);
  try{
    const touch=await touchContext.newPage();await touch.goto('/radar');
    const target=touch.getByRole('group',{name:'Show',exact:true}).getByRole('button',{name:'All',exact:true});await expect(target).toBeVisible();
    const box=await target.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.width).toBeGreaterThanOrEqual(44);
  }finally{await touchContext.unrouteAll({behavior:'wait'});await touchContext.close();}
});

// Packet 118 replacement for the retired fabricated Ghost Report banner (FRONTEND §3.2, §8).
test.describe('reviewed Ghost Reports over HTTP', () => {
  // Real HTTP: the helper turns mocks off for this context although the radar config starts Vite with VITE_MOCKS=1.
  test.use({ demo: false });
  test('reviewed evidence renders, while an empty public record never invents findings', async ({ page }) => {
    await page.goto('/__ui');
    const fixturePath = '/@fs' + fileURLToPath(new URL('../../../packages/shared/test/fixtures/contracts/ghost-reports.ts', import.meta.url));
    const { ghostRecord, ghostSamples } = await page.evaluate(async path => {
      const { ghostRecord, ghostSamples } = await import(/* @vite-ignore */ path);
      return { ghostRecord, ghostSamples };
    }, fixturePath);
    const record = { ...ghostRecord, review: ghostSamples.GhostReportReview, status: 'reviewed_partial' };
    let records = [record];
    await page.route('**/v2/ghost-reports', route => route.fulfill({ json: { records } }));
    await page.goto('/radar');
    const report = page.getByRole('article', { name: 'Reviewed Ghost Report' });
    await expect(report).toContainText('Facts reviewed · partial evidence');
    await expect(report).toContainText(record.draft.assessment.coin);
    await expect(report).toContainText('Not fully checked');
    await expect(report).toContainText('Receipt anchor verification pending');
    await expect(report.getByRole('link', { name: 'Verify receipt' })).toHaveAttribute('href', `/receipt/${record.draft.assessment.receipt.id}`);
    await report.locator('summary').click();
    await expect(report.locator('pre')).toContainText('Not financial advice');
    records = [];
    await page.getByRole('button', { name: 'Refresh reports' }).click();
    await expect(report).toHaveCount(0);
    await expect(page.locator('.ghost-report')).toHaveCount(0);
  });
});
