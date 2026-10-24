import { expect } from '@playwright/test';
import { test, configureContext } from './helpers';
test.use({ actionTimeout: 10_000 });
import { ROUTES } from '../src/routes';
import { isApprovedPolicy, LEGAL_COPY, POLICY_DRAFTS } from '../src/copy/legal';
import { candidate, signIn, write, audit, captureErrors, evidence, origin } from './launch-helpers';

export function registerLaunchMatrix(viewports: { width: number; height: number }[]) {
  for (const viewport of viewports) for (const theme of ['dark', 'light'] as const)
  for (const group of ['terminal', 'mission-policies', 'gated-first', 'gated-last']) {
    test(`launch: T route matrix ${viewport.width}×${viewport.height} ${theme} ${group}`, async ({ page: reportPage }, info) => {
      const data = await candidate(reportPage.request), records: unknown[] = [], violations: string[] = [], errors: string[] = [];

      // A fresh SIWE session bounds each sweep below the unchanged API rate limit.
      const context = await reportPage.context().browser()!.newContext({ baseURL: origin(), viewport, colorScheme: theme });
      await configureContext(context);
      const page = await context.newPage(), observed = captureErrors(page);
      try {
        await page.exposeFunction('__ekoRecordCsp', (directive: string) => violations.push(directive));
        await page.addInitScript(() => {
          document.addEventListener('securitypolicyviolation', event => void (window as unknown as { __ekoRecordCsp(value: string): Promise<void> }).__ekoRecordCsp(event.violatedDirective));
        });
        await signIn(page);
        expect((await write(page.request, '/v1/e2e/holdings', {})).status()).toBe(200);
        const scan = await (await write(page.request, '/v1/scan', { query: data.coin })).json();
        expect(scan.status).toBe('ready');
        const agentResponse = await write(page.request, '/v1/agents', { name: 'Sample launch agent', kind: 'robinhood_mcp', preset: 'balanced' });
        expect(agentResponse.status()).toBe(201); const agent = await agentResponse.json();
        const share = await (await write(page.request, `/v1/wallets/${(await (await page.request.get('/v1/me')).json()).account.wallet}/bags/share`, { includeValues: false, includeWallet: false })).json();
        expect(share.shareUrl).toMatch(/^\/bags\/r\//);
        const substitutions: Record<string, string> = { '/coin/:address': `/coin/${data.coin}`, '/scan/:id': scan.shareUrl,
          '/bags/r/:id': share.shareUrl, '/receipt/:id': `/receipt/${data.receiptId}`, '/mission/agents/:id': `/mission/agents/${agent.id}` };
        // OAuth remains prepared until 099 is accepted; its invalid-link refusal is checked separately.
        const paths = ROUTES.filter(route => route.stage === 'T' && route.path !== '/oauth/consent').flatMap(route => route.path === '/legal/:doc'
        ? POLICY_DRAFTS.map(policy => `/legal/${policy.slug}`) : [substitutions[route.path] ?? route.path]);
        // A spec route removed from the implementation cannot silently disappear from the gate.
        expect(paths).toEqual(expect.arrayContaining(['/', '/scan', '/radar', '/feed', '/pairs', '/bags', '/watch', '/scoreboard', '/census', '/drops', '/mission', '/mission/connect', '/settings', '/settings/plan', ...Object.values(substitutions)]));
        const selectedPaths = group === 'terminal' ? paths.slice(0, 14) : group === 'mission-policies' ? paths.slice(14) : [];
        for (const path of selectedPaths) {
          await page.goto(path);
          await expect(page.locator('#main h1')).toBeVisible();
          // Wait for owned/public data rather than auditing a loading frame.
          if (path === '/radar') await expect(page.locator('tr[data-address]').first()).toBeVisible();
          if (path === '/pairs') await expect(page.locator('li[data-address]').first()).toBeVisible();
          if (path === '/feed') await expect(page.locator('[data-feed-id]').first()).toBeVisible();
          if (path.startsWith('/coin/')) {
            if (viewport.width === 390) await page.getByRole('button', { name: 'Expand', exact: true }).click();
            await expect(page.locator('.tp-quote[data-tour="fee-lines"]')).toBeVisible();
            await expect(page.locator('.tp-submit')).toBeDisabled();
          }
          if (path.startsWith('/mission/agents/')) await expect(page.locator('.mc-ahead')).toContainText(agent.name);
          if (path === '/mission/connect') await expect(page.getByRole('radio', { name: /^Claude Code/ })).toBeVisible();
          if (path === scan.shareUrl) await expect(page.getByRole('link', { name: 'Open coin', exact: true })).toBeVisible();
          if (path === share.shareUrl) await expect(page.locator('.bag-card')).toBeVisible();
          if (path === '/receipt/' + data.receiptId) await expect(page.locator('.receipt-panel')).toContainText(data.receiptId);
          if (path === '/watch') await expect(page.getByRole('button', { name: 'Save notifications', exact: true })).toBeVisible();
          if (path === '/census') {
            expect((await (await page.request.get('/v1/census')).json()).gated).toBe(true);
            await expect(page.getByText('Census numbers publish once wallet-label precision passes 90%.', { exact: true })).toBeVisible();
            await expect(page.locator('.census-window,.census-table')).toHaveCount(0);
          }
          const diagnostic = await audit(page, `${viewport.width} ${theme} ${path}`);
          expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
          for (const name of ['Stop all', 'Pause agent', 'Disconnect…', 'Save policy', 'Approve', 'Confirm approve', 'Review and sign session-key policy'])
          await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
          await expect(page.locator('#pol-maxPositionUsd')).toHaveCount(0);
          if (path === '/mission/connect') for (const name of ['Claude Desktop', 'ChatGPT', 'OpenClaw', 'On-chain agent'])
          await expect(page.getByRole('radio', { name: new RegExp(`^${name}`) })).toHaveCount(0);
          if (path.startsWith('/legal/')) {
            await expect(page.locator('#main').getByRole('navigation', { name: 'Launch policies' }).getByRole('link')).toHaveCount(POLICY_DRAFTS.length);
            await expect(page.locator('#main').getByRole('navigation', { name: 'Launch policies' }).locator('[aria-current="page"]')).toHaveCount(1);
            await expect(page.getByRole('heading', { name: isApprovedPolicy(path.split('/')[2] ?? '') ? LEGAL_COPY.approved : LEGAL_COPY.draft, exact: true })).toBeVisible();
          }
          if (['/census', '/mission/connect', '/receipt/' + data.receiptId].includes(path))
          await info.attach(`launch-${viewport.width}-${theme}-${path.split('/')[1]}`, { body: await page.screenshot(), contentType: 'image/png' });
          records.push({ viewport, preferredColorScheme: theme, renderedColorScheme: 'dark', path, ...diagnostic });
        }
        if (group.startsWith('gated-')) {
          const gatedContext = await reportPage.context().browser()!.newContext({ baseURL: origin(), viewport, colorScheme: theme });
          await configureContext(gatedContext);
          const gatedPage = await gatedContext.newPage(), gatedErrors = captureErrors(gatedPage);
          try {
            await signIn(gatedPage);
            for (const route of ROUTES.filter(route => route.stage !== 'T').slice(group === 'gated-first' ? 0 : 10, group === 'gated-first' ? 10 : undefined)) {
              const path = route.path.replace(/:(?:id|loopId|runId)/g, 'sample-gated').replace(':address', data.coin);
              await gatedPage.goto(path);
              await expect(gatedPage.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
              const diagnostic = await audit(gatedPage, `${viewport.width} gated ${path}`);
              records.push({ viewport, preferredColorScheme: theme, path, gated: true, ...diagnostic });
            }
            if (group === 'gated-last') {
              await gatedPage.goto('/oauth/consent');
              await expect(gatedPage.getByRole('alert')).toContainText('This consent link is invalid.');
              await expect(gatedPage.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
              await expect(gatedPage.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0);
              expect(await gatedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              records.push({ viewport, path: '/oauth/consent', prepared: true, acceptance: 'Pending 099 and external connector check' });
            }
          } finally { errors.push(...gatedErrors.errors); await gatedContext.close(); }
        }
        if (group === 'mission-policies') {
          await page.goto('/radar'); await expect(page.locator('tr[data-address]').first()).toBeVisible();
          // Start tabbing from the document, after the router has finished moving focus.
          await page.bringToFront();
          await page.locator('body').click({ position: { x: 1, y: 1 } });
          await page.keyboard.press('Tab');
          await expect.soft(page.getByRole('link', { name: 'Skip to content', exact: true })).toBeFocused({ timeout: 2_000 });
          const skipFocused = await page.getByRole('link', { name: 'Skip to content', exact: true }).evaluate(element => element === document.activeElement);
          await page.keyboard.press('Enter'); await expect.soft(page.locator('#main')).toBeFocused({ timeout: 2_000 });
          const mainFocused = await page.locator('#main').evaluate(element => element === document.activeElement);
          records.push({ viewport, preferredColorScheme: theme, keyboard: { firstTabFocusesSkip: skipFocused, enterFocusesMain: mainFocused } });
        }
      } finally { errors.push(...observed.errors); await context.close(); }
      expect.soft(errors).toEqual([]);
      expect.soft(violations).toEqual([]);
      await evidence(reportPage, info, 'launch-route-evidence', { group, viewport, preferredColorScheme: theme, candidate: data, records, consoleErrors: errors, accessibility: 'Browser structure and keyboard; axe unavailable', cspViolations: violations, csp: 'Local dev server; production CSP pending' });
    });
  }
}
