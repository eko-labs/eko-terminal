import { expect } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { decodeFunctionData, erc20Abi } from 'viem';
import { canonicalize } from '@eko/shared';
import { test, connectWallet, verifyWallet, configureContext } from './helpers';
import { installMockWallet } from './mockWallet';
import { candidate, signIn, write, audit, evidence, sizes, origin } from './launch-helpers';
test.use({ actionTimeout: 10_000 });

test('launch: persisted scan, private bags and wallet-free redacted share', async ({ page, context }, info) => {
  const data = await candidate(page.request);
  await signIn(page); await write(page.request, '/v1/e2e/holdings', {});
  for (const viewport of sizes(info)) {
    await page.setViewportSize(viewport); await page.goto('/scan');
    await page.getByLabel('Paste any contract address or $ticker').fill(data.coin);
    await page.getByLabel('Paste any contract address or $ticker').press('Enter');
    await expect(page.getByRole('link', { name: 'Open coin', exact: true })).toBeVisible();
    const scanPath = new URL(page.url()).pathname;
    await page.reload(); await expect(page.getByRole('link', { name: 'Open coin', exact: true })).toBeVisible();
    const htmlResponse = await page.request.get(`http://localhost:${process.env.E2E_API_PORT ?? 8720}${scanPath}`);
    expect(htmlResponse.ok()).toBe(true);
    const html = await htmlResponse.text();
    expect(html).toMatch(/property="og:image"/); expect(html).toMatch(/name="twitter:card"/);
    await page.getByRole('link', { name: 'Open coin', exact: true }).click();
    await expect(page.locator('.coin-id')).toContainText(data.symbol);
    await expect(page.locator('.tp-submit')).toBeDisabled();
    await page.goto('/bags'); await expect(page.locator('.bags-page h1')).toHaveText('Scan my bags');
    await expect(page.locator('.bags-page')).toContainText(data.symbol);
    // Without an archive RPC, balance/value evidence must remain explicitly unavailable.
    const me = await (await page.request.get('/v1/me')).json();
    const report = await (await page.request.get(`/v1/wallets/${me.account.wallet}/bags`)).json();
    expect(report.holdings.length).toBeGreaterThan(0); expect(report.holdings[0].balance).toBeNull();
    expect(report.holdings[0].balanceStatus).toBe('error');
    const shareButton = viewport.width === 390 ? page.locator('.bag-sticky button') : page.locator('.bags-head-actions').getByRole('button', { name: 'Share bag report', exact: true });
    await shareButton.click();
    const link = page.getByRole('link', { name: 'Open shared report', exact: true }); await expect(link).toBeVisible();
    const sharedPath = (await link.getAttribute('href'))!;
    const guest = await context.browser()!.newContext({ baseURL: origin(), viewport });
    try {
      await configureContext(guest);
      const publicPage = await guest.newPage();
      // Share reads need neither a wallet provider nor an authenticated session.
      await publicPage.goto(sharedPath); await expect(publicPage.locator('.bag-card')).toContainText('Wallet hidden');
      await expect(publicPage.locator('.bag-card')).not.toContainText(me.account.wallet);
      const response = await guest.request.get(`/v1/bags/${sharedPath.split('/').at(-1)}`), publicReport = await response.json();
      expect(publicReport.wallet).toBeUndefined(); expect(publicReport.summary.valueUsd).toBeUndefined();
      expect(publicReport.holdings.every((row: { valueUsd?: number }) => row.valueUsd === undefined)).toBe(true);
      await audit(publicPage, 'public bag snapshot');
    } finally { await guest.close(); }
  }
});

