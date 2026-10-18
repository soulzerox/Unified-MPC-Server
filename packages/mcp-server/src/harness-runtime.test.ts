import { describe, expect, it } from 'vitest';
import type { MandatoryMcpBootstrapResult } from '@unified-mpc/extensions';
import { HarnessActivationLedger } from './harness-runtime.js';

const mandatoryMcp = { ready: true, servers: [] } as unknown as MandatoryMcpBootstrapResult;

describe('HarnessActivationLedger lifecycle', () => {
  it('invalidates every workspace state owned by one transport session only', () => {
    const ledger = new HarnessActivationLedger();
    const first = { sessionId: 'session-1', workspaceId: 'workspace-1' } as const;
    const second = { sessionId: 'session-1', workspaceId: 'workspace-2' } as const;
    const other = { sessionId: 'session-2', workspaceId: 'workspace-1' } as const;
    ledger.markBootstrapped(first, 'hash-a', mandatoryMcp);
    ledger.markBootstrapped(second, 'hash-b', mandatoryMcp);
    ledger.markBootstrapped(other, 'hash-c', mandatoryMcp);

    ledger.invalidateSession('session-1');

    expect(ledger.state(first)).toBeUndefined();
    expect(ledger.state(second)).toBeUndefined();
    expect(ledger.state(other)).toBeDefined();
  });
});

const sourceIdentity = {
  repositoryIdentity: 'repo-1',
  gitCommonDirIdentity: 'common-1',
  worktreeIdentity: 'worktree-1',
  workspaceHead: 'a'.repeat(40),
  dirtyFingerprint: 'dirty-1',
  stagedFingerprint: 'staged-1',
};

const receipt = {
  path: 'src/a.ts',
  workspaceId: 'workspace-1',
  targetContentHash: 'c'.repeat(64),
  sourceIdentity,
  evidenceProviderId: 'thai-rag',
  evidenceIndexGeneration: 1,
  evidenceState: 'evidence_available',
  checks: ['thai-rag/pre_edit_context'],
  preparedAt: '2026-10-18T00:00:00.000Z',
};

describe('HarnessActivationLedger preparation receipts', () => {
  it('keeps the exact inputs of a prepared path until the mutation consumes it', () => {
    const ledger = new HarnessActivationLedger();
    const context = { sessionId: 'session-1', workspaceId: 'workspace-1' } as const;
    ledger.markBootstrapped(context, 'hash-a', mandatoryMcp, sourceIdentity);
    ledger.preparePath(context, 'src/a.ts', receipt);

    expect(ledger.preparation(context, 'src/a.ts')).toEqual(receipt);

    ledger.consumePath(context, 'src/a.ts');

    expect(ledger.preparation(context, 'src/a.ts')).toBeUndefined();
  });

  it('drops receipts when the admitted source view changes', () => {
    const ledger = new HarnessActivationLedger();
    const context = { sessionId: 'session-1', workspaceId: 'workspace-1' } as const;
    ledger.markBootstrapped(context, 'hash-a', mandatoryMcp, sourceIdentity);
    ledger.preparePath(context, 'src/a.ts', receipt);

    const changed = ledger.synchronizeSource(context, { ...sourceIdentity, workspaceHead: 'b'.repeat(40) });

    expect(changed).toBe(true);
    expect(ledger.preparation(context, 'src/a.ts')).toBeUndefined();
    expect(ledger.isPathPrepared(context, 'src/a.ts')).toBe(false);
  });

  it('drops receipts when the harness is invalidated', () => {
    const ledger = new HarnessActivationLedger();
    const context = { sessionId: 'session-1', workspaceId: 'workspace-1' } as const;
    ledger.markBootstrapped(context, 'hash-a', mandatoryMcp, sourceIdentity);
    ledger.preparePath(context, 'src/a.ts', receipt);

    ledger.invalidate(context);

    expect(ledger.preparation(context, 'src/a.ts')).toBeUndefined();
  });
});
