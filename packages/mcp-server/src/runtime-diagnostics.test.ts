import { describe, expect, it } from 'vitest';
import type { IncrementalVerifierCacheStats } from './incremental-verifier.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { createMcpRuntimeDiagnosticsProvider } from './runtime-diagnostics.js';

class FixedIncrementalVerifier extends IncrementalVerifier {
  public override stats(): IncrementalVerifierCacheStats {
    return { entries: 7, hits: 3, misses: 2, hitRate: 0.6, bytesSaved: 1024 };
  }
}

describe('MCP runtime diagnostics provider', () => {
  it('reads the process-owned incremental verifier instead of a fresh cache', async () => {
    const provider = createMcpRuntimeDiagnosticsProvider({
      services: {},
      actor: { clientId: 'diagnostics-provider-test', clientName: 'diagnostics-provider-test' },
      incrementalVerifier: new FixedIncrementalVerifier(),
    });

    const diagnostics = await provider();
    expect(diagnostics.runtimeRetention.incrementalVerificationEntries).toBe(7);
  });
});
