import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectRuntimeDeploymentReferences,
  runtimeDeploymentCleanupBlocker,
  type RuntimeDeploymentReferenceOptions,
} from './runtime-deployment-reference.js';

const temporaryRoots: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly options: RuntimeDeploymentReferenceOptions;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-runtime-ref-'));
  temporaryRoots.push(root);
  const runtimeDir = path.join(root, 'runtime');
  const stateDir = path.join(root, 'deployments');
  await mkdir(path.join(runtimeDir, 'releases'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return {
    root,
    runtimeDir,
    stateDir,
    options: { runtimeDir, deploymentStateDir: stateDir, homeDir: root, env: {} },
  };
}

async function writeRecord(
  stateDir: string,
  deploymentId: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const directory = path.join(stateDir, deploymentId);
  await mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    await writeFile(path.join(directory, name), `${value}\n`, 'utf8');
  }
}

afterEach(async (): Promise<void> => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime deployment cleanup references', () => {
  it('blocks current and last-known-good roots across fresh reconciliation reads', async () => {
    const { runtimeDir, options } = await fixture();
    const current = path.join(runtimeDir, 'releases', 'current-release');
    const lkg = path.join(runtimeDir, 'releases', 'lkg-release');
    await mkdir(current, { recursive: true });
    await mkdir(lkg, { recursive: true });
    await symlink(current, path.join(runtimeDir, 'current'));
    await symlink(lkg, path.join(runtimeDir, 'last-known-good'));

    await expect(runtimeDeploymentCleanupBlocker(current, options)).resolves.toMatchObject({
      blocked: true,
      reason: 'active_runtime_reference',
      references: [{ kind: 'current', path: current }],
    });
    await expect(runtimeDeploymentCleanupBlocker(lkg, options)).resolves.toMatchObject({
      blocked: true,
      reason: 'active_runtime_reference',
      references: [{ kind: 'last_known_good', path: lkg }],
    });

    const restartedSnapshot = await inspectRuntimeDeploymentReferences(options);
    expect(restartedSnapshot.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'current', path: current }),
      expect.objectContaining({ kind: 'last_known_good', path: lkg }),
    ]));
  });

  it('blocks non-terminal deployment candidate, previous-active and rollback targets', async () => {
    const { runtimeDir, stateDir, options } = await fixture();
    const candidate = path.join(runtimeDir, 'releases', 'candidate');
    const previous = path.join(runtimeDir, 'releases', 'previous');
    const rollback = path.join(runtimeDir, 'releases', 'rollback');
    await writeRecord(stateDir, 'deploy-1', {
      status: 'rollback_pending',
      candidate_path: candidate,
      previous_active: previous,
      rollback_target: rollback,
    });

    for (const [target, kind] of [
      [candidate, 'deployment_candidate'],
      [previous, 'deployment_previous_active'],
      [rollback, 'deployment_rollback_target'],
    ] as const) {
      await expect(runtimeDeploymentCleanupBlocker(target, options)).resolves.toMatchObject({
        blocked: true,
        reason: 'active_runtime_reference',
        references: [expect.objectContaining({ kind, deploymentId: 'deploy-1', status: 'rollback_pending' })],
      });
    }
  });

  it('does not pin terminal deployment history when no live pointer references the old release', async () => {
    const { runtimeDir, stateDir, options } = await fixture();
    const oldCandidate = path.join(runtimeDir, 'releases', 'old-candidate');
    await writeRecord(stateDir, 'deploy-old', {
      status: 'healthy',
      candidate_path: oldCandidate,
      previous_active: '',
      rollback_target: '',
    });

    await expect(runtimeDeploymentCleanupBlocker(oldCandidate, options)).resolves.toEqual({
      blocked: false,
      reason: null,
      references: [],
      uncertainties: [],
    });
  });

  it('fails closed on a crash-partial non-terminal deployment record', async () => {
    const { stateDir, options } = await fixture();
    await writeRecord(stateDir, 'deploy-crash', { status: 'pending' });

    const candidate = path.join(stateDir, '..', 'some-worktree');
    const first = await runtimeDeploymentCleanupBlocker(path.resolve(candidate), options);
    const afterRestart = await runtimeDeploymentCleanupBlocker(path.resolve(candidate), options);

    expect(first).toMatchObject({
      blocked: true,
      reason: 'runtime_reference_unknown',
      uncertainties: expect.arrayContaining([
        expect.stringContaining('deploy-crash'),
        expect.stringContaining('candidate_path'),
      ]),
    });
    expect(afterRestart).toEqual(first);
  });

  it('allows an unrelated absolute path when deployment references are healthy and disjoint', async () => {
    const { runtimeDir, options, root } = await fixture();
    const live = path.join(runtimeDir, 'releases', 'live');
    const unrelated = path.join(root, 'project', '.unified-mpc', 'worktrees', 'goal-a');
    await mkdir(live, { recursive: true });
    await symlink(live, path.join(runtimeDir, 'current'));

    await expect(runtimeDeploymentCleanupBlocker(unrelated, options)).resolves.toEqual({
      blocked: false,
      reason: null,
      references: [],
      uncertainties: [],
    });
  });
});
