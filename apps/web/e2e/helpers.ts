import { expect, test as base, type Page, type BrowserContext, type Route } from '@playwright/test';

const drains = new WeakMap<BrowserContext, () => Promise<void>>();

export const test = base.extend<{ demo: boolean }>({
  demo: [false, { option: true }],
  // Drain asynchronous demo responses while the page is alive, before removing
  // interception: unrouteAll can otherwise continue a route before its fulfillment.
  page: async ({ page, context }, use) => {
    try { await use(page); }
    finally { await drains.get(context)?.(); await context.unrouteAll({ behavior: 'wait' }); }
  },
  context: async ({ context, demo }, use) => {
    await configureContext(context, demo);
    try { await use(context); }
    finally { await context.unrouteAll({ behavior: 'wait' }); }
  },
});

export async function configureContext(context: BrowserContext, demo = false) {
  // These suites formerly used standalone VITE_MOCKS=1 configs (packets 008, 014, 015, 020).
  // Scope the same demo HTTP/stream transport to each fixture context, keeping SIWE/API suites real.
  const pending = new Set<Promise<void>>();
  const previousDrain = drains.get(context);
  drains.set(context, async () => {
    await previousDrain?.();
    while (pending.size) await Promise.all([...pending]);
  });
  const handle = async (route: Route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort('blockedbyclient');
    if (url.pathname === '/src/lib/api.ts') {
      const response = await route.fetch();
      const source = await response.text();
      expect(source).toMatch(/export const MOCKS = .*?;/);
      // A non-demo context keeps the real transport even when its config starts Vite with VITE_MOCKS=1.
      if (!demo) return route.fulfill({ response, body: source.replace(/export const MOCKS = .*?;/, 'export const MOCKS = false;') });
      return route.fulfill({ response, body: source.replace(/export const MOCKS = .*?;/, 'export const MOCKS = true;')
        .replace(/const client = createApi\(API_BASE,[\s\S]*?\nexport const fetchParsed/, 'const client = createApi(API_BASE);\nexport const fetchParsed') });
    }
    if (demo && (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/'))) {
      // Reuse the packet transport in the browser, but carry HTTP through Playwright so tests can
      // override individual persisted responses without replacing application state or components.
      return route.fulfill({ ...await demoResponse(route), contentType: 'application/json' });
    }
    await route.fallback();
  };
  await context.route('**/*', async route => {
    const work = handle(route); pending.add(work);
    try { await work; } finally { pending.delete(work); }
  });
}

/** The packet transport's answer to one request, produced inside the page. */
async function demoResponse(route: Route) {
  const request = route.request();
  return request.frame().page().evaluate(async ({ url, method, body }) => {
    const modulePath = '/src/mocks/transport.ts';
    const { mockFetch } = await import(/* @vite-ignore */ modulePath);
    const response = await mockFetch(url, { method, ...(body ? { body } : {}) });
    return { status: response.status, body: await response.text() };
  }, { url: request.url(), method: request.method(), body: request.postData() });
}

/** Serves one demo endpoint with a test-specific change, leaving every other response to the shared transport. */
export async function patchDemoResponse<T>(page: Page, pathname: string, patch: (body: T) => T) {
  await page.route(url => url.pathname === pathname, async route => {
    const { status, body } = await demoResponse(route);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(patch(JSON.parse(body) as T)) });
  });
}

export async function boot(page: Page, path = '/radar') {
  await page.goto(path);
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.getByTestId('wallet-button').filter({ visible: true })).toBeVisible();
  if (page.viewportSize()!.width < 900) await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  else await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Terminal');
}

export async function connectWallet(page: Page) {
  await page.getByTestId('wallet-button').filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: /Test Wallet/ }).click();
  await expect(page.getByRole('menuitem', { name: /Verify wallet/ })).toBeVisible();
}

export async function verifyWallet(page: Page) {
  await page.getByRole('menuitem', { name: /Verify wallet/ }).click();
  await expect(page.getByRole('menuitem', { name: /Verify wallet/ })).toHaveCount(0);
  await expect(page.locator('.wallet-menu .wallet-rows')).toContainText('Yes');
  await page.getByTestId('wallet-button').filter({ visible: true }).click();
}
