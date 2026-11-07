import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceAdmissionReceipt, WorkspaceBaseRebaseReceipt } from '@unified-mpc/domain';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import { StrictWorkspaceRepository, canonicalizeAllowedRoots, requestedPathInsideAllowedRoot } from './strict-workspace-repository.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('strict stdio workspace repository', () => {
  it('hides previously registered broad roots and exposes only explicit allowed roots', async () => {
    const allowed = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-strict-allowed-'));
    const broad = path.parse(allowed).root;
    roots.push(allowed);
    const allowedReal = await realpath(allowed);
    const rows: Workspace[] = [workspace('broad', broad, broad), workspace('allowed', allowed, allowedReal)];
    const repo = new MemoryRepo(rows);
    const strict = new StrictWorkspaceRepository(repo, [allowedReal]);
    expect((await strict.list()).map((entry) => entry.id)).toEqual(['allowed']);
    expect(await strict.get('broad')).toBeNull();
  });

  it('canonicalizes roots and rejects requested workspaces outside them', async () => {
    const allowed = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-strict-allowed-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-strict-outside-'));
    roots.push(allowed, outside);
    const canonical = await canonicalizeAllowedRoots([allowed]);
    await expect(requestedPathInsideAllowedRoot(allowed, canonical)).resolves.toBe(canonical[0]);
    await expect(requestedPathInsideAllowedRoot(outside, canonical)).rejects.toThrow(/outside strict allowed roots/);
  });

  it('rejects foreign roots and POSIX mount roots before they become trusted workspaces', async () => {
    await expect(canonicalizeAllowedRoots(['/'], 'linux')).rejects.toThrow(/POSIX mount root/);
    await expect(canonicalizeAllowedRoots(['C:\\Users\\alice\\project'], 'linux')).rejects.toThrow(/foreign host path/);
  });

  it('forwards durable admission and rebase receipt capabilities for allowed workspaces only', async () => {
    const allowed = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-strict-allowed-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-strict-outside-'));
    roots.push(allowed, outside);
    const allowedReal = await realpath(allowed);
    const repo = new MemoryRepo([
      workspace('allowed', allowed, allowedReal),
      workspace('outside', outside, await realpath(outside)),
    ]);
    const strict = new StrictWorkspaceRepository(repo, [allowedReal]);

    expect(strict.getAdmissionReceipt).toBeTypeOf('function');
    expect(strict.compareAndSwapAdmissionReceipt).toBeTypeOf('function');
    expect(strict.invalidateAdmissionReceipt).toBeTypeOf('function');
    expect(strict.getBaseRebaseReceipt).toBeTypeOf('function');
    expect(strict.compareAndSwapBaseRebaseReceipt).toBeTypeOf('function');

    const admission = admissionReceipt('allowed');
    const rebase = rebaseReceipt('allowed');
    await expect(strict.getAdmissionReceipt?.('allowed')).resolves.toStrictEqual(admission);
    await expect(strict.compareAndSwapAdmissionReceipt?.('allowed', 0, 1, admission)).resolves.toBe(true);
    await expect(strict.invalidateAdmissionReceipt?.('allowed', 1, 'rebase', '2026-11-07T00:00:00.000Z')).resolves.toBe(true);
    await expect(strict.getBaseRebaseReceipt?.('allowed')).resolves.toStrictEqual(rebase);
    await expect(strict.compareAndSwapBaseRebaseReceipt?.('allowed', 0, 1, 1, rebase)).resolves.toBe(true);

    await expect(strict.getAdmissionReceipt?.('outside')).resolves.toBeNull();
    await expect(strict.compareAndSwapAdmissionReceipt?.('outside', 0, 1, admissionReceipt('outside'))).resolves.toBe(false);
    await expect(strict.invalidateAdmissionReceipt?.('outside', 1, 'rebase', '2026-11-07T00:00:00.000Z')).resolves.toBe(false);
    await expect(strict.getBaseRebaseReceipt?.('outside')).resolves.toBeNull();
    await expect(strict.compareAndSwapBaseRebaseReceipt?.('outside', 0, 1, 1, rebaseReceipt('outside'))).resolves.toBe(false);

    expect(repo.admissionReads).toEqual(['allowed']);
    expect(repo.admissionSwaps).toEqual(['allowed']);
    expect(repo.admissionInvalidations).toEqual(['allowed']);
    expect(repo.rebaseReads).toEqual(['allowed']);
    expect(repo.rebaseSwaps).toEqual(['allowed']);
  });

  it('preserves optional capability detection when the inner repository has no receipt storage', async () => {
    const allowed = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-strict-allowed-'));
    roots.push(allowed);
    const strict = new StrictWorkspaceRepository(new MemoryRepo([workspace('allowed', allowed, await realpath(allowed))], false), [await realpath(allowed)]);
    expect(strict.getAdmissionReceipt).toBeUndefined();
    expect(strict.compareAndSwapAdmissionReceipt).toBeUndefined();
    expect(strict.invalidateAdmissionReceipt).toBeUndefined();
    expect(strict.getBaseRebaseReceipt).toBeUndefined();
    expect(strict.compareAndSwapBaseRebaseReceipt).toBeUndefined();
  });
});

