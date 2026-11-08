import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // This repo has no GitHub Actions workflow, so verify:local runs this suite on the
    // developer machine, where another project can saturate the box. These tests start
    // real server/client pairs, including stdio child processes: the 5 s default timed
    // out inside verify:local while the same test finished in ~1.5 s standalone.
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
});
