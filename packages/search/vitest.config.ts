import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The heap-retention stress test measures `process.memoryUsage().heapUsed`,
    // which includes garbage V8 has not collected yet. Without a forced
    // collection the assertion measures GC timing, not retention, and it failed
    // intermittently inside `verify:local` while passing standalone. Exposing
    // `gc()` to the worker makes the measurement mean "heap still held after a
    // collection", which is what the test claims to assert.
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
  },
});
