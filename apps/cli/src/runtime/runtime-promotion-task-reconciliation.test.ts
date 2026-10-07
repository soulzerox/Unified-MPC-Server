import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimePromotionTaskReconciliation } from './runtime-promotion-task-reconciliation.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  stateRoot: string;
  promoter: string;
  candidate: string;
  provider: ReturnType<typeof createRuntimePromotionTaskReconciliation>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-promotion-reconcile-'));
  roots.push(root);
  const stateRoot = path.join(root, 'deployments');
  const promoter = path.join(root, 'config', 'promote-runtime.sh');
  const candidate = path.join(root, 'runtime', 'releases', 'candidate');
  await mkdir(path.dirname(promoter), { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(promoter, '#!/usr/bin/env bash\n', 'utf8');
  return {
    root,
    stateRoot,
    promoter,
    candidate,
    provider: createRuntimePromotionTaskReconciliation({
      stateRoot,
      installedPromoterPath: promoter,
    }),
  };
}

async function writeReceipt(
  stateRoot: string,
  deploymentId: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const dir = path.join(stateRoot, deploymentId);
  await mkdir(dir, { recursive: true });
  await Promise.all(Object.entries(values).map(([key, value]) =>
    writeFile(path.join(dir, key), value + '\n', 'utf8')));
}

describe('runtime promotion task reconciliation', () => {
  it('describes only the installed promoter invocation and binds candidate plus deployment id', async () => {
    const { provider, promoter, candidate } = await fixture();

    expect(provider.describe({
      executable: '/usr/bin/bash',
      arguments: [promoter, candidate, 'deploy-1'],
      cwd: path.dirname(candidate),
      environment: {},
    })).toEqual({
      kind: 'unified_runtime_promotion_v1',
      key: JSON.stringify({ deploymentId: 'deploy-1', candidatePath: candidate }),
    });
    expect(provider.describe({
      executable: '/usr/bin/bash',
      arguments: [path.join(path.dirname(promoter), 'other.sh'), candidate, 'deploy-1'],
      cwd: path.dirname(candidate),
      environment: {},
    })).toBeUndefined();
  });

  it.each([
    ['pending', 'running', undefined],
    ['activated', 'running', undefined],
    ['rollback_pending', 'running', undefined],
    ['healthy', 'completed', 0],
    ['rolled_back', 'failed', 70],
    ['rollback_failed', 'failed', 71],
    ['failed_no_rollback', 'failed', 72],
    ['failed', 'failed', 70],
  ] as const)('maps deployment status %s to task state %s', async (status, state, exitCode) => {
    const { provider, stateRoot, promoter, candidate } = await fixture();
    const deploymentId = 'deploy-status';
    await writeReceipt(stateRoot, deploymentId, {
      status,
      candidate_path: candidate,
      ...(status === 'healthy' ? { health_result: 'healthy', rollback_result: 'not_needed' } : {}),
    });
    const descriptor = provider.describe({
      executable: promoter,
      arguments: [candidate, deploymentId],
      cwd: path.dirname(candidate),
      environment: {},
    });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    const result = await provider.reconcile(descriptor);

    expect(result).toMatchObject({
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  });

  it('keeps an unresolved deployment receipt non-terminal until the record exists', async () => {
    const { provider, promoter, candidate } = await fixture();
    const descriptor = provider.describe({
      executable: promoter,
      arguments: [candidate, 'missing-deployment'],
      cwd: path.dirname(candidate),
      environment: {},
    });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    await expect(provider.reconcile(descriptor)).resolves.toBeUndefined();
  });

  it('fails closed when the receipt omits the candidate identity', async () => {
    const { provider, stateRoot, promoter, candidate } = await fixture();
    await writeReceipt(stateRoot, 'missing-candidate', {
      status: 'healthy',
      health_result: 'healthy',
      rollback_result: 'not_needed',
    });
    const descriptor = provider.describe({
      executable: promoter,
      arguments: [candidate, 'missing-candidate'],
      cwd: path.dirname(candidate),
      environment: {},
    });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    await expect(provider.reconcile(descriptor)).resolves.toEqual({
      state: 'failed',
      exitCode: -1,
      error: 'Runtime promotion deployment receipt is missing candidate identity',
    });
  });

  it('fails closed when the receipt candidate does not match the submitted candidate', async () => {
    const { provider, stateRoot, promoter, candidate } = await fixture();
    await writeReceipt(stateRoot, 'mismatch', {
      status: 'healthy',
      health_result: 'healthy',
      rollback_result: 'not_needed',
      candidate_path: path.join(path.dirname(candidate), 'other-release'),
    });
    const descriptor = provider.describe({
      executable: '/usr/bin/bash',
      arguments: [promoter, candidate, 'mismatch'],
      cwd: path.dirname(candidate),
      environment: {},
    });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    await expect(provider.reconcile(descriptor)).resolves.toEqual({
      state: 'failed',
      exitCode: -1,
      error: 'Runtime promotion deployment receipt candidate does not match the submitted task',
    });
  });

  it('fails closed on an internally inconsistent healthy receipt', async () => {
    const { provider, stateRoot, promoter, candidate } = await fixture();
    await writeReceipt(stateRoot, 'bad-healthy', {
      status: 'healthy',
      health_result: 'pending',
      rollback_result: 'not_needed',
      candidate_path: candidate,
    });
    const descriptor = provider.describe({
      executable: promoter,
      arguments: [candidate, 'bad-healthy'],
      cwd: path.dirname(candidate),
      environment: {},
    });
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    await expect(provider.reconcile(descriptor)).resolves.toEqual({
      state: 'failed',
      exitCode: -1,
      error: 'Runtime promotion healthy receipt is internally inconsistent',
    });
  });
});
