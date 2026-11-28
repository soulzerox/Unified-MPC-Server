import { describe, expect, it } from 'vitest';

import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import type { SourceStructuralRecord } from '@unified-mpc/code-intelligence';
import { SqliteDatabase } from './database.js';
import { SqliteStructuralRecordStore } from './structural-record-repository.js';
import { STRUCTURAL_RECORD_MIGRATION_SQL } from './migrations/structural-record-migration.js';

const NOW = new Date('2026-11-28T10:00:00.000Z');

const identity: CanonicalSourceIdentity = {
  repository_id: 'repo',
  manifest_id: 'manifest',
  revision_id: 'revision',
  commit_sha: 'a'.repeat(40),
  tree_oid: 'b'.repeat(40),
  ref: 'refs/heads/main',
};

function record(overrides: Partial<SourceStructuralRecord> = {}): SourceStructuralRecord {
  return {
    path: 'src/a.ts',
    identity,
    fingerprint: `sha256:${'1'.repeat(64)}`,
    language: 'typescript',
    symbols: [{ name: 'a', kind: 'function', startLine: 1, endLine: 1, container: '', exported: true }],
    imports: [{ specifier: './b.js', kind: 'static', startLine: 1 }],
    ...overrides,
  };
}

function store(): { database: SqliteDatabase; store: SqliteStructuralRecordStore } {
  const database = new SqliteDatabase(':memory:');
  return { database, store: new SqliteStructuralRecordStore(database, { now: (): Date => NOW }) };
}

describe('SqliteStructuralRecordStore', () => {
  it('round-trips a generation and reads it back by exact identity', async () => {
    const { database, store: records } = store();
    try {
      const records2 = [record({ path: 'src/b.ts', fingerprint: `sha256:${'2'.repeat(64)}` }), record()];
      const written = await records.writeGeneration({ identity, records: records2 });
      if (!written.ok) throw new Error(written.error.message);

      expect(written.value).toMatchObject({ schemaVersion: 1, fileCount: 2, writtenAt: NOW.toISOString() });

      const read = await records.readGeneration(identity);
      expect(read).toMatchObject({ ok: true, value: { fileCount: 2, writtenAt: NOW.toISOString() } });

      const page = await records.readRecords({ generationId: written.value.generationId, limit: 10 });
      if (!page.ok) throw new Error(page.error.message);
      expect(page.value).toEqual([record(), records2[0]]);
    } finally {
      database.close();
    }
  });

  it('does not resolve a neighbouring identity as the stored generation', async () => {
    const { database, store: records } = store();
    try {
      const written = await records.writeGeneration({ identity, records: [record()] });
      if (!written.ok) throw new Error(written.error.message);

      const other = await records.readGeneration({ ...identity, commit_sha: 'c'.repeat(40) });
      expect(other).toEqual({ ok: true, value: undefined });
    } finally {
      database.close();
    }
  });

  it('refuses a second write of the same identity and leaves the first intact', async () => {
    const { database, store: records } = store();
    try {
      const first = await records.writeGeneration({ identity, records: [record()] });
      if (!first.ok) throw new Error(first.error.message);

      const second = await records.writeGeneration({
        identity,
        records: [record({ fingerprint: `sha256:${'9'.repeat(64)}` })],
      });
      expect(second).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const page = await records.readRecords({ generationId: first.value.generationId, limit: 10 });
      if (!page.ok) throw new Error(page.error.message);
      expect(page.value).toEqual([record()]);
    } finally {
      database.close();
    }
  });

  it('refuses a record carrying a different identity than the write', async () => {
    const { database, store: records } = store();
    try {
      const result = await records.writeGeneration({
        identity,
        records: [record({ identity: { ...identity, ref: 'refs/heads/other' } })],
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      database.close();
    }
  });

  it('refuses duplicate paths, a malformed fingerprint and an absolute path', async () => {
    const { database, store: records } = store();
    try {
      const duplicate = await records.writeGeneration({ identity, records: [record(), record()] });
      expect(duplicate).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const badFingerprint = await records.writeGeneration({ identity, records: [record({ fingerprint: 'sha256:abc' })] });
      expect(badFingerprint).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const absolute = await records.writeGeneration({ identity, records: [record({ path: '/etc/passwd' })] });
      expect(absolute).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      // A path that is relative but still escapes, or that is not canonical, is
      // refused here rather than stored in an immutable generation.
      for (const escaping of ['../x.ts', 'src/../../x.ts', 'a/./b.ts', 'a//b.ts', '..foo.ts/../x.ts']) {
        const refused = await records.writeGeneration({ identity, records: [record({ path: escaping })] });
        expect(refused, escaping).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      }

      // `..foo.ts` is a legal name, not an escape.
      const dotted = await records.writeGeneration({ identity, records: [record({ path: '..foo.ts' })] });
      if (!dotted.ok) throw new Error(dotted.error.message);
    } finally {
      database.close();
    }
  });

  it('pages records and fingerprints identically, and filters by path', async () => {
    const { database, store: records } = store();
    try {
      const written = await records.writeGeneration({
        identity,
        records: [
          record({ path: 'a.ts', fingerprint: `sha256:${'1'.repeat(64)}` }),
          record({ path: 'b.ts', fingerprint: `sha256:${'2'.repeat(64)}` }),
          record({ path: 'c.ts', fingerprint: `sha256:${'3'.repeat(64)}` }),
        ],
      });
      if (!written.ok) throw new Error(written.error.message);

      const page = await records.readRecords({ generationId: written.value.generationId, limit: 2, paths: ['a.ts', 'c.ts'] });
      const fingerprints = await records.readFingerprints({ generationId: written.value.generationId, limit: 2, paths: ['a.ts', 'c.ts'] });
      if (!page.ok || !fingerprints.ok) throw new Error('expected both reads to succeed');

      expect(page.value.map((entry) => entry.path)).toEqual(['a.ts', 'c.ts']);
      expect(fingerprints.value).toEqual(page.value.map((entry) => ({ path: entry.path, fingerprint: entry.fingerprint })));

      const unbounded = await records.readRecords({ generationId: written.value.generationId, limit: 0 });
      expect(unbounded).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      database.close();
    }
  });

  it('truncates to the limit and refuses an empty generation', async () => {
    const { database, store: records } = store();
    try {
      const empty = await records.writeGeneration({ identity, records: [] });
      expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      // Nothing was written, so the identity is still free for the real extraction.
      const real = await records.writeGeneration({ identity, records: [record()] });
      if (!real.ok) throw new Error(real.error.message);

      const next = { ...identity, commit_sha: 'd'.repeat(40) };
      const one = await records.writeGeneration({
        identity: next,
        records: [
          record({ path: 'c.ts', identity: next }),
          record({ path: 'a.ts', identity: next }),
          record({ path: 'b.ts', identity: next }),
        ],
      });
      if (!one.ok) throw new Error(one.error.message);

      const page = await records.readRecords({ generationId: one.value.generationId, limit: 1 });
      const fingerprints = await records.readFingerprints({ generationId: one.value.generationId, limit: 1 });
      if (!page.ok || !fingerprints.ok) throw new Error('expected both reads to succeed');
      // Limit 1 of 3, in path order: a regression that ignored LIMIT returns 3.
      expect(page.value.map((entry) => entry.path)).toEqual(['a.ts']);
      expect(fingerprints.value.map((entry) => entry.path)).toEqual(['a.ts']);

      const tooManyPaths = await records.readRecords({
        generationId: one.value.generationId,
        limit: 1,
        paths: Array.from({ length: 2_001 }, (_, index) => `p${index}.ts`),
      });
      expect(tooManyPaths).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      database.close();
    }
  });

  it('keeps a parse error on the record instead of dropping it', async () => {
    const { database, store: records } = store();
    try {
      const broken = record({ path: 'broken.ts', parseError: 'line 1: } expected.' });
      const written = await records.writeGeneration({ identity, records: [broken] });
      if (!written.ok) throw new Error(written.error.message);

      const page = await records.readRecords({ generationId: written.value.generationId, limit: 10 });
      if (!page.ok) throw new Error(page.error.message);
      expect(page.value).toEqual([broken]);
    } finally {
      database.close();
    }
  });

  it('applies the migration twice without error', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      expect(() => database.connection.exec(STRUCTURAL_RECORD_MIGRATION_SQL)).not.toThrow();
    } finally {
      database.close();
    }
  });
});
