import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const temporary = fileURLToPath(new URL('./e2e/.artifacts/tmp', import.meta.url));
mkdirSync(temporary, { recursive: true });
process.env.TMPDIR = temporary;

const PERFORMANCE = process.env.EKO_PERFORMANCE === '1';
const API_PORT = Number(process.env.E2E_API_PORT ?? 8720);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5190);

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: PERFORMANCE ? 180_000 : 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.artifacts/report' }]],
  outputDir: 'e2e/.artifacts/results',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    launchOptions: { args: ['--disable-notifications', '--disable-domain-reliability', '--disable-features=PushMessaging'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Uses the locally installed Google Chrome (no browser download). Override with PW_CHANNEL.
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'chrome', viewport: { width: 1440, height: 900 } }, testIgnore: /mobile|fork|screenshots/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL ?? 'chrome' }, testMatch: /(?:mobile|launch-gate)\.spec\.ts/ },
    { name: 'shots-desktop', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'chrome', viewport: { width: 1487, height: 1058 }, deviceScaleFactor: 2 }, testMatch: /screenshots\.spec\.ts/ },
    { name: 'shots-mobile', use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL ?? 'chrome', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 }, testMatch: /screenshots\.spec\.ts/ },
    { name: 'live-fork', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'chrome', viewport: { width: 1440, height: 900 } }, testMatch: /live\.fork\.spec\.ts/ },
  ],
  webServer: [
    {
      // Packet 023b's indexed-read suite needs its seeded local database; retain the full API.
      command: PERFORMANCE ? 'node apps/web/e2e/performance-fixture.mjs' : `pnpm --filter @eko/server exec tsx test/read-e2e-server.ts`,
      cwd: '../..',
      port: API_PORT,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        E2E_API_PORT: String(API_PORT),
        PORT: String(API_PORT),
        PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
        MARKET_DATA_SOURCE: 'onchain',
        RUN_WORKER: 'false',
        ENABLE_DEV_ROUTES: 'true',
        PGLITE_DIR: ':memory:',
        SESSION_SECRET: 'e2e'.repeat(12),
        RH_TESTNET_RPC_URL: 'http://127.0.0.1:9',
        RH_MAINNET_RPC_URL: process.env.E2E_MAINNET_RPC ?? 'http://127.0.0.1:9',
        LIVE_TRADING_ENABLED: process.env.E2E_LIVE ?? 'false',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: PERFORMANCE ? `pnpm exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort` : `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      timeout: PERFORMANCE ? 180_000 : 60_000,
      reuseExistingServer: false,
      // Packet 108: exercise the Scan fallback at / without reading the owner's separate site project.
      env: { EKO_API: `http://localhost:${API_PORT}`, WEB_PORT: String(WEB_PORT), EKO_SITE: fileURLToPath(new URL('./e2e/.artifacts/site-unavailable', import.meta.url)) },
    },
  ],
});
