import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import { appError, ok } from '@unified-mpc/domain';

import { buildStructuralGeneration, discoverStructuralFiles, indexStructuralWorkspace } from './structural-index.js';
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

const run = promisify(execFile);
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

async function committedRepo(
  files: Readonly<Record<string, string>>,
): Promise<{ root: string; identity: CanonicalSourceIdentity }> {
  const root = await repo(files);
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: root });
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { root, identity: { ...identity, commit_sha: stdout.trim() } };
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

  it('refuses an empty generation and a non-path entry without touching the store', async () => {
    const root = await repo({ 'a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const empty = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: [] });
    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    for (const files of [[''], [3 as never], 'a.ts' as never]) {
      const refused = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: files as never });
      expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(writes).toHaveLength(0);
  });

  it('lets the extractor collapse two spellings of one path into one record', async () => {
    const root = await repo({ 'a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const built = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: ['a.ts', './a.ts'] });
    if (!built.ok) throw new Error(built.error.message);
    expect(writes[0]?.records.map((record) => record.path)).toEqual(['a.ts']);
  });

  it('surfaces an extraction refusal and writes nothing', async () => {
    const root = await repo({ 'a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const escaped = await buildStructuralGeneration({ store, identity, repositoryRoot: root, files: ['../outside.ts'] });
    expect(escaped).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(writes).toHaveLength(0);
  });
});

describe('structural file discovery', () => {
  it('keeps only source files, dedupes them and orders them by code unit', async () => {
    const listed = ['b.ts', 'a.ts', 'README.md', 'c.mts', 'b.ts', 'dist/d.js', 'UP.TS', ''];
    const discovered = await discoverStructuralFiles({
      repositoryRoot: '/nowhere',
      listFiles: async () => ok(listed),
    });
    if (!discovered.ok) throw new Error(discovered.error.message);
    expect(discovered.value).toEqual(['UP.TS', 'a.ts', 'b.ts', 'c.mts', 'dist/d.js']);
  });

  it('asks git which committed files exist, so ignored and uncommitted files stay out', async () => {
    const root = await repo({
      '.gitignore': 'ignored.ts\n',
      'a.ts': 'export const a = 1;\n',
      'ignored.ts': 'export const ignored = 1;\n',
      'untracked.ts': 'export const u = 1;\n',
      'notes.md': '# notes\n',
    });
    await run('git', ['init', '-q'], { cwd: root });
    await run('git', ['add', 'a.ts', '.gitignore'], { cwd: root });

    const discovered = await discoverStructuralFiles({ repositoryRoot: root });
    if (!discovered.ok) throw new Error(discovered.error.message);
    expect(discovered.value).toEqual(['a.ts']);
  });

  it('refuses a directory git cannot read', async () => {
    // A path that does not exist makes Git fail before it can look at any parent, so
    // the refusal does not depend on whether the temp directory sits inside a repo.
    const missing = await mkdtemp(join(tmpdir(), 'structural-discovery-missing-'));
    await rm(missing, { recursive: true, force: true });
    const discovered = await discoverStructuralFiles({ repositoryRoot: missing });
    expect(discovered).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('refuses a checkout with no source files and passes a lister failure through', async () => {
    const { root, identity: head } = await committedRepo({ 'notes.md': '# notes\n' });
    const { store, writes } = fakeStore();

    const empty = await indexStructuralWorkspace({ store, identity: head, repositoryRoot: root });
    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const failed = await indexStructuralWorkspace({
      store,
      identity: head,
      repositoryRoot: root,
      listFiles: async () => ({ ok: false, error: appError('INVALID_INPUT', 'git is not installed') }),
    });
    expect(failed).toMatchObject({ ok: false, error: { message: 'git is not installed' } });
    expect(writes).toHaveLength(0);
  });

  it('indexes a clean checkout on the identity commit in one call', async () => {
    const { root, identity: head } = await committedRepo({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    const { store, writes } = fakeStore();

    const built = await indexStructuralWorkspace({ store, identity: head, repositoryRoot: root });
    if (!built.ok) throw new Error(built.error.message);
    expect(writes[0]?.records.map((record) => record.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('refuses a dirty worktree, because its bytes are not in any commit yet', async () => {
    const { root, identity: head } = await committedRepo({ 'a.ts': 'export const a = 1;\n' });
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf8');
    await run('git', ['add', 'b.ts'], { cwd: root });
    const { store, writes } = fakeStore();

    const dirty = await indexStructuralWorkspace({ store, identity: head, repositoryRoot: root });
    expect(dirty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(writes).toHaveLength(0);
  });

  it('refuses a clean checkout of a different commit than the identity names', async () => {
    const { root, identity: head } = await committedRepo({ 'a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const wrong = await indexStructuralWorkspace({
      store,
      identity: { ...head, commit_sha: 'f'.repeat(40) },
      repositoryRoot: root,
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(writes).toHaveLength(0);
  });

  it('refuses a subdirectory, whose relative paths would read as repository paths', async () => {
    const { root, identity: head } = await committedRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const { store, writes } = fakeStore();

    const subdir = await indexStructuralWorkspace({
      store,
      identity: head,
      repositoryRoot: join(root, 'src'),
    });
    expect(subdir).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(writes).toHaveLength(0);
  });
});
