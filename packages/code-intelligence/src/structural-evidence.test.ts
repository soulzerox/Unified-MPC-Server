import { describe, expect, it } from 'vitest';

import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import { appError, err, ok } from '@unified-mpc/domain';

import { MAX_EVIDENCE_FILES, loadStructuralEvidence } from './structural-evidence.js';
import type {
  ReadStructuralRecordsInput,
  SourceStructuralRecord,
  StructuralGeneration,
  StructuralRecordStore,
} from './structural-record-store.js';

const identity: CanonicalSourceIdentity = {
  repository_id: 'repo',
  manifest_id: 'manifest',
  revision_id: 'revision',
  commit_sha: 'a'.repeat(40),
  tree_oid: 'b'.repeat(64),
  ref: 'refs/heads/main',
};

const generation: StructuralGeneration = {
  identity,
  generationId: 'sha256:' + '1'.repeat(64),
  schemaVersion: 1,
  writtenAt: '2026-11-28T00:00:00.000Z',
  fileCount: 1,
};

function record(path: string): SourceStructuralRecord {
  return { path, identity, fingerprint: 'sha256:' + '2'.repeat(64), language: 'typescript', symbols: [], imports: [] };
}

function fakeStore(records: readonly SourceStructuralRecord[], options: { readonly missing?: boolean } = {}): {
  store: StructuralRecordStore;
  reads: ReadStructuralRecordsInput[];
} {
  const reads: ReadStructuralRecordsInput[] = [];
  const ordered = [...records].sort((left, right) => (left.path < right.path ? -1 : 1));
  const store: StructuralRecordStore = {
    async writeGeneration() {
      return err(appError('INVALID_INPUT', 'unused'));
    },
    async readGeneration() {
      return ok(options.missing === true ? undefined : generation);
    },
    async readRecords(input) {
      reads.push(input);
      let page = ordered;
      if (input.paths !== undefined) {
        const wanted = new Set(input.paths);
        page = page.filter((entry) => wanted.has(entry.path));
      }
      if (input.afterPath !== undefined) {
        const after = input.afterPath;
        page = page.filter((entry) => entry.path > after);
      }
      return ok(page.slice(0, input.limit));
    },
    async readFingerprints() {
      return ok([]);
    },
  };
  return { store, reads };
}

describe('loadStructuralEvidence', () => {
  it('refuses an identity that has no stored generation instead of answering empty', async () => {
    const { store } = fakeStore([], { missing: true });

    const evidence = await loadStructuralEvidence({ store, identity });

    expect(evidence).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('reads only the paths a scoped query names', async () => {
    const { store, reads } = fakeStore([record('a.ts'), record('b.ts'), record('c.ts')]);

    const evidence = await loadStructuralEvidence({ store, identity, paths: ['b.ts'] });

    if (!evidence.ok) throw new Error(evidence.error.message);
    expect(evidence.value.records.map((entry) => entry.path)).toEqual(['b.ts']);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.paths).toEqual(['b.ts']);
    expect(reads[0]?.afterPath).toBeUndefined();
  });

  it('answers an empty path list without reading', async () => {
    const { store, reads } = fakeStore([record('a.ts')]);

    const evidence = await loadStructuralEvidence({ store, identity, paths: [] });

    if (!evidence.ok) throw new Error(evidence.error.message);
    expect(evidence.value.records).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it('reads a whole generation when it fits the ceiling', async () => {
    const { store } = fakeStore([record('b.ts'), record('a.ts')]);

    const evidence = await loadStructuralEvidence({ store, identity });

    if (!evidence.ok) throw new Error(evidence.error.message);
    expect(evidence.value.generationId).toBe(generation.generationId);
    expect(evidence.value.records.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('accepts a generation that is exactly the ceiling', async () => {
    const records = Array.from({ length: MAX_EVIDENCE_FILES }, (_, index) =>
      record(`f${String(index).padStart(5, '0')}.ts`));
    const { store } = fakeStore(records);

    const evidence = await loadStructuralEvidence({ store, identity });

    expect(evidence.ok).toBe(true);
  });

  it('refuses a generation above the ceiling and does not read the rest of it', async () => {
    const records = Array.from({ length: MAX_EVIDENCE_FILES + 5 }, (_, index) =>
      record(`f${String(index).padStart(5, '0')}.ts`));
    const { store, reads } = fakeStore(records);

    const evidence = await loadStructuralEvidence({ store, identity });

    expect(evidence).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(reads.map((read) => read.limit)).toEqual([MAX_EVIDENCE_FILES, 1]);
  });

  it('refuses more paths than the ceiling allows without reading them', async () => {
    const { store, reads } = fakeStore([record('a.ts')]);
    const paths = Array.from({ length: MAX_EVIDENCE_FILES + 1 }, (_, index) => `f${String(index)}.ts`);

    const evidence = await loadStructuralEvidence({ store, identity, paths });

    expect(evidence).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(reads).toHaveLength(0);
  });
});
