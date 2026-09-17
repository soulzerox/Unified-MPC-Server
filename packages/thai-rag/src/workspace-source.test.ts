import { lstat, mkdtemp, mkdir, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureThaiRagWorkspaceSourceAlias } from './workspace-source.js';

const roots: string[] = [];
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-source-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Thai-RAG canonical workspace source aliases', () => {
  it('uses workspace UUIDs so same-basename repositories stay isolated', async () => {
    const dataRoot = await tempRoot();
    const projects = await tempRoot();
    const first = path.join(projects, 'a', 'repo');
    const second = path.join(projects, 'b', 'repo');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const one = await ensureThaiRagWorkspaceSourceAlias(dataRoot, firstId, first);
    const two = await ensureThaiRagWorkspaceSourceAlias(dataRoot, secondId, second);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(path.basename(one.value)).toBe(firstId);
    expect(path.basename(two.value)).toBe(secondId);
    expect(path.resolve(path.dirname(one.value), await readlink(one.value))).toBe(first);
    expect(path.resolve(path.dirname(two.value), await readlink(two.value))).toBe(second);
  });

  it('is idempotent but refuses to replace a non-symlink collision', async () => {
    const dataRoot = await tempRoot();
    const project = await tempRoot();
    const first = await ensureThaiRagWorkspaceSourceAlias(dataRoot, firstId, project);
    const second = await ensureThaiRagWorkspaceSourceAlias(dataRoot, firstId, project);
    expect(first).toEqual(second);
    if (!first.ok) return;
    expect((await lstat(first.value)).isSymbolicLink()).toBe(true);

    await rm(first.value);
    await mkdir(first.value);
    const collision = await ensureThaiRagWorkspaceSourceAlias(dataRoot, firstId, project);
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error.code).toBe('CONFLICT');
  });
});
