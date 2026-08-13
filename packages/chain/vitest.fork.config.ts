import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/fork/**/*.fork.test.ts'], testTimeout: 180_000, hookTimeout: 30_000, fileParallelism: false },
});
