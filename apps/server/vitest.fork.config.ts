import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/fork/**/*.fork.test.ts'], testTimeout: 90_000, hookTimeout: 150_000, pool: 'forks', fileParallelism: false },
});
