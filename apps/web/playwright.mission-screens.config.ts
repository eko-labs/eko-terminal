import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'mission-screens.spec.ts', workers: 1, retries: 0,
  reporter: 'list', outputDir: 'e2e/.artifacts/mission-screens',
  use: { baseURL: 'http://127.0.0.1:5191', channel: 'chrome', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm exec vite --host 127.0.0.1 --port 5191 --strictPort', port: 5191, reuseExistingServer: false, env: { VITE_MOCKS: '1', VITE_FLAGS: 'd0', pnpm_config_verify_deps_before_run: 'false' } },
});
