import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Threads die with their process; forks outlive a dead parent (VW-744).
    pool: 'threads',
    maxWorkers: process.env.CI ? 2 : 4,
  },
});
