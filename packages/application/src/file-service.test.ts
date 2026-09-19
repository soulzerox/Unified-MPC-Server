import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileService } from './file-service.js';
import { TextFileReader } from '@unified-mpc/filesystem';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('FileService', () => {
  it('reads only through the workspace guard and enforces the 4 MiB aggregate cap', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-files-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, 'one.txt'), Buffer.alloc(1.5 * 1024 * 1024, 0x61));
    await writeFile(path.join(root, 'two.txt'), Buffer.alloc(1.5 * 1024 * 1024, 0x62));
    await writeFile(path.join(root, 'three.txt'), Buffer.alloc(1.5 * 1024 * 1024, 0x63));

    const result = await new FileService(repository(workspace)).readFiles(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { files: [{ path: 'one.txt' }, { path: 'two.txt' }, { path: 'three.txt' }] },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
  });

  it('enforces the aggregate file item budget before reading extra files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-files-item-budget-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-item-budget', displayName: 'Item Budget Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, 'one.txt'), 'one', 'utf8');
    await writeFile(path.join(root, 'two.txt'), 'two', 'utf8');
    const readPaths: string[] = [];
    const reader = {
      async read(filePath: string) {
        readPaths.push(filePath);
        return { ok: true as const, value: { content: 'one', startLine: 1, endLine: 1 } };
      },
    } as unknown as TextFileReader;
    const service = new FileService(repository(workspace), undefined, reader);

    const result = await service.readFiles(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { files: [{ path: 'one.txt' }, { path: 'two.txt' }] },
      undefined,
      undefined,
      { maxItems: 1, maxTextBytes: 100, maxStructuredBytes: 100, maxBinaryBytes: 100, maxBase64Bytes: 100 },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
    expect(readPaths).toHaveLength(0);
  });

  it('enforces the aggregate structured budget across multi-file reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-files-structured-budget-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-structured-budget', displayName: 'Structured Budget Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, 'one.txt'), 'one', 'utf8');
    await writeFile(path.join(root, 'two.txt'), 'two', 'utf8');
    const readPaths: string[] = [];
    const reader = {
      async read(filePath: string) {
        readPaths.push(filePath);
        return { ok: true as const, value: { content: 'x'.repeat(20), startLine: 1, endLine: 1 } };
      },
    } as unknown as TextFileReader;
    const service = new FileService(repository(workspace), undefined, reader);

    const result = await service.readFiles(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { files: [{ path: 'one.txt' }, { path: 'two.txt' }] },
      undefined,
      undefined,
      { maxItems: 20, maxTextBytes: 1_000, maxStructuredBytes: 100, maxBinaryBytes: 1_000, maxBase64Bytes: 1_000 },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
    expect(readPaths).toHaveLength(1);
  });

  it('passes one shrinking aggregate budget across multi-file reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-files-budget-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-budget', displayName: 'Budget Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, 'one.txt'), 'one', 'utf8');
    await writeFile(path.join(root, 'two.txt'), 'two', 'utf8');
    const observedBudgets: number[] = [];
    const reader = {
      async read(_filePath: string, _range: unknown, maxBytes?: number) {
        observedBudgets.push(maxBytes ?? -1);
        return { ok: true as const, value: { content: 'x'.repeat(6), startLine: 1, endLine: 1 } };
      },
    } as unknown as TextFileReader;
    const service = new FileService(repository(workspace), undefined, reader);

    const result = await service.readFiles(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { files: [{ path: 'one.txt' }, { path: 'two.txt' }] },
      undefined,
      undefined,
      { maxItems: 20, maxTextBytes: 10, maxStructuredBytes: 100, maxBinaryBytes: 10, maxBase64Bytes: 10 },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
    expect(observedBudgets).toEqual([10, 4]);
  });

  it('denies secret file reads by default', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-files-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, '.env'), 'TOKEN=secret', 'utf8');

    const result = await new FileService(repository(workspace)).readFile(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { path: '.env' },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'SECRET_ACCESS_DENIED' } });
  });

  it('allows secret and binary reads for an explicitly trusted registered workspace on any drive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-files-trusted-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-trusted', displayName: 'Trusted Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, '.env'), 'TOKEN=secret', 'utf8');
    await writeFile(path.join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    const guard = new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true });
    const service = new FileService(repository(workspace), guard, undefined, { trustedWorkspaceAccess: true });
    const envResult = await service.readFile({ clientId: 'test', clientName: 'test' }, workspace.id, { path: '.env' });
    expect(envResult).toMatchObject({ ok: true, value: { content: 'TOKEN=secret', encoding: 'utf8' } });

    const imageResult = await service.readFile({ clientId: 'test', clientName: 'test' }, workspace.id, { path: 'pixel.png' });
    expect(imageResult.ok).toBe(true);
    if (imageResult.ok) {
      expect(imageResult.value.encoding).toBe('base64');
      expect(imageResult.value.mimeType).toBe('image/png');
    }
  });
});
