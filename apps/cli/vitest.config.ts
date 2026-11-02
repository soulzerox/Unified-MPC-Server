import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // This repo has no GitHub Actions workflow, so the merge gate runs locally and the
    // budget has to hold on a loaded developer machine. These tests spawn git and open
    // SQLite; the 5 s default failed once when a 4-core box was saturated by another suite.
    testTimeout: 20_000,
    hookTimeout: 10_000,
    // .unified-mpc/worktrees holds goal worktrees with their own checked-out copies of this
    // package; without the exclude vitest collects those duplicates and runs every test twice.
    exclude: ['**/node_modules/**', '**/dist/**', '../../.unified-mpc/**'],
  },
});