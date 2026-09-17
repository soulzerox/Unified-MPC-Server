import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ThaiRagWorkspaceManifestStore,
  type ThaiRagIndexGeneration,
} from './workspace-manifest.js';

const WORKSPACE = '0f2e1500-b802-4a1f-8c11-00000000000a';
const roots: string[] = [];
const generation: ThaiRagIndexGeneration = {
  providerSchemaVersion: 1,
  embeddingModel: 'nomic-embed-text',
  embeddingDimension: 768,
  chunkingVersion: 2,
  indexGeneration: 3,
  migrationGeneration: 1,
};

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'unified-thai-rag-manifest-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('ThaiRagWorkspaceManifestStore', () => {
  it('persists canonical workspace identity and index-generation metadata', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceManifestStore(dataRoot);
    const ensured = await store.ensure(WORKSPACE, generation);
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.value.workspaceId).toBe(WORKSPACE);
    expect(ensured.value.lifecycle).toBe('active');
    expect(ensured.value.generation).toEqual(generation);
    await expect(access(ensured.value.namespace.manifest)).resolves.toBeUndefined();
    expect((await store.get(WORKSPACE))).toEqual(ensured);
  });

  it('archives without deleting provider data and restore reuses the same namespace', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceManifestStore(dataRoot);
    const initial = await store.ensure(WORKSPACE, generation);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const archived = await store.archive(WORKSPACE);
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.lifecycle).toBe('archived-retained');
    expect(archived.value.namespace.root).toBe(initial.value.namespace.root);
    await expect(access(initial.value.namespace.root)).resolves.toBeUndefined();

    const restored = await store.restore(WORKSPACE, generation);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.lifecycle).toBe('active');
    expect(restored.value.namespace.root).toBe(initial.value.namespace.root);
    expect(restored.value.reindexRequired).toBe(false);
  });

  it('marks incompatible generations for reindex instead of mixing them', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceManifestStore(dataRoot);
    expect((await store.ensure(WORKSPACE, generation)).ok).toBe(true);

    const restored = await store.restore(WORKSPACE, { ...generation, embeddingModel: 'different-model', indexGeneration: 4 });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.reindexRequired).toBe(true);
    expect(restored.value.generation.embeddingModel).toBe('different-model');
    expect(restored.value.generation.indexGeneration).toBe(4);
  });

  it('classifies expired temporary workspaces without granting purge eligibility', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceManifestStore(dataRoot, { now: (): Date => new Date('2026-09-17T03:00:00.000Z') });
    const ensured = await store.ensure(WORKSPACE, generation, {
      temporary: true,
      expiresAt: '2026-09-17T02:00:00.000Z',
    });
    expect(ensured.ok).toBe(true);

    const reconciled = await store.reconcile(WORKSPACE, { filesystemPresent: false });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.value.lifecycle).toBe('temporary-expired');
    expect(reconciled.value.purgeEligible).toBe(false);
  });

  it('treats a missing filesystem path as an orphan candidate, never implicit permission to purge', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceManifestStore(dataRoot);
    expect((await store.ensure(WORKSPACE, generation)).ok).toBe(true);

    const reconciled = await store.reconcile(WORKSPACE, { filesystemPresent: false });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.value.lifecycle).toBe('orphan-candidate');
    expect(reconciled.value.purgeEligible).toBe(false);

    const eligible = await store.authorizePurge(WORKSPACE, { explicit: true });
    expect(eligible.ok).toBe(true);
    if (eligible.ok) {
      expect(eligible.value.lifecycle).toBe('purge-eligible');
      expect(eligible.value.purgeEligible).toBe(true);
    }
  });
});