function workspace(id: string, rootPath: string, realRootPath: string): Workspace {
  return { id, displayName: id, rootPath, realRootPath, createdAt: '2026-08-22T00:00:00.000Z' };
}

function admissionReceipt(workspaceId: string): WorkspaceAdmissionReceipt {
  return {
    admissionId: `admission-${workspaceId}`, projectId: 'project-1', workspaceId, goalId: 'goal-1',
    workspaceKind: 'git', repositoryIdentity: 'repo-1', worktreeIdentity: 'worktree-1',
    expectedWorkspaceHead: 'a'.repeat(40), observedWorkspaceHead: 'a'.repeat(40),
    baseRef: 'origin/main', resolvedBaseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    dirtyState: 'clean', dirtyFingerprint: 'clean-1', writeLeaseGeneration: 1,
    runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1',
    runtimeBuildVersion: '4.61.0+0123456789ab', runtimeBuildDirty: false,
    runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-11-07T00:00:00.000Z',
    workflowVersion: 1, admissionGeneration: 1, createdAt: '2026-11-07T00:00:00.000Z',
  };
}

function rebaseReceipt(workspaceId: string): WorkspaceBaseRebaseReceipt {
  return {
    operationId: `rebase-${workspaceId}`, receiptRevision: 1, workspaceId, goalId: 'goal-1',
    branchName: 'codex/goal-1', status: 'started', oldHead: 'a'.repeat(40), oldBaseSha: 'b'.repeat(40),
    newBaseSha: 'c'.repeat(40), checkpointId: 'checkpoint-1', checkpointRevision: 7,
    checkpointHead: 'a'.repeat(40), recoveryRef: 'refs/unified-mpc/recovery/goal-1',
    admissionGeneration: 1, writeLeaseGeneration: 1, startedAt: '2026-11-07T00:00:00.000Z',
  };
}

class MemoryRepo implements WorkspaceRepository {
  public readonly admissionReads: string[] = [];
  public readonly admissionSwaps: string[] = [];
  public readonly admissionInvalidations: string[] = [];
  public readonly rebaseReads: string[] = [];
  public readonly rebaseSwaps: string[] = [];
  public readonly getAdmissionReceipt?: (workspaceId: string) => Promise<WorkspaceAdmissionReceipt | null>;
  public readonly compareAndSwapAdmissionReceipt?: (
    workspaceId: string,
    expectedAdmissionGeneration: number,
    writeLeaseGeneration: number,
    receipt: WorkspaceAdmissionReceipt,
  ) => Promise<boolean>;
  public readonly invalidateAdmissionReceipt?: (workspaceId: string, expectedAdmissionGeneration: number, reason: string, invalidatedAt: string) => Promise<boolean>;
  public readonly getBaseRebaseReceipt?: (workspaceId: string) => Promise<WorkspaceBaseRebaseReceipt | null>;
  public readonly compareAndSwapBaseRebaseReceipt?: (
    workspaceId: string,
    expectedReceiptRevision: number,
    expectedAdmissionGeneration: number,
    writeLeaseGeneration: number,
    receipt: WorkspaceBaseRebaseReceipt,
  ) => Promise<boolean>;

  public constructor(private readonly rows: Workspace[], withReceipts = true) {
    if (!withReceipts) return;
    this.getAdmissionReceipt = async (workspaceId): Promise<WorkspaceAdmissionReceipt | null> => {
      this.admissionReads.push(workspaceId);
      return admissionReceipt(workspaceId);
    };
    this.compareAndSwapAdmissionReceipt = async (workspaceId): Promise<boolean> => {
      this.admissionSwaps.push(workspaceId);
      return true;
    };
    this.invalidateAdmissionReceipt = async (workspaceId): Promise<boolean> => {
      this.admissionInvalidations.push(workspaceId);
      return true;
    };
    this.getBaseRebaseReceipt = async (workspaceId): Promise<WorkspaceBaseRebaseReceipt | null> => {
      this.rebaseReads.push(workspaceId);
      return rebaseReceipt(workspaceId);
    };
    this.compareAndSwapBaseRebaseReceipt = async (workspaceId): Promise<boolean> => {
      this.rebaseSwaps.push(workspaceId);
      return true;
    };
  }

  public async list(): Promise<Workspace[]> { return [...this.rows]; }
  public async get(id: string): Promise<Workspace | null> { return this.rows.find((row) => row.id === id) ?? null; }
  public async insert(value: Workspace): Promise<void> { this.rows.push(value); }
  public async delete(id: string): Promise<void> { const index = this.rows.findIndex((row) => row.id === id); if (index >= 0) this.rows.splice(index, 1); }
}
