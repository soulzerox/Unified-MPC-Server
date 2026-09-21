import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IncrementalVerifierCacheStats } from './incremental-verifier.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { createMcpRuntimeDiagnosticsProvider } from './runtime-diagnostics.js';
import { UpgradeRuntimeStateStore } from './upgrade-runtime-state-store.js';

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
    expect(diagnostics.runtimeRetention).toMatchObject({
      tasks: null,
      checkpoints: null,
      hooks: null,
      plugins: null,
      sessionEntries: null,
      worktrees: null,
      activityInflight: null,
      activityCompletedEntries: null,
      activityCompletedEntryLimit: null,
      incrementalVerificationEntries: 7,
      contextLedgerEntries: null,
      toolAvailabilitySubscriptions: null,
    });
  });

  it('hydrates process-shared plugin and worktree retention without exposing another session as zero', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-diagnostics-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    try {
      const store = new UpgradeRuntimeStateStore(runtimeStatePath, 'seed');
      await store.updateShared(() => ({
        plugins: [{ name: 'fixture-plugin', enabled: true, source: 'fixture', version: '1.0.0' }],
        worktrees: [{
          workspaceId: 'workspace-1',
          worktreePath: '/tmp/worktree-1',
          ref: 'HEAD',
          owner: 'fixture-owner',
          createdAt: '2026-09-22T00:00:00.000Z',
        }],
      }));

      const provider = createMcpRuntimeDiagnosticsProvider({
        services: { runtimeStatePath },
        actor: { clientId: 'diagnostics-provider-test', clientName: 'diagnostics-provider-test' },
      });

      const diagnostics = await provider();
      expect(diagnostics.runtimeRetention).toMatchObject({
        tasks: null,
        checkpoints: null,
        hooks: null,
        plugins: 1,
        sessionEntries: null,
        worktrees: 1,
        contextLedgerEntries: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports shared retention unavailable when the persisted store cannot be read', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-diagnostics-unreadable-'));
    try {
      const blockedParent = path.join(directory, 'not-a-directory');
      await writeFile(blockedParent, 'blocked');
      const provider = createMcpRuntimeDiagnosticsProvider({
        services: { runtimeStatePath: path.join(blockedParent, 'upgrade-runtime.json') },
        actor: { clientId: 'diagnostics-provider-test', clientName: 'diagnostics-provider-test' },
      });

      const diagnostics = await provider();
      expect(diagnostics.runtimeRetention.plugins).toBeNull();
      expect(diagnostics.runtimeRetention.worktrees).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
