import { expect, type Page, type TestInfo, type APIRequestContext } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import type { PublicReceiptPayload } from '@eko/shared';
import { connectWallet, verifyWallet } from './helpers';
import { installMockWallet } from './mockWallet';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Real HTTP, SIWE, database projections, encryption and deletion; synthetic indexed corpus.
// No fork, live transaction, production provider, OAuth connector or published registry evidence.
export const desktopSizes = [{ width: 1512, height: 982 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }];
export const sizes = (info: TestInfo) => info.project.name === 'mobile' ? [{ width: 390, height: 844 }] : desktopSizes;
export const origin = () => `http://localhost:${process.env.E2E_WEB_PORT ?? 5190}`;
export async function write(request: APIRequestContext, path: string, data: unknown, method = 'POST', bearer?: string) {
  const response = await request.fetch(path, { method, data, headers: { Origin: origin(), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
  return response;
}
export async function candidate(request: APIRequestContext) {
  const response = await request.get('/v1/e2e/candidate');
  expect(response.ok()).toBe(true);
  return await response.json() as { coin: `0x${string}`; symbol: string; receiptId: string; payload: PublicReceiptPayload; candidate: string; node: string; server: string };
}
export async function signIn(page: Page) {
  const account = await installMockWallet(page, { key: generatePrivateKey(), chainId: 4663 });
  await page.goto('/radar'); await connectWallet(page); await verifyWallet(page);
  return account;
}
export async function audit(page: Page, label: string) {
  await expect.soft(page.locator('#main')).toBeVisible();
  await expect.soft(page.locator('#main h1')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    overflowElements: [...document.querySelectorAll('#main *')].filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width > 0 && bounds.right > innerWidth + 1;
    }).slice(0, 12).map(element => ({ tag: element.tagName, className: element.getAttribute('class'), right: element.getBoundingClientRect().right })) }));
  expect.soft(layout.documentWidth <= layout.viewportWidth, `${label}: page overflow`).toBe(true);
  // Browser accessibility structure checks. This is deliberately not an axe/WCAG certification.
  await expect.soft(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.soft(page.getByRole('main')).toHaveCount(1);
  const snapshot = await page.locator('#main').ariaSnapshot();
  expect.soft(snapshot, `${label}: accessible heading`).toMatch(/heading .*\[level=1\]/);
  const unnamed = await page.locator('#main').evaluate(root => [...root.querySelectorAll('button,input,select,textarea')].filter(element => {
    if (!(element instanceof HTMLElement) || !element.getBoundingClientRect().height || element.getAttribute('type') === 'hidden') return false;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(' ').some(id => document.getElementById(id)?.textContent?.trim());
    const labels = 'labels' in element ? (element as HTMLInputElement).labels : null;
    return !labelledBy && !element.getAttribute('aria-label') && !element.getAttribute('title') && !labels?.length
      && !(element.tagName === 'BUTTON' && element.textContent?.trim());
  }).map(element => element.outerHTML.slice(0, 160)));
  expect.soft(unnamed, `${label}: controls need accessible names`).toEqual([]);
  return { ...layout, overflow: layout.documentWidth > layout.viewportWidth, unnamedControls: unnamed };
}
export function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  return { errors };
}
export async function evidence(page: Page, info: TestInfo, name: string, data: unknown) {
  const path = info.outputPath(`${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ browser: page.context().browser()!.version(), ...data as object }, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

