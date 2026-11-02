import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // This repo has no GitHub Actions workflow, so verify:local runs this suite on the
    // developer machine, where another project can saturate the box. The old
    // `CI ? 20 s : 5 s` split never took the CI branch here; match the apps/cli budget.
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
});
