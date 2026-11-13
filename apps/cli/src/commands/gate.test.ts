import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CloseGateInput,
  CloseGateRemovalPreview,
  CloseGateVerdict,
} from './gate.js';
import {
  closeGateExitCode,
  evaluateCloseGate,
  formatCloseGateVerdict,
  readCloseGateReceipt,
  writeCloseGateReceipt,
} from './gate.js';
import type { WorkspaceLifecycleCleanupEvaluation } from '@unified-mpc/workspace';

const WORKSPACE = 'ws_0123456789abcdef0123456789abcdef';
const GOAL = 'goal_0123456789abcdef0123456789abcdef';
const WORKTREE = '.unified-mpc/worktrees/goal-0123';

function cleanup(
  overrides: Partial<WorkspaceLifecycleCleanupEvaluation> = {},
): WorkspaceLifecycleCleanupEvaluation {
  return {
    workspaceId: WORKSPACE,
    goalId: GOAL,
    disposition: 'retention_candidate',
    blockers: [],
    workspaceAvailable: true,
    writerLeaseActive: false,
    durableReferenceState: 'clear',
    ...overrides,
  };
}

function removal(overrides: Partial<CloseGateRemovalPreview> = {}): CloseGateRemovalPreview {
  return { worktreePath: WORKTREE, status: 'clean', blockers: [], blockerDetails: [], ...overrides };
}

