import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // packages/core is pure and has no I/O, so the default node environment
    // and no setup file is all it needs. Integration suites that require a
    // database opt in explicitly via their own config.
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
  },
});
