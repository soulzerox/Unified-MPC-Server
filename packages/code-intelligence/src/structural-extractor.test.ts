import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

  it('refuses an absolute path even when it resolves inside the admitted root', async () => {
    const base = await root();
    await writeFile(path.join(base, 'a.ts'), 'export const a = 1;\n');

    const absolute = await extractStructuralRecords({
      repositoryRoot: base,
      identity,
      files: [path.join(base, 'a.ts')],
    });
    expect(absolute).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    if (absolute.ok) throw new Error('expected a refusal');
    expect(absolute.error.message).toMatch(/absolute/);
  });

  it('admits a legal file whose name starts with two dots, and refuses the root itself', async () => {
    const base = await root();
    await writeFile(path.join(base, '..foo.ts'), 'export const foo = 1;\n');

    const dotted = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['..foo.ts'] });
    if (!dotted.ok) throw new Error(dotted.error.message);
    expect(dotted.value.map((record) => record.path)).toEqual(['..foo.ts']);

    const itself = await extractStructuralRecords({ repositoryRoot: base, identity, files: [''] });
    expect(itself).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    if (itself.ok) throw new Error('expected a refusal');
    expect(itself.error.message).toMatch(/root/);
  });

  it('admits an in-root file when the repository root is reached through a symlink', async () => {
    const base = await root();
    const linked = `${base}-link`;
    await symlink(base, linked);
    created.push(linked);
    await writeFile(path.join(base, 'a.ts'), 'export const a = 1;\n');
    const elsewhere = await root();
    await writeFile(path.join(elsewhere, 'outside.ts'), 'export const x = 1;\n');

    const inRoot = await extractStructuralRecords({ repositoryRoot: linked, identity, files: ['a.ts'] });
    if (!inRoot.ok) throw new Error(inRoot.error.message);
    expect(inRoot.value.map((record) => record.path)).toEqual(['a.ts']);

    const escaping = await extractStructuralRecords({ repositoryRoot: linked, identity, files: ['../outside.ts'] });
    expect(escaping).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('orders records by the path they carry, not by the raw input', async () => {
    const base = await root();
    await writeFile(path.join(base, 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(base, 'b.ts'), 'export const b = 1;\n');

    // `./b.ts` sorts before `a.ts` as a raw string, but its record is `b.ts`.
    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['./b.ts', 'a.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.map((record) => record.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('emits one record for an input that names the same admitted path twice', async () => {
    const base = await root();
    await writeFile(path.join(base, 'a.ts'), 'export const a = 1;\n');

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['a.ts', './a.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.map((record) => record.path)).toEqual(['a.ts']);
  });

  it('fingerprints the bytes read, so a BOM cannot be shared with its BOM-less twin', async () => {
    const base = await root();
    const plain = Buffer.from('export const a = 1;\n', 'utf8');
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
    await writeFile(path.join(base, 'plain.ts'), plain);
    await writeFile(path.join(base, 'bom.ts'), withBom);

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['plain.ts', 'bom.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    const byPath = new Map(result.value.map((record) => [record.path, record]));
    expect(byPath.get('bom.ts')?.fingerprint).toBe(`sha256:${createHash('sha256').update(withBom).digest('hex')}`);
    expect(byPath.get('plain.ts')?.fingerprint).not.toBe(byPath.get('bom.ts')?.fingerprint);
  });

  it('sorts paths by code unit, not the process locale', async () => {
    const base = await root();
    await writeFile(path.join(base, 'zebra.ts'), 'export const z = 1;\n');
    await writeFile(path.join(base, 'äpple.ts'), 'export const a = 1;\n');

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['äpple.ts', 'zebra.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    // `localeCompare` under `en` puts `äpple` before `zebra`; code-unit order does not.
    expect(result.value.map((record) => record.path)).toEqual(['zebra.ts', 'äpple.ts']);
  });

  it('refuses a file that is not valid UTF-8 instead of hashing substituted text', async () => {
    const base = await root();
    await writeFile(path.join(base, 'broken.ts'), Buffer.from([0x65, 0x78, 0x70, 0xff, 0x0a]));

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['broken.ts'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('keeps the admitted path for an in-tree symlink', async () => {
    const base = await root();
    await writeFile(path.join(base, 'real.ts'), 'export const x = 1;\n');
    await symlink(path.join(base, 'real.ts'), path.join(base, 'link.ts'));

    const result = await extractStructuralRecords({ repositoryRoot: base, identity, files: ['link.ts'] });
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.map((record) => record.path)).toEqual(['link.ts']);
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
