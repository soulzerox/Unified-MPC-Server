import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '@unified-mpc/workspace';
import { createWorkflowGateProbe } from './web.js';

function workspace(rootPath: string): Workspace {
  return { id: 'ws-1', displayName: 'Fixture', rootPath, realRootPath: rootPath, createdAt: new Date(0).toISOString() };
}

async function fixtureRoot(profile?: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-gate-probe-'));
  if (profile !== undefined) {
    await mkdir(path.join(root, '.unified-mpc'), { recursive: true });
    await writeFile(path.join(root, '.unified-mpc', 'project-profile.json'), JSON.stringify(profile), 'utf8');
  }
  return root;
}

describe('createWorkflowGateProbe', () => {
  it('reports the workspace posture without claiming a harness it cannot see', async () => {
    const probe = createWorkflowGateProbe({ list: async () => [workspace(await fixtureRoot({ workflowGate: { mutate: 'require_preparation' } }))] });

    await expect(probe('ws-1')).resolves.toMatchObject({
      phase: 'mutate',
      mode: 'require_preparation',
      evaluated: false,
      blocked: true,
      blockers: [{ code: 'harness_inactive' }],
    });
  });

  it('reports the default posture for a workspace that never opted in', async () => {
    const probe = createWorkflowGateProbe({ list: async () => [workspace(await fixtureRoot())] });

    await expect(probe('ws-1')).resolves.toMatchObject({
      mode: 'auto_prepare',
      evaluated: true,
      blocked: false,
      blockers: [],
    });
  });

  it('has no projection for a workspace it does not know, because absence is not permission', async () => {
    const probe = createWorkflowGateProbe({ list: async () => [workspace(await fixtureRoot())] });

    await expect(probe('ws-unknown')).resolves.toBeUndefined();
  });

  it('falls back to the default posture when the profile is unreadable JSON', async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, '.unified-mpc'), { recursive: true });
    await writeFile(path.join(root, '.unified-mpc', 'project-profile.json'), '{ not json', 'utf8');
    const probe = createWorkflowGateProbe({ list: async () => [workspace(root)] });

    await expect(probe('ws-1')).resolves.toMatchObject({ mode: 'auto_prepare', blocked: false });
  });
});
