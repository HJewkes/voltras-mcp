import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.js'],
    // Threads die with their process; forks outlive a dead parent (VW-744).
    pool: 'threads',
    maxWorkers: process.env.CI ? 2 : 4,
  },
});
