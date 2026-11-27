import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';

import { extractStructuralRecord, extractStructuralRecords } from './structural-extractor.js';

const created: string[] = [];

async function root(): Promise<string> {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), 'code-intelligence-')));
  created.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

const identity: CanonicalSourceIdentity = {
  repository_id: 'repo',
  manifest_id: 'manifest',
  revision_id: 'revision',
  commit_sha: 'a'.repeat(40),
  tree_oid: 'b'.repeat(40),
  ref: 'refs/heads/main',
};

const sample = `import { readFile } from 'node:fs/promises';
export { thing } from './thing.js';

export const LIMIT = 3;
export class Outer {
  inner(): number {
    return LIMIT;
  }
}

export function run(value: string): string {
  return value;
}

interface Shape {
  width: number;
}

type Alias = Shape | null;

enum Mode {
  On,
  Off,
}

const local = require('./legacy.cjs');
const lazy = import('./lazy.js');
`;

describe('structural extractor', () => {
  it('records symbols with their container, export and line range', async () => {
    const base = await root();
    await writeFile(path.join(base, 'sample.ts'), sample);

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['sample.ts'] });
    if (!result.ok) throw new Error(result.error.message);
    const [record] = result.value;

    expect(record).toMatchObject({ path: 'sample.ts', language: 'typescript', identity, fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(record.symbols).toEqual([
      { name: 'LIMIT', kind: 'const', startLine: 4, endLine: 4, container: '', exported: true },
      { name: 'Outer', kind: 'class', startLine: 5, endLine: 9, container: '', exported: true },
      { name: 'inner', kind: 'method', startLine: 6, endLine: 8, container: 'Outer', exported: true },
      { name: 'run', kind: 'function', startLine: 11, endLine: 13, container: '', exported: true },
      { name: 'Shape', kind: 'interface', startLine: 15, endLine: 17, container: '', exported: false },
      { name: 'Alias', kind: 'type', startLine: 19, endLine: 19, container: '', exported: false },
      { name: 'Mode', kind: 'enum', startLine: 21, endLine: 24, container: '', exported: false },
      { name: 'local', kind: 'const', startLine: 26, endLine: 26, container: '', exported: false },
      { name: 'lazy', kind: 'const', startLine: 27, endLine: 27, container: '', exported: false },
    ]);
  });

  it('records every import form verbatim, without resolving it', async () => {
    const base = await root();
    await writeFile(path.join(base, 'sample.ts'), sample);

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['sample.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value[0]?.imports).toEqual([
      { specifier: 'node:fs/promises', kind: 'static', startLine: 1 },
      { specifier: './thing.js', kind: 're-export', startLine: 2 },
      { specifier: './legacy.cjs', kind: 'require', startLine: 26 },
      { specifier: './lazy.js', kind: 'dynamic', startLine: 27 },
    ]);
  });

  it('produces byte-identical records for the same tree and identity', async () => {
    const base = await root();
    await mkdir(path.join(base, 'src'));
    await writeFile(path.join(base, 'src', 'b.ts'), 'export const b = 1;\n');
    await writeFile(path.join(base, 'a.ts'), 'export const a = 2;\n');

    const first = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['src/b.ts', 'a.ts'] });
    const second = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['a.ts', 'src/b.ts'] });
    if (!first.ok || !second.ok) throw new Error('expected both extractions to succeed');

    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
    expect(first.value.map((record) => record.path)).toEqual(['a.ts', 'src/b.ts']);
  });

  it('keeps a record for a file that does not parse, with the parser message', async () => {
    const base = await root();
    await writeFile(path.join(base, 'broken.ts'), 'export class {\n');

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['broken.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.parseError).toMatch(/^line \d+: /);
    expect(result.value[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses a path outside the admitted root, and an absolute path', async () => {
    const base = await root();
    const elsewhere = await root();
    await writeFile(path.join(elsewhere, 'outside.ts'), 'export const x = 1;\n');

    const escaping = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['../outside.ts'] });
    expect(escaping).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const absolute = await extractStructuralRecords({
      repositoryRoot: base,
      identity,
      files: [path.join(elsewhere, 'outside.ts')],
    });
    expect(absolute).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('refuses a symlink that escapes the admitted root', async () => {
    const base = await root();
    const elsewhere = await root();
    await writeFile(path.join(elsewhere, 'outside.ts'), 'export const x = 1;\n');
    await symlink(path.join(elsewhere, 'outside.ts'), path.join(base, 'link.ts'));

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['link.ts'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('refuses a directory and an unsupported language', async () => {
    const base = await root();
    await mkdir(path.join(base, 'nested'));
    await writeFile(path.join(base, 'notes.md'), '# notes\n');

    const directory = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['nested'] });
    expect(directory).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const unsupported = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['notes.md'] });
    expect(unsupported).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('keeps absolute paths out of the record', async () => {
    const base = await root();
    await mkdir(path.join(base, 'src'));
    await writeFile(path.join(base, 'src', 'a.ts'), 'export function a(): void {}\n');

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['src/a.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value[0]?.path).toBe('src/a.ts');
    expect(JSON.stringify(result.value)).not.toContain(base);
  });

  it('refuses an unsupported extension before parsing', () => {
    const result = extractStructuralRecord({ path: 'a.py', identity, contents: 'print(1)' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
