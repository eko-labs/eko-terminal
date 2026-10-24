import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'radar.spec.ts', workers: 1, retries: 0,
  reporter: 'list', outputDir: 'e2e/.artifacts/radar',
  use: { baseURL: 'http://127.0.0.1:5196', channel: 'chrome', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm exec vite --host 127.0.0.1 --port 5196 --strictPort', port: 5196, reuseExistingServer: false, env: { VITE_MOCKS: '1', pnpm_config_verify_deps_before_run: 'false' } },
});