test('launch: real Connect key, preflight, private journal ownership and deletion', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  for (const viewport of sizes(info)) {
    // New owner for each destruction trial; synthetic signing stays in the test process.
    const owned = await context.browser()!.newContext({ baseURL: origin(), viewport });
    try {
      await configureContext(owned);
      const ownerPage = await owned.newPage(); await signIn(ownerPage);
      await ownerPage.goto('/mission/connect'); await ownerPage.getByRole('radio', { name: /^Claude Code/ }).click();
      await ownerPage.getByLabel('Name', { exact: true }).fill('Sample launch agent');
      await ownerPage.getByRole('button', { name: 'Generate key', exact: true }).click();
      await ownerPage.getByRole('button', { name: 'Reveal', exact: true }).click();
      const key = await ownerPage.locator('[data-one-time-key]').innerText(); expect(key).toMatch(/^eko_/);
      const { agents } = await (await owned.request.get('/v1/agents')).json(), agentId = agents[0].id;
      expect((await (await owned.request.get('/v1/me/journal-consent')).json()).optedIn).toBe(false);
      const request = { agentId, clientOrderRef: 'sample-order-001', order: { venue: 'robinhood', instrument: 'SAMPLE', side: 'buy', notionalUsd: 50, orderType: 'market' } };
      expect((await write(owned.request, '/v1/e2e/preflight', request, 'POST', key)).status()).toBe(403);
      expect((await write(owned.request, '/v1/me/journal-consent', { optedIn: true }, 'PUT')).status()).toBe(200);
      await ownerPage.getByRole('button', { name: 'I’ve stored the key', exact: true }).click();
      await expect(ownerPage.locator('[data-one-time-key]')).toHaveCount(0);
      expect(await ownerPage.evaluate(key => !document.body.innerHTML.includes(key) && !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(key), key)).toBe(true);
      await ownerPage.getByRole('button', { name: 'Test the connection', exact: true }).click();
      await expect(ownerPage.locator('.cn-test')).toContainText('Waiting for your agent’s first call');
      const response = await write(owned.request, '/v1/e2e/preflight', request, 'POST', key);
      expect(response.status()).toBe(200); const result = await response.json(); expect(result.decision).toBe('allow');
      expect(result.preflightId).toBeTruthy(); expect(result.policyVersion).toBe(1);
      expect(await (await write(owned.request, '/v1/e2e/preflight', request, 'POST', key)).json()).toEqual(result);
      const changed = await (await write(owned.request, '/v1/e2e/preflight', { ...request, order: { ...request.order, notionalUsd: 75 } }, 'POST', key)).json();
      expect(changed.decision).toBe('deny');
      const denied = await (await write(owned.request, '/v1/e2e/preflight', { ...request, clientOrderRef: 'sample-order-deny', order: { ...request.order, notionalUsd: 50000 } }, 'POST', key)).json();
      expect(denied.decision).toBe('deny'); expect(denied.reasons.length).toBeGreaterThan(0);
      await expect(ownerPage.locator('.cn-test')).toContainText('First journal event received');
      await ownerPage.getByRole('link', { name: 'Open journal', exact: true }).click();
      await expect(ownerPage.locator('.mc-jr')).toHaveCount(2);
      const journal = await owned.request.get(`/v1/agents/${agentId}/journal`); expect(journal.headers()['cache-control']).toBe('private, no-store');
      const entry = (await journal.json()).rows[0]; expect(entry.share).toBe(false); expect(entry.commitment).toMatch(/^0x[0-9a-f]{64}$/);
      const commitment = await (await owned.request.get(`/v1/receipts/${entry.id}`)).json();
      expect(commitment).toMatchObject({ kind: 'harness_private', status: 'pending' });
      expect(commitment.revealed).toBeUndefined(); expect(commitment.canonicalPayload).toBeUndefined();
      expect(await (await owned.request.get(`/v1/e2e/private-state/${agentId}`)).json()).toEqual({ encryptedRows: 2, containsPlaintext: false });
      const outsider = await context.browser()!.newContext({ baseURL: origin(), viewport });
      try {
        await configureContext(outsider);
        const outsiderPage = await outsider.newPage(); await signIn(outsiderPage);
        expect((await outsider.request.get(`/v1/agents/${agentId}`)).status()).toBe(404);
        expect((await outsider.request.get(`/v1/agents/${agentId}/journal`)).status()).toBe(404);
        expect((await outsider.request.get(`/v1/agents/${agentId}/keys`)).status()).toBe(404);
      } finally { await outsider.close(); }
      await ownerPage.goto('/settings');
      await ownerPage.getByRole('button', { name: 'Delete my harness data', exact: true }).click();
      const form = ownerPage.getByRole('form', { name: 'Delete my harness data' });
      await expect(form.getByRole('button', { name: 'Delete my harness data', exact: true })).toBeDisabled();
      await ownerPage.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE');
      await form.getByRole('button', { name: 'Delete my harness data', exact: true }).click();
      await expect(ownerPage.getByRole('status').filter({ hasText: 'Harness data deleted.' })).toBeVisible();
      expect((await owned.request.get(`/v1/agents/${agentId}/journal`)).status()).toBe(404);
      expect((await (await owned.request.get('/v1/agents')).json()).agents).toEqual([]);
      expect((await write(owned.request, '/v1/e2e/preflight', request, 'POST', key)).status()).toBe(401);
      expect(await (await owned.request.get(`/v1/receipts/${entry.id}`)).json()).toEqual(commitment);
      expect((await owned.request.delete('/v1/me/data', { headers: { Origin: origin() } })).status()).toBe(200);
      await audit(ownerPage, 'deleted Settings');
    } finally { await owned.close(); }
  }
});

