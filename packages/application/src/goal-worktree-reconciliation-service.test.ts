import { describe, expect, it } from 'vitest';
import {
  GoalWorktreeReconciliationService,
  type GoalWorktreeDescriptor,
  type GoalWorktreeGitPort,
  type GoalWorktreeStatusProbe,
} from './goal-worktree-reconciliation-service.js';

function ledgerEntry(overrides: Partial<GoalWorktreeDescriptor> = {}): GoalWorktreeDescriptor {
  return {
    worktreePath: '/somewhere/.worktrees/agent-abc123',
    ref: 'main',
    owner: 'client-a',
    ownerSessionId: 'session-1',
    ...overrides,
  };
}

interface PortOverrides {
  readonly exists?: boolean;
  readonly probe?: GoalWorktreeStatusProbe;
  readonly headSha?: string | null;
  readonly ancestry?: 'yes' | 'no' | 'unknown';
  readonly failStatusProbe?: Error;
  readonly failExistsProbe?: Error;
}

function gitPort(overrides: PortOverrides = {}): GoalWorktreeGitPort {
  const calls = { status: 0, ancestry: 0 };
  return {
    exists: async (worktreePath: string): Promise<boolean> => {
      if (overrides.failExistsProbe !== undefined) throw overrides.failExistsProbe;
      if (worktreePath === '/missing') return overrides.exists ?? false;
      return overrides.exists ?? true;
    },
    status: async (): Promise<GoalWorktreeStatusProbe> => {
      calls.status += 1;
      if (overrides.failStatusProbe !== undefined) throw overrides.failStatusProbe;
      return overrides.probe ?? { dirtyEntries: 0, unmergedEntries: 0 };
    },
    headSha: async (): Promise<string | null> => (overrides.headSha === undefined ? 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' : overrides.headSha),
    isAncestor: async (): Promise<'yes' | 'no' | 'unknown'> => {
      calls.ancestry += 1;
      return overrides.ancestry ?? 'yes';
    },
  };
}

function actor(): { readonly clientId: string; readonly sessionId?: string } {
  return { clientId: 'client-a', sessionId: 'session-1' };
}

async function classifyOne(entry: GoalWorktreeDescriptor, port: GoalWorktreeGitPort, leasePaths: ReadonlySet<string> = new Set<string>()): Promise<ReturnType<GoalWorktreeReconciliationService['classify']>> {
  const service = new GoalWorktreeReconciliationService({ git: port });
  return service.classify([entry], { actor: actor(), activeLeaseWorktreePaths: leasePaths });
}

describe('GoalWorktreeReconciliationService classification', () => {
  it('marks a clean, integrated, leased-free, self-owned worktree safe_to_clean', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ ancestry: 'yes' }));
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.disposition).toBe('safe_to_clean');
    expect(report.entries[0]?.blockers).toEqual([]);
    expect(report.integrationBase).toBe('origin/main');
    expect(report.safeToCleanCount).toBe(1);
    expect(report.keepCount).toBe(0);
  });

  it('keeps a worktree with uncommitted changes and reports the dirty blocker', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ probe: { dirtyEntries: 2, unmergedEntries: 0 } }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['dirty']);
    expect(report.keepCount).toBe(1);
  });

  it('keeps a worktree whose index holds unresolved merge entries', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ probe: { dirtyEntries: 0, unmergedEntries: 1 } }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['unmerged_changes']);
  });

  it('keeps a worktree whose HEAD diverged from the integration base (never merged, including squash merges)', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ ancestry: 'no' }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['unintegrated_head']);
  });

  it('keeps and reports probe failure when merge ancestry cannot be proven', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ ancestry: 'unknown' }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['probe_failed']);
  });

  it('keeps a worktree whose HEAD sha cannot be resolved', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ headSha: null }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['probe_failed']);
  });

  it('keeps a worktree under an active goal lease without running integration probes', async () => {
    const entry = ledgerEntry();
    const report = await classifyOne(entry, gitPort(), new Set([entry.worktreePath]));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['active_lease']);
  });

  it('keeps a worktree owned by another client', async () => {
    const report = await classifyOne(ledgerEntry({ owner: 'client-b' }), gitPort());
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['externally_owned']);
  });

  it('keeps a worktree pinned to another client session even under the same client', async () => {
    const report = await classifyOne(ledgerEntry({ ownerSessionId: 'session-42' }), gitPort());
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['externally_owned']);
  });

  it('keeps a worktree whose filesystem path vanished and skips content probes', async () => {
    const port = gitPort({ exists: false });
    const report = await classifyOne(ledgerEntry({ worktreePath: '/missing' }), port);
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['path_missing']);
  });

  it('keeps and reports probe failure when the status probe itself throws', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ failStatusProbe: new Error('git status died') }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['probe_failed']);
    expect(report.entries[0]?.blockerDetails.join(' ')).toContain('git status died');
  });

  it('keeps and reports probe failure when the existence probe throws', async () => {
    const report = await classifyOne(ledgerEntry(), gitPort({ failExistsProbe: new Error('lstat exploded') }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['probe_failed']);
  });

  it('combines every independent blocker for one entry in a stable order', async () => {
    const report = await classifyOne(ledgerEntry({ owner: 'client-b' }), gitPort({ probe: { dirtyEntries: 1, unmergedEntries: 2 } }));
    expect(report.entries[0]?.disposition).toBe('keep');
    expect(report.entries[0]?.blockers).toEqual(['externally_owned', 'dirty', 'unmerged_changes']);
  });

  it('classifies a mixed ledger and summarises counts', async () => {
    const clean = ledgerEntry({ worktreePath: '/somewhere/.worktrees/clean' });
    const dirty = ledgerEntry({ worktreePath: '/somewhere/.worktrees/dirty' });
    const service = new GoalWorktreeReconciliationService({
      git: {
        exists: async (worktreePath: string): Promise<boolean> => worktreePath !== '/missing',
        status: async (worktreePath: string): Promise<GoalWorktreeStatusProbe> => worktreePath.endsWith('dirty')
          ? { dirtyEntries: 1, unmergedEntries: 0 }
          : { dirtyEntries: 0, unmergedEntries: 0 },
        headSha: async (): Promise<string | null> => 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        isAncestor: async (): Promise<'yes' | 'no' | 'unknown'> => 'yes',
      },
    });
    const report = await service.classify([clean, dirty], { actor: actor() });
    expect(report.safeToCleanCount).toBe(1);
    expect(report.keepCount).toBe(1);
    expect(report.entries.map((row) => row.worktreePath)).toEqual([clean.worktreePath, dirty.worktreePath]);
    expect(report.entries[1]?.blockers).toEqual(['dirty']);
  });
});
