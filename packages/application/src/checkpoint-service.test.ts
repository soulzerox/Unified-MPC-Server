import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@unified-mpc/permissions';
import type { Checkpoint, CheckpointRepository, Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import { CheckpointService } from './checkpoint-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ workspace: Workspace; checkpoints: MemoryCheckpointRepository }> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-checkpoint-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  await mkdir(path.join(root, 'src'));
  const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  return { workspace, checkpoints: new MemoryCheckpointRepository() };
}

function workspaces(workspace: Workspace): WorkspaceRepository {
  return { async list(): Promise<Workspace[]> { return [workspace]; }, async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; }, async insert(): Promise<void> {}, async delete(): Promise<void> {} };
}

class MemoryCheckpointRepository implements CheckpointRepository {
  private readonly checkpoints: Checkpoint[] = [];
  public async insert(value: Checkpoint): Promise<void> { this.checkpoints.push(value); }
  public async get(id: string): Promise<Checkpoint | null> { return this.checkpoints.find((entry) => entry.id === id) ?? null; }
  /** Counts listing reads, so a test can prove a by-id lookup never took one. */
  public listCalls = 0;
  public async list(workspaceId: string, limit = 100): Promise<Checkpoint[]> {
    this.listCalls += 1;
    return this.checkpoints.filter((entry) => entry.workspaceId === workspaceId).slice(0, limit);
  }
}

describe('CheckpointService', () => {
  it('captures and restores file content through the workspace guard', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'before', 'utf8');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const actor = { clientId: 'client-1', clientName: 'test' };

    const created = await service.createForFiles(actor, workspace.id, [path.join('src', 'file.txt')]);
    await writeFile(target, 'after', 'utf8');
    if (!created.ok) throw new Error('checkpoint creation failed');
    const restored = await service.restore(actor, workspace.id, created.value.id, { profile: permissionProfiles.full, userConfirmed: true });

    expect(restored).toMatchObject({ ok: true, value: { restoredPaths: [path.join('src', 'file.txt')], rollbackCheckpointId: expect.any(String) } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
    if (!restored.ok || restored.value.rollbackCheckpointId === undefined) throw new Error('rollback checkpoint missing');
    await expect(service.restore(actor, workspace.id, restored.value.rollbackCheckpointId, { profile: permissionProfiles.full, userConfirmed: true }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(target, 'utf8')).resolves.toBe('after');
  });

  it('lists recovery-safe checkpoint metadata without returning file content', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'secret-before-content', 'utf8');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const actor = { clientId: 'client-1', clientName: 'test' };
    const created = await service.createForFiles(actor, workspace.id, [path.join('src', 'file.txt')]);
    if (!created.ok) throw new Error('checkpoint creation failed');

    const listed = await service.list(workspace.id);

    expect(listed).toMatchObject({ ok: true, value: [{
      id: created.value.id,
      workspaceId: workspace.id,
      files: [{ path: path.join('src', 'file.txt'), size: Buffer.byteLength('secret-before-content'), contentSha256: expect.any(String) }],
    }] });
    expect(JSON.stringify(listed)).not.toContain('secret-before-content');
  });

  it('reads one checkpoint by id without scanning or leaking another workspace', async () => {
    const { workspace, checkpoints } = await setup();
    await checkpoints.insert({
      id: 'checkpoint-old', workspaceId: workspace.id, createdAt: new Date(0).toISOString(),
      files: [{ path: 'src/old.ts', content: 'secret-old-content', contentSha256: 'hash-1', size: 18 }],
    });
    await checkpoints.insert({
      id: 'checkpoint-foreign', workspaceId: 'workspace-2', createdAt: new Date(0).toISOString(),
      files: [{ path: 'src/foreign.ts', content: 'secret-foreign-content', contentSha256: 'hash-2', size: 22 }],
    });
    const service = new CheckpointService(workspaces(workspace), checkpoints);

    // The id is the subject: an old checkpoint answers exactly like a new one,
    // which is what stops "older than the scan window" from reading as "nothing
    // to prepare".
    const found = await service.get(workspace.id, 'checkpoint-old');
    expect(found).toMatchObject({ ok: true, value: {
      id: 'checkpoint-old',
      workspaceId: workspace.id,
      files: [{ path: 'src/old.ts', size: 18, contentSha256: 'hash-1' }],
    } });
    expect(JSON.stringify(found)).not.toContain('secret-old-content');

    // An id that belongs to another workspace is reported as absent, so this
    // read cannot confirm that it exists.
    await expect(service.get(workspace.id, 'checkpoint-foreign')).resolves.toEqual({ ok: true, value: null });
    await expect(service.get(workspace.id, 'checkpoint-missing')).resolves.toEqual({ ok: true, value: null });

    // The point of the by-id read is that no listing is taken at all: a window
    // is what made an old checkpoint look unknown, so the service must not scan
    // one to answer.
    expect(checkpoints.listCalls).toBe(0);

    // A workspace that does not exist is an error, not an absence: this read
    // validates like every other read on the class, so a caller cannot mistake a
    // typo in the workspace id for a checkpoint that is not there.
    await expect(service.get('workspace-missing', 'checkpoint-old'))
      .resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
  });

  it('uses the current permission profile when restoring without an explicit override', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'profile.txt');
    await writeFile(target, 'before', 'utf8');
    let profileName: PermissionProfileName = 'safe';
    const service = new CheckpointService(workspaces(workspace), checkpoints, {
      profileProvider: (): PermissionProfile => permissionProfiles[profileName],
    });
    const actor = { clientId: 'client-1', clientName: 'test' };
    const created = await service.createForFiles(actor, workspace.id, [path.join('src', 'profile.txt')]);
    if (!created.ok) throw new Error('checkpoint creation failed');
    await writeFile(target, 'after', 'utf8');

    await expect(service.restore(actor, workspace.id, created.value.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
    profileName = 'balanced';
    await expect(service.restore(actor, workspace.id, created.value.id, { userConfirmed: true })).resolves.toMatchObject({ ok: true });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  it('rejects a checkpoint path that no longer resolves inside the workspace', async () => {
    const { workspace, checkpoints } = await setup();
    await checkpoints.insert({ id: 'checkpoint-1', workspaceId: workspace.id, createdAt: new Date(0).toISOString(), files: [{ path: path.join('..', 'outside.txt'), content: 'secret', contentSha256: 'hash', size: 6 }] });
    const result = await new CheckpointService(workspaces(workspace), checkpoints).restore(
      { clientId: 'client-1', clientName: 'test' }, workspace.id, 'checkpoint-1', { profile: permissionProfiles.full, userConfirmed: true },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