test('launch: persisted watch alerts, paper replay and paused guard with zero wallet requests', async ({ page }, info) => {
  const data = await candidate(page.request); await signIn(page);
  for (const viewport of sizes(info)) {
    await page.setViewportSize(viewport); await page.goto('/watch');
    await page.getByLabel('Target', { exact: true }).fill(data.coin);
    await page.getByRole('button', { name: 'Add watch', exact: true }).click();
    await expect(page.locator('.watch-groups')).toContainText(data.coin);
    await page.getByLabel('Minimum verdict level').selectOption('monitor');
    await page.getByRole('button', { name: 'Save notifications', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Notification settings saved.' })).toBeVisible();
    expect((await (await page.request.get('/v1/alerts/settings')).json()).minLevel).toBe('monitor');
    const before = (await (await page.request.get('/v1/alerts')).json()).seq;
    expect((await write(page.request, '/v1/e2e/alert', {})).status()).toBe(200);
    await page.getByRole('button', { name: 'Open alerts', exact: true }).click();
    await expect(page.locator('.watch-alerts')).toContainText('Verdict changed');
    const alerts = await (await page.request.get(`/v1/alerts?after=${before}`)).json();
    expect(alerts.rows).toHaveLength(1); expect(alerts.rows[0]).toMatchObject({ kind: 'verdict_change', coin: data.coin, level: 'monitor' });
    await page.reload(); await page.getByRole('button', { name: 'Open alerts', exact: true }).click();
    await expect(page.locator('.watch-alerts')).toContainText('Verdict changed');
    await expect(page.getByRole('button', { name: 'Close alerts', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Alerts', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Remove coin watch', exact: true }).click();
    await expect(page.locator('.watch-groups')).not.toContainText(data.coin);
    const outcome = await page.evaluate(async ({ coin, width }) => {
      const walletRequests = (window as unknown as { __ekoWalletRequests: { method: string }[] }).__ekoWalletRequests;
      walletRequests.length = 0;
      const me = await (await fetch('/v1/me')).json(), config = await (await fetch('/v1/config')).json();
      const flowPath = '/src/lib/tradeFlow.ts', clientPath = '/src/lib/guardedTradeClient.ts';
      const { GuardedTradeFlow } = await import(flowPath) as typeof import('../src/lib/tradeFlow');
      const { guardedTradeClient } = await import(clientPath) as typeof import('../src/lib/guardedTradeClient');
      const input = { coin, side: 'buy' as const, amountUsd: 50, slippageBps: 50, account: me.account.wallet };
      const quote = await guardedTradeClient.quote(input), requests: string[] = [];
      const flow = new GuardedTradeFlow({ current: () => ({ accountId: me.account.id, verifiedWallet: me.account.wallet, wallet: { address: me.account.wallet, chainId: 4663 }, config }),
        client: guardedTradeClient, now: Date.now, storage: localStorage,
        approve: async () => { requests.push('approve'); throw new Error('Unexpected wallet request'); },
        send: async () => { requests.push('send'); throw new Error('Unexpected wallet request'); },
        onOrder: () => {}, onPhase: () => {}, mismatch: () => {} });
      let code = '';
      try { await flow.execute({ input, quote, acknowledged: [], requestedAt: Date.now() }); } catch (error) { code = (error as { code: string }).code; }
      const orderInput = { mode: 'paper', market: 'ETH-USD', side: 'buy', amountUsd: 50, idempotencyKey: `sample-paper-${width}` };
      const paper = async () => { const response = await fetch('/api/orders/instant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderInput) }); return { status: response.status, body: await response.json() }; };
      return { quote, code, requests, first: await paper(), replay: await paper(), signingRequests: walletRequests.filter(request => /sign|sendTransaction|requestAccounts|requestPermissions|switchEthereumChain/.test(request.method)) };
    }, { coin: data.coin, width: viewport.width });
    expect(outcome.requests).toEqual([]); expect(outcome.code).toBe('trading_paused');
    expect(outcome.signingRequests).toEqual([]);
    expect(outcome.quote.fee).toEqual({ bps: 0, usd: 0, destination: null }); expect(outcome.quote.route.executable).toBe(false);
    expect(outcome.first.status).toBe(201); expect(outcome.first.body.order.mode).toBe('paper');
    expect(outcome.first.body.order.status).toBe('filled'); expect(outcome.replay.status).toBe(200);
    expect(outcome.replay.body.order.id).toBe(outcome.first.body.order.id); expect(outcome.replay.body.duplicate).toBe(true);
    await evidence(page, info, `launch-paper-${viewport.width}`, { status: outcome.first.body.order.status, zeroGuardWalletRequests: outcome.requests, quoteExecutable: false, source: 'Simulated paper market, persisted API order; not guarded fork execution' });
  }
});

test('launch: browser wallet receives the exact ERC20 token, spender and integer amount', async ({ page }, info) => {
  const account = await installMockWallet(page, { key: generatePrivateKey(), chainId: 4663, rejectSend: true });
  await page.goto('/radar'); await connectWallet(page); await verifyWallet(page);
  const token = '0x00000000000000000000000000000000000000aa', spender = '0x00000000000000000000000000000000000000bb';
  for (const viewport of sizes(info)) {
    await page.setViewportSize(viewport);
    const result = await page.evaluate(async ({ token, spender, account }) => {
      const requests = (window as unknown as { __ekoWalletRequests: { method: string; params: { to: string; from: string; data: `0x${string}` }[] }[] }).__ekoWalletRequests;
      requests.length = 0;
      const path = '/src/lib/trade.ts';
      const { approveExactToken, isUserRejection } = await import(path) as typeof import('../src/lib/trade');
      let rejected = false;
      try { await approveExactToken({ token, spender, amount: '900719925474099312345' }, 4663, account); }
      catch (error) { rejected = isUserRejection(error); }
      return { rejected, sends: requests.filter(request => request.method === 'eth_sendTransaction') };
    }, { token, spender, account: account.address });
    expect(result.rejected).toBe(true); expect(result.sends).toHaveLength(1);
    const tx = result.sends[0]!.params[0]!;
    expect(tx.to.toLowerCase()).toBe(token); expect(tx.from.toLowerCase()).toBe(account.address.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe('approve'); expect(decoded.args).toEqual([spender, 900719925474099312345n]);
    await evidence(page, info, `launch-exact-approval-${viewport.width}`, { token, spender, amount: '900719925474099312345', requests: 1, rejected: true, broadcast: false });
  }
});

test('launch: real pending receipt and browser verifier rejects tampered payload and proof', async ({ page }, info) => {
  const data = await candidate(page.request);
  for (const viewport of sizes(info)) {
    await page.setViewportSize(viewport); await page.goto(`/receipt/${data.receiptId}`);
    await expect(page.locator('.receipt-panel')).toContainText('Pending');
    await expect(page.getByRole('button', { name: 'Verify', exact: true })).toBeDisabled();
    const response = await page.request.get(`/v1/receipts/${data.receiptId}`); expect(response.headers()['cache-control']).toBe('no-store');
    const persisted = await response.json(); expect(persisted.status).toBe('pending');
    const result = await page.evaluate(async (serialized: string) => {
      const { persisted, payload, canonicalPayload } = JSON.parse(serialized);
      const path = '/src/lib/receipt-verifier.ts';
      const { verifyReceipt, receiptVerifier } = await import(path) as typeof import('../src/lib/receipt-verifier');
      const root = receiptVerifier.buildReceiptTree([persisted]).root;
      const registry = '0x00000000000000000000000000000000000000bb' as const;
      const anchored = { ...persisted, status: 'anchored', chainId: 4663, registry, batchId: 1, merkleRoot: root, proof: [], block: 100,
        blockHash: `0x${'ac'.repeat(32)}`, txHash: `0x${'ad'.repeat(32)}`, logIndex: 0, revealed: payload,
        canonicalPayload };
      let reads = 0;
      const reader = { getChainId: async () => { reads++; throw new Error('No chain access'); }, getBlock: async () => { reads++; throw new Error('No chain access'); },
        getTransactionReceipt: async () => { reads++; throw new Error('No chain access'); }, readContract: async () => { reads++; throw new Error('No chain access'); } };
      const pending = await verifyReceipt(persisted, null, reader);
      const changedPayload = await verifyReceipt({ ...anchored, revealed: { ...payload, decision: { probability: 0.99 } } }, registry, reader);
      const changedProof = await verifyReceipt({ ...anchored, proof: [`0x${'be'.repeat(32)}`] }, registry, reader);
      const noRegistry = await verifyReceipt(anchored, null, reader);
      return { pending, changedPayload, changedProof, noRegistry, reads };
    }, JSON.stringify({ persisted, payload: data.payload, canonicalPayload: canonicalize(data.payload) }));
    expect(result.pending.status).toBe('pending'); expect(result.changedPayload.status).toBe('failed');
    expect(result.changedPayload.steps[0].message).toMatch(/payload.*hash/);
    expect(result.changedProof.status).toBe('failed'); expect(result.changedProof.steps[1].message).toMatch(/proof/);
    expect(result.noRegistry.status).toBe('failed'); expect(result.noRegistry.steps[2].message).toMatch(/published registry/);
    expect(result.reads).toBe(0);
    await evidence(page, info, `launch-receipt-${viewport.width}`, { result, provenance: 'Persisted pending HTTP receipt; synthetic anchor only for browser tamper rejection. On-chain verification pending.' });
  }
});


test('launch: layout and navigation keyboard regression', async ({ page }, info) => {
  await signIn(page);
  const agentResponse = await write(page.request, '/v1/agents', { name: 'Sample launch agent', kind: 'robinhood_mcp', preset: 'balanced' });
  expect(agentResponse.status()).toBe(201);
  for (const viewport of sizes(info)) {
    await page.setViewportSize(viewport);
    for (const path of ['/radar', '/mission']) {
      await page.goto(path);
      await expect(page.locator(path === '/radar' ? 'tr[data-address]' : '.arow').first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 12).map(el => ({ tag: el.tagName, class: el.getAttribute('class'), right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth })) }));
      expect(layout.document, JSON.stringify({ viewport, path, ...layout })).toBeLessThanOrEqual(viewport.width);
    }
    for (const path of ['/radar', '/scan']) {
      await page.goto(path);
      await expect(page.locator('#main h1')).toBeVisible();
      const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
      await page.keyboard.press('Tab'); await expect(skip).toBeFocused();
      await page.keyboard.press('Enter'); await expect(page.locator('#main')).toBeFocused();
      if (path === '/radar') {
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await page.keyboard.press('Tab'); await expect(skip).toBeFocused();
        await page.keyboard.press('Enter'); await expect(page.locator('#main')).toBeFocused();
      }
      await expect(page.locator('#main')).toHaveAttribute('tabindex', '-1');
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
    await page.getByRole('link', { name: 'Open Radar', exact: true }).first().click();
    await expect(page.locator('tr[data-address]').first()).toBeVisible();
    await expect(page.locator('#main')).toBeFocused();
    // Activation still moves focus correctly after an SPA arrival.
    await page.getByRole('link', { name: 'Skip to content', exact: true }).focus();
    await page.keyboard.press('Enter'); await expect(page.locator('#main')).toBeFocused();
  }
});
