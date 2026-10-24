import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey } from 'viem/accounts';
import { boot } from './helpers';
import { installMockWallet } from './mockWallet';

/** Retained live flow runs in the browser while the terminal controls are being replaced. */
const RPC = process.env.E2E_MAINNET_RPC ?? '';
test.skip(!RPC || process.env.E2E_LIVE !== 'true', 'requires an Anvil mainnet fork (pnpm e2e:fork)');
test.setTimeout(150_000);

async function fund(address: string) {
  const response = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [address, '0x4563918244F40000'] }),
  });
  expect((await response.json()).error).toBeUndefined();
}

async function connect(page: Page) {
  await boot(page);
  await page.evaluate(() => (window as unknown as { __eko: { getState(): { setMode(m: string): void } } }).__eko.getState().setMode('live'));
  await page.getByTestId('wallet-button').click();
  await page.getByRole('menuitem', { name: /Test Wallet/ }).click();
  await page.getByRole('menuitem', { name: /Verify wallet/ }).click();
  await expect(page.getByRole('menuitem', { name: /Verify wallet/ })).toHaveCount(0);
}

async function sell(page: Page, address: string) {
  return page.evaluate(async (address) => {
    const flowPath = '/src/lib/instantFlow.ts';
    const tradePath = '/src/lib/trade.ts';
    const apiPath = '/src/lib/api.ts';
    const { runLive } = await import(flowPath) as typeof import('../src/lib/instantFlow');
    const { ensureChain, siweSignIn, approveToken, signAndSubmit, newIdempotencyKey } = await import(tradePath) as typeof import('../src/lib/trade');
    const { api } = await import(apiPath) as typeof import('../src/lib/api');
    const config = await api<import('../src/store/app').ServerConfig>('/api/config');
    const { tickers } = await api<{ tickers: import('@eko/shared').Ticker[] }>('/api/tickers');
    const ticker = tickers.find((t) => t.market === 'ETH-USD');
    const phases: string[] = [];
    const result = await runLive({ market: 'ETH-USD', side: 'sell', usd: 50 }, newIdempotencyKey(), {
      mode: 'live', route: config.markets.find((m) => m.id === 'ETH-USD')!.routes.live,
      liveEnabled: config.liveTradingEnabled, wallet: { address, chainId: 4663 }, verifiedWallet: address.toLowerCase(),
      bid: ticker?.bid ?? ticker?.price ?? null, slippageBps: 50, confirmLargeTradeUsd: 1000,
      api, ensureChain, signIn: async (id) => { await siweSignIn(id); }, approve: approveToken, signAndSubmit,
      settled: async (id) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          const { orders } = await api<{ orders: import('@eko/shared').Order[] }>('/api/orders?mode=live');
          const order = orders.find((o) => o.id === id);
          if (order && ['confirmed', 'failed', 'rejected', 'expired', 'cancelled'].includes(order.status)) return order;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error('Order did not settle within 120 seconds');
      },
      onPhase: (phase) => { phases.push(phase); }, onOrder: () => undefined,
    });
    return { result, phases };
  }, address);
}

test('LIVE (fork): the retained flow signs, submits and confirms an on-chain sell', async ({ page }) => {
  const account = await installMockWallet(page, { key: generatePrivateKey(), chainId: 4663, rpcUrl: RPC });
  await fund(account.address);
  await connect(page);
  const { result, phases } = await sell(page, account.address);
  expect(result).toMatchObject({ ok: true, order: { status: 'confirmed', side: 'sell', network: 'robinhood-mainnet', venue: 'uniswap-v3' } });
  expect(result.ok && result.order.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(phases).toEqual(expect.arrayContaining(['quoting', 'signing', 'submitted']));
  expect((await (await page.request.get('/api/orders?mode=paper')).json()).orders).toHaveLength(0);
});

test('LIVE (fork): wallet rejection leaves no submitted trade and is recorded', async ({ page }) => {
  const account = await installMockWallet(page, { key: generatePrivateKey(), chainId: 4663, rpcUrl: RPC, rejectSend: true });
  await fund(account.address);
  await connect(page);
  const { result, phases } = await sell(page, account.address);
  expect(result).toMatchObject({ ok: false, code: 'user_rejected', message: 'Cancelled in your wallet — nothing was sent' });
  expect(phases).not.toContain('submitted');
  const orders = (await (await page.request.get('/api/orders?mode=live')).json()).orders;
  expect(orders[0]).toMatchObject({ status: 'rejected', errorCode: 'user_rejected' });
});
