import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // .unified-mpc/worktrees holds goal worktrees with their own checked-out copies of this
    // package; without the exclude vitest collects those duplicates and runs every test twice.
    exclude: ['**/node_modules/**', '**/dist/**', '../../.unified-mpc/**'],
  },
});