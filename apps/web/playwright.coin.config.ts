import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'coin.spec.ts', timeout: 60_000, workers: 1, retries: 0,
  outputDir: 'e2e/.artifacts/coin', reporter: 'list',
  use: { baseURL: 'http://localhost:5199', channel: process.env.PW_CHANNEL ?? 'chrome', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: '1512x982', use: { viewport: { width: 1512, height: 982 } } },
    { name: '1440x900', use: { viewport: { width: 1440, height: 900 } } },
    { name: '1280x800', use: { viewport: { width: 1280, height: 800 } } },
    { name: '390x844', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'pnpm exec vite --port 5199 --strictPort', port: 5199, reuseExistingServer: false, env: { VITE_MOCKS: '1', VITE_FLAGS: 'deep_research', pnpm_config_verify_deps_before_run: 'false' } },
});
