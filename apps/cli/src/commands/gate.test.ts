import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GoalCompletionWorktreeBlocker } from '@unified-mpc/application';
import type {
  CloseGateInput,
  CloseGateRemovalPreview,
  CloseGateVerdict,
} from './gate.js';
import {
  closeGateExitCode,
  evaluateCloseGate,
  formatCloseGateVerdict,
  parseGateArgs,
  readCloseGateReceipt,
  writeCloseGateReceipt,
} from './gate.js';
import { runCloseGate, type CloseGatePorts } from './gate-command.js';
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
    const otherGoal = evaluateCloseGate(input({
      cleanup: [cleanup({ goalId: 'goal_other', disposition: 'blocked' })],
    }));
    expect(otherGoal.allowed).toBe(false);
    expect(otherGoal.blockers).toEqual([{ kind: 'cleanup_unclassified', workspaceId: WORKSPACE }]);

    const otherWorkspace = evaluateCloseGate(input({
      cleanup: [cleanup({ workspaceId: 'ws_other', disposition: 'blocked' })],
    }));
    expect(otherWorkspace.allowed).toBe(false);
    expect(otherWorkspace.blockers).toEqual([{ kind: 'cleanup_unclassified', workspaceId: WORKSPACE }]);
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
      completion: [{ worktreePath: WORKTREE, blockers: [] }],
    }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockers).toEqual([{
      kind: 'completion',
      worktreePath: WORKTREE,
      blockers: [],
    }]);
    expect(formatCloseGateVerdict(verdict)[1]).toBe(`  worktree ${WORKTREE} still holds work`);
  });

  it('gates every goal of a workspace when no goal is named', () => {
    const verdict = evaluateCloseGate({
      workspaceId: WORKSPACE,
      cleanup: [cleanup(), cleanup({ goalId: 'goal_other' })],
      removals: [removal()],
      completion: [],
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.goalId).toBeUndefined();
    expect(formatCloseGateVerdict(verdict)[0]).toBe(`close gate for workspace ${WORKSPACE}: allowed`);

    // Workspace mode is not blind to a sibling goal: any row in scope refuses.
    const siblingBlocked = evaluateCloseGate({
      workspaceId: WORKSPACE,
      cleanup: [
        cleanup(),
        cleanup({ goalId: 'goal_other', disposition: 'blocked', blockers: ['goal_workspace_not_clean'] }),
      ],
      removals: [removal()],
      completion: [],
    });
    expect(siblingBlocked.allowed).toBe(false);
    expect(siblingBlocked.blockers).toEqual([{
      kind: 'cleanup',
      workspaceId: WORKSPACE,
      disposition: 'blocked',
      reasons: ['goal_workspace_not_clean'],
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

  it('ignores cleanup rows of other goals', () => {
    const alone = evaluateCloseGate(input());
    const withUnrelated = evaluateCloseGate(input({
      cleanup: [cleanup(), cleanup({ goalId: 'goal_other', disposition: 'blocked', blockers: ['goal_workspace_not_clean'] })],
    }));
    expect(withUnrelated.fingerprint).toBe(alone.fingerprint);
    expect(withUnrelated.allowed).toBe(true);
  });

  it('changes when a decision-relevant input changes', () => {
    const candidate = evaluateCloseGate(input());
    const pending = evaluateCloseGate(input({ cleanup: [cleanup({ disposition: 'retention_pending' })] }));
    const blocked = evaluateCloseGate(input({ removals: [removal({ status: 'blocked' })] }));
    expect(new Set([candidate.fingerprint, pending.fingerprint, blocked.fingerprint]).size).toBe(3);
  });

  it('covers every field the decision reads, not just the verdict shape', () => {
    const base = evaluateCloseGate(input());
    const variants = [
      // A blocker name, without changing the disposition it belongs to.
      evaluateCloseGate(input({ cleanup: [cleanup({ blockers: ['goal_workspace_not_clean'] })] })),
      // A worktree path, without changing its status.
      evaluateCloseGate(input({ removals: [removal({ worktreePath: 'other' })] })),
      // A completion row, which has no disposition at all.
      evaluateCloseGate(input({ completion: [{ worktreePath: WORKTREE, blockers: ['dirty'] }] })),
    ];
    expect(new Set([base.fingerprint, ...variants.map((verdict) => verdict.fingerprint)]).size)
      .toBe(variants.length + 1);
  });

  it('binds the subject itself, even when no cleanup row carries it', () => {
    // The cleanup row is empty, so only the top-level subject can move the hash.
    // Without this case a subject variant could pass on its cleanup row alone.
    const bare = evaluateCloseGate(input({ cleanup: [] }));
    const otherWorkspace = evaluateCloseGate(input({ cleanup: [], workspaceId: 'ws_other' }));
    const otherGoal = evaluateCloseGate(input({ cleanup: [], goalId: 'goal_other' }));
    expect(new Set([bare.fingerprint, otherWorkspace.fingerprint, otherGoal.fingerprint]).size).toBe(3);
  });

  it('does not depend on input order when two rows share a sort key', () => {
    const dirty = { status: 'blocked' as const, blockers: ['dirty'] };
    const unmerged = { status: 'blocked' as const, blockers: ['unmerged_changes'] };
    const forward = evaluateCloseGate(input({ removals: [removal(dirty), removal(unmerged)] }));
    const reversed = evaluateCloseGate(input({ removals: [removal(unmerged), removal(dirty)] }));
    expect(reversed.fingerprint).toBe(forward.fingerprint);
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

    // A JSON document that is not an object, and a receipt whose verdict is not a
    // verdict, are refused instead of being cast.
    for (const [name, body] of [
      ['null.json', 'null'],
      ['array.json', '[]'],
      ['no-verdict.json', JSON.stringify({ kind: 'workflow-gate', phase: 'close', version: 1, gateId: 'g', createdAt: 'now' })],
      ['bad-verdict.json', JSON.stringify({ kind: 'workflow-gate', phase: 'close', version: 1, gateId: 'g', createdAt: 'now', verdict: { fingerprint: 'sha256:x' } })],
    ] as const) {
      const candidate = path.join(directory, name);
      await writeFile(candidate, body, 'utf8');
      expect((await readCloseGateReceipt(candidate)).ok).toBe(false);
    }
  });

  it('refuses a receipt whose verdict is not the verdict this module produces', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-'));
    temporaryDirectories.push(directory);
    const verdict = evaluateCloseGate(input());
    const base = {
      kind: 'workflow-gate',
      phase: 'close',
      version: 1,
      gateId: 'g',
      createdAt: '2026-11-14T00:00:00.000Z',
      verdict,
    };
    // Each mutation keeps the envelope valid and breaks exactly one guarantee the
    // verdict makes, so every case fails for its own reason.
    const mutations: readonly (readonly [string, unknown])[] = [
      ['another phase', { ...base, verdict: { ...verdict, phase: 'integrate' } }],
      ['a fingerprint that is not a sha256', { ...base, verdict: { ...verdict, fingerprint: 'sha256:x' } }],
      ['allowed with blockers', {
        ...base,
        verdict: {
          ...verdict,
          allowed: true,
          blockers: [{ kind: 'completion', worktreePath: WORKTREE, blockers: [] }],
        },
      }],
      ['a blocker with no reasons', {
        ...base,
        verdict: { ...verdict, allowed: false, blockers: [{ kind: 'cleanup', workspaceId: WORKSPACE }] },
      }],
      ['an unknown blocker kind', {
        ...base,
        verdict: { ...verdict, allowed: false, blockers: [{ kind: 'mystery', workspaceId: WORKSPACE }] },
      }],
      ['a removal blocker that says clean', {
        ...base,
        verdict: {
          ...verdict,
          allowed: false,
          blockers: [{ kind: 'removal', worktreePath: WORKTREE, status: 'clean', blockers: [] }],
        },
      }],
      ['a cleanup blocker with a passing disposition', {
        ...base,
        verdict: {
          ...verdict,
          allowed: false,
          blockers: [{ kind: 'cleanup', workspaceId: WORKSPACE, disposition: 'retention_candidate', reasons: [] }],
        },
      }],
      ['a non-string headSha', { ...base, headSha: 42 }],
      ['a non-string goalId', { ...base, verdict: { ...verdict, goalId: 42 } }],
    ];
    for (const [name, body] of mutations) {
      const candidate = path.join(directory, `${name.replace(/\W+/g, '-')}.json`);
      await writeFile(candidate, JSON.stringify(body), 'utf8');
      expect((await readCloseGateReceipt(candidate)).ok, name).toBe(false);
    }
  });

  it('refuses a receipt whose envelope is not the one this module writes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-'));
    temporaryDirectories.push(directory);
    const verdict = evaluateCloseGate(input());
    const base = {
      kind: 'workflow-gate',
      phase: 'close',
      version: 1,
      gateId: 'g',
      createdAt: '2026-11-14T00:00:00.000Z',
      verdict,
    };
    const mutations: readonly (readonly [string, unknown])[] = [
      ['another version', { ...base, version: 2 }],
      ['no gate id', { ...base, gateId: undefined }],
      ['a non-string createdAt', { ...base, createdAt: 42 }],
    ];
    for (const [name, body] of mutations) {
      const candidate = path.join(directory, `${name.replace(/\W+/g, '-')}.json`);
      await writeFile(candidate, JSON.stringify(body), 'utf8');
      expect((await readCloseGateReceipt(candidate)).ok, name).toBe(false);
    }
  });

  it('keeps the receipt inside its directory and never overwrites one', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-'));
    temporaryDirectories.push(directory);
    const verdict = evaluateCloseGate(input());
    const escaped = await writeCloseGateReceipt({ directory, verdict, gateId: () => '../../escape' });
    expect(escaped.ok).toBe(true);
    if (!escaped.ok) return;
    expect(path.dirname(escaped.value.path)).toBe(directory);
    expect(path.basename(escaped.value.path)).toBe(`${GOAL}-.._.._escape.json`);

    const again = await writeCloseGateReceipt({ directory, verdict, gateId: () => '../../escape' });
    expect(again).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
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

describe('parseGateArgs', () => {
  it('parses the close phase with a workspace and repeatable worktrees', () => {
    expect(parseGateArgs(['check', '--phase', 'close', '--workspace', WORKSPACE, '--goal', GOAL, '--worktree', 'a', '--worktree', 'b']))
      .toEqual({
        ok: true,
        value: {
          kind: 'gate-check',
          phase: 'close',
          workspaceId: WORKSPACE,
          goalId: GOAL,
          worktrees: ['a', 'b'],
          json: false,
          dryRun: false,
        },
      });
  });

  it('requires a phase and a workspace', () => {
    expect(parseGateArgs(['check', '--workspace', WORKSPACE])).toMatchObject({ ok: false });
    expect(parseGateArgs(['check', '--phase', 'close'])).toMatchObject({ ok: false });
  });

  it('rejects an unknown phase instead of defaulting to one', () => {
    expect(parseGateArgs(['check', '--phase', 'integrate', '--workspace', WORKSPACE])).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Unknown gate phase: integrate' },
    });
  });

  it('rejects unknown, duplicated and valueless arguments', () => {
    expect(parseGateArgs(['check', '--phase', 'close', '--workspace', WORKSPACE, '--apply'])).toMatchObject({ ok: false });
    expect(parseGateArgs(['check', '--phase', 'close', '--phase', 'close', '--workspace', WORKSPACE])).toMatchObject({ ok: false });
    expect(parseGateArgs(['check', '--phase', 'close', '--workspace'])).toMatchObject({ ok: false });
    expect(parseGateArgs(['check', '--phase', 'close', '--workspace', WORKSPACE, '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseGateArgs(['status'])).toMatchObject({ ok: false });
  });
});

describe('runCloseGate', () => {
  function ports(overrides: Partial<CloseGatePorts> = {}): CloseGatePorts {
    return {
      cleanup: async () => ok([cleanup()]),
      removal: async ({ worktreePath }) => ok(removal({ worktreePath })),
      completion: async () => ok([]),
      ...overrides,
    };
  }

  it('asks every owner, writes a receipt and reports the verdict', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-run-'));
    temporaryDirectories.push(directory);
    const result = await runCloseGate({
      ports: ports(),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [WORKTREE],
      receiptDirectory: directory,
      dryRun: false,
      json: false,
      now: () => new Date('2026-11-14T00:00:00.000Z'),
      gateId: () => 'gate-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);
    expect(result.value.verdict.allowed).toBe(true);
    expect(result.value.receiptPath).toBe(path.join(directory, `${GOAL}-gate-1.json`));
    expect(result.value.lines.at(-1)).toBe(`receipt ${result.value.receiptPath}`);
    expect((await readCloseGateReceipt(result.value.receiptPath!)).ok).toBe(true);
  });

  it('forwards the subject to every owner and omits an absent goal', async () => {
    const cleanupRequests: unknown[] = [];
    const completionRequests: unknown[] = [];
    const recordingPorts = (): CloseGatePorts => ({
      cleanup: async (request): Promise<Result<readonly WorkspaceLifecycleCleanupEvaluation[]>> => {
        cleanupRequests.push(request);
        return ok([cleanup()]);
      },
      removal: async ({ worktreePath }) => ok(removal({ worktreePath })),
      completion: async (request): Promise<Result<readonly GoalCompletionWorktreeBlocker[]>> => {
        completionRequests.push(request);
        return ok([]);
      },
    });

    await runCloseGate({
      ports: recordingPorts(),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [WORKTREE],
      dryRun: true,
      json: false,
    });
    expect(cleanupRequests).toEqual([{ workspaceId: WORKSPACE, goalId: GOAL }]);
    expect(completionRequests).toEqual([{ workspaceId: WORKSPACE, goalId: GOAL }]);

    await runCloseGate({
      ports: recordingPorts(),
      workspaceId: WORKSPACE,
      worktrees: [],
      dryRun: true,
      json: false,
    });
    // No `goalId` key at all, rather than `goalId: undefined`.
    expect(cleanupRequests.at(-1)).toEqual({ workspaceId: WORKSPACE });
    expect(completionRequests.at(-1)).toEqual({ workspaceId: WORKSPACE });
  });

  it('aborts when the cleanup or completion owner fails', async () => {
    const cleanupFailure = await runCloseGate({
      ports: ports({ cleanup: async () => err(appError('CONFLICT', 'Goal runtime ledger is unreadable')) }),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [],
      dryRun: true,
      json: false,
    });
    expect(cleanupFailure).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const completionFailure = await runCloseGate({
      ports: ports({ completion: async () => err(appError('CONFLICT', 'Reconciliation port is unavailable')) }),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [],
      dryRun: true,
      json: false,
    });
    expect(completionFailure).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('exits non-zero on a refusal but still records it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-run-'));
    temporaryDirectories.push(directory);
    const result = await runCloseGate({
      ports: ports({
        removal: async ({ worktreePath }) => ok(removal({
          worktreePath,
          status: 'blocked',
          blockers: ['unmerged_changes'],
        })),
      }),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [WORKTREE],
      receiptDirectory: directory,
      dryRun: false,
      json: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(1);
    expect(result.value.verdict.blockers).toMatchObject([{ kind: 'removal', blockers: ['unmerged_changes'] }]);
    expect(result.value.receiptPath).toBeDefined();
  });

  it('writes nothing on a dry run', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'close-gate-run-'));
    temporaryDirectories.push(directory);
    const result = await runCloseGate({
      ports: ports(),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [],
      receiptDirectory: directory,
      dryRun: true,
      json: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receiptPath).toBeUndefined();
    expect(result.value.lines).toContain('dry run: no receipt written');
    expect(await readdir(directory)).toEqual([]);
  });

  it('aborts instead of reporting a verdict when an owner fails', async () => {
    const result = await runCloseGate({
      ports: ports({ removal: async () => err(appError('PERMISSION_DENIED', 'Worktree is owned by another client session')) }),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [WORKTREE],
      dryRun: true,
      json: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('refuses to drop the receipt without an explicit dry run', async () => {
    const result = await runCloseGate({
      ports: ports(),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [],
      dryRun: false,
      json: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('renders one JSON document when asked', async () => {
    const result = await runCloseGate({
      ports: ports(),
      workspaceId: WORKSPACE,
      goalId: GOAL,
      worktrees: [],
      dryRun: true,
      json: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toHaveLength(1);
    expect(JSON.parse(result.value.lines[0])).toMatchObject({ verdict: { phase: 'close', allowed: true } });
  });
});