function input(overrides: Partial<CloseGateInput> = {}): CloseGateInput {
  return {
    workspaceId: WORKSPACE,
    goalId: GOAL,
    cleanup: [cleanup()],
    removals: [removal()],
    completion: [],
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('evaluateCloseGate', () => {
  it('allows a goal whose cleanup is a candidate, whose worktree is clean and whose completion is clear', () => {
    const verdict = evaluateCloseGate(input());
    expect(verdict.allowed).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.phase).toBe('close');
    expect(verdict.goalId).toBe(GOAL);
    expect(verdict.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(closeGateExitCode(verdict)).toBe(0);
  });

  it('refuses a workspace that is still waiting out its retention window', () => {
    const verdict = evaluateCloseGate(input({ cleanup: [cleanup({ disposition: 'retention_pending' })] }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockers).toEqual([{
      kind: 'cleanup',
      workspaceId: WORKSPACE,
      disposition: 'retention_pending',
      reasons: [],
    }]);
    expect(closeGateExitCode(verdict)).toBe(1);
  });

  it('carries the cleanup reasons of a blocked workspace', () => {
    const verdict = evaluateCloseGate(input({
      cleanup: [cleanup({ disposition: 'blocked', blockers: ['goal_workspace_not_clean', 'active_writer_lease'] })],
    }));
    expect(verdict.blockers).toEqual([{
      kind: 'cleanup',
      workspaceId: WORKSPACE,
      disposition: 'blocked',
      reasons: ['goal_workspace_not_clean', 'active_writer_lease'],
    }]);
  });

  it('ignores cleanup rows that belong to another goal or workspace', () => {
    const verdict = evaluateCloseGate(input({
      cleanup: [cleanup({ goalId: 'goal_other', disposition: 'blocked' })],
    }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockers).toEqual([{ kind: 'cleanup_unclassified', workspaceId: WORKSPACE }]);
  });

  it('refuses a worktree whose removal preview is blocked or unavailable', () => {
    const blocked = evaluateCloseGate(input({
      removals: [removal({ status: 'blocked', blockers: ['unmerged_changes'] })],
    }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockers).toEqual([{
      kind: 'removal',
      worktreePath: WORKTREE,
      status: 'blocked',
      blockers: ['unmerged_changes'],
    }]);

    const unavailable = evaluateCloseGate(input({ removals: [removal({ status: 'unavailable' })] }));
    expect(unavailable.allowed).toBe(false);
    expect(unavailable.blockers).toMatchObject([{ kind: 'removal', status: 'unavailable' }]);
  });

  it('refuses a worktree that still holds work, even with no blocker names left', () => {
    const verdict = evaluateCloseGate(input({
      completion: [{ worktreePath: WORKTREE, blockers: ['unmerged_changes'] }],
    }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockers).toEqual([{
      kind: 'completion',
      worktreePath: WORKTREE,
      blockers: ['unmerged_changes'],
    }]);
  });

  it('reports every blocker instead of the first one', () => {
    const verdict = evaluateCloseGate(input({
      cleanup: [cleanup({ disposition: 'blocked', blockers: ['goal_workspace_not_clean'] })],
      removals: [removal({ status: 'blocked', blockers: ['dirty'] }), removal({ worktreePath: 'other' })],
      completion: [{ worktreePath: WORKTREE, blockers: ['dirty'] }],
    }));
    expect(verdict.blockers.map((blocker) => blocker.kind)).toEqual(['cleanup', 'removal', 'completion']);
  });
});

describe('close gate fingerprint', () => {
  it('does not depend on input order', () => {
    const forward = evaluateCloseGate(input({
      cleanup: [cleanup(), cleanup({ goalId: 'goal_other' })],
      removals: [removal(), removal({ worktreePath: 'z' })],
      completion: [
        { worktreePath: 'a', blockers: ['dirty', 'unmerged_changes'] },
        { worktreePath: 'b', blockers: ['probe_failed'] },
      ],
    }));
    const reversed = evaluateCloseGate(input({
      cleanup: [cleanup({ goalId: 'goal_other' }), cleanup()],
      removals: [removal({ worktreePath: 'z' }), removal()],
      completion: [
        { worktreePath: 'b', blockers: ['probe_failed'] },
        { worktreePath: 'a', blockers: ['unmerged_changes', 'dirty'] },
      ],
    }));
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it('changes when a decision-relevant input changes', () => {
    const candidate = evaluateCloseGate(input());
    const pending = evaluateCloseGate(input({ cleanup: [cleanup({ disposition: 'retention_pending' })] }));
    const blocked = evaluateCloseGate(input({ removals: [removal({ status: 'blocked' })] }));
    expect(new Set([candidate.fingerprint, pending.fingerprint, blocked.fingerprint]).size).toBe(3);
  });
});

describe('close gate receipts', () => {
  it('round-trips a verdict through a receipt file named after its subject', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-'));
    temporaryDirectories.push(directory);
    const verdict = evaluateCloseGate(input());
    const written = await writeCloseGateReceipt({
      directory,
      verdict,
      now: () => new Date('2026-11-14T00:00:00.000Z'),
      gateId: () => 'gate-1',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(path.basename(written.value.path)).toBe(`${GOAL}-gate-1.json`);

    const read = await readCloseGateReceipt(written.value.path);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual(written.value.receipt);
    expect(read.value.createdAt).toBe('2026-11-14T00:00:00.000Z');
    expect(read.value.verdict.fingerprint).toBe(verdict.fingerprint);
  });

  it('refuses a file that is not a close gate receipt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'foreign.json');
    await writeFile(file, JSON.stringify({ kind: 'workflow-gate', phase: 'integrate', version: 1 }), 'utf8');
    expect((await readCloseGateReceipt(file)).ok).toBe(false);
    expect((await readCloseGateReceipt(path.join(directory, 'missing.json'))).ok).toBe(false);
  });
});

describe('formatCloseGateVerdict', () => {
  it('names the subject and the blockers of a refusal', () => {
    const verdict: CloseGateVerdict = evaluateCloseGate(input({
      cleanup: [cleanup({ disposition: 'blocked', blockers: ['goal_workspace_not_clean'] })],
      removals: [removal({ status: 'blocked', blockers: ['unmerged_changes'] })],
    }));
    const lines = formatCloseGateVerdict(verdict);
    expect(lines[0]).toBe(`close gate for goal ${GOAL}: refused (2 blockers)`);
    expect(lines[1]).toContain('goal_workspace_not_clean');
    expect(lines[2]).toContain('unmerged_changes');
    expect(lines.at(-1)).toBe(`fingerprint ${verdict.fingerprint}`);
  });

  it('prints a single line plus the fingerprint when the phase may proceed', () => {
    const verdict = evaluateCloseGate(input());
    expect(formatCloseGateVerdict(verdict)).toEqual([
      `close gate for goal ${GOAL}: allowed`,
      `fingerprint ${verdict.fingerprint}`,
    ]);
  });
});
