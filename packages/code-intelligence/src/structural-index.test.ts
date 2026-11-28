import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import { ok } from '@unified-mpc/domain';

import { buildStructuralGeneration } from './structural-index.js';
import type {
  ReadStructuralRecordsInput,
  StructuralFingerprint,
  StructuralGeneration,
  StructuralRecordStore,
  WriteStructuralGenerationInput,
} from './structural-record-store.js';
import type { SourceStructuralRecord } from './structural-extractor.js';

const identity: CanonicalSourceIdentity = {
  repository_id: 'repo',
  manifest_id: 'manifest',
  revision_id: 'revision',
  commit_sha: 'a'.repeat(40),
  tree_oid: 'b'.repeat(40),
  ref: 'refs/heads/main',
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'structural-index-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), contents, 'utf8');
  }
  return root;
}

function fakeStore(): { store: StructuralRecordStore; writes: WriteStructuralGenerationInput[] } {
  const writes: WriteStructuralGenerationInput[] = [];
  const store: StructuralRecordStore = {
    async writeGeneration(input: WriteStructuralGenerationInput): Promise<ReturnType<typeof ok<StructuralGeneration>>> {
      writes.push(input);
      return ok({
        identity: input.identity,
        generationId: `sha256:${'0'.repeat(64)}`,
        schemaVersion: 1,
        writtenAt: new Date(0).toISOString(),
        fileCount: input.records.length,
      });
    },
    async readGeneration(): Promise<ReturnType<typeof ok<StructuralGeneration | undefined>>> {
      return ok(undefined);
    },
    async readRecords(_input: ReadStructuralRecordsInput): Promise<ReturnType<typeof ok<readonly SourceStructuralRecord[]>>> {
      return ok([]);
    },
    async readFingerprints(_input: ReadStructuralRecordsInput): Promise<ReturnType<typeof ok<readonly StructuralFingerprint[]>>> {
      return ok([]);
    },
  };
  return { store, writes };
}

describe('structural generation builder', () => {
  it('extracts every admitted file and writes them as one generation', async () => {
    const root = await repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'import { a } from "./a.js";\nexport const b = a;\n' });
    const { store, writes } = fakeStore();

    const built = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: ['src/a.ts', 'src/b.ts'] });
    if (!built.ok) throw new Error(built.error.message);

    expect(built.value.fileCount).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.records.map((record) => record.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(writes[0]?.records[1]?.imports[0]?.specifier).toBe('./a.js');
    expect(writes[0]?.identity).toEqual(identity);
  });

  it('refuses an empty generation and duplicate paths without touching the store', async () => {
    const root = await repo({ 'a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const empty = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: [] });
    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const twice = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: ['a.ts', 'a.ts'] });
    expect(twice).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(writes).toHaveLength(0);
  });

  it('surfaces an extraction refusal and writes nothing', async () => {
    const root = await repo({ 'a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const escaped = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: ['../outside.ts'] });
    expect(escaped).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(writes).toHaveLength(0);
  });
});
