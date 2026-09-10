import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    // Fake timers are used heavily (debounce, retention sweeps, coalescing
    // windows). Keep them opt-in per suite rather than global.
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/**/types.ts', 'src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
