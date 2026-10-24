import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/pages/trust/layout.check.tsx'], environment: 'node' } });
