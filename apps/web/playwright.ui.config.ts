import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'ui.spec.ts', workers: 1, retries: 0,
  reporter: 'list', outputDir: 'e2e/.artifacts/ui',
  use: { baseURL: 'http://127.0.0.1:5195', channel: 'chrome', trace: 'retain-on-failure' },
  projects: [
    { name: 'ui-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'ui-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: { command: 'pnpm exec vite --host 127.0.0.1 --port 5195 --strictPort', port: 5195, reuseExistingServer: false },
});
