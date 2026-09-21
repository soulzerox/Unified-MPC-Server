import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('build provenance generator', () => {
  it('captures the checkout commit and honors SOURCE_DATE_EPOCH deterministically', async () => {
    const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    const expectedCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-build-generator-'));
    roots.push(temporaryRoot);
    const outputPath = path.join(temporaryRoot, 'build-provenance.json');

    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'generate-build-provenance.mjs'),
      outputPath,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, SOURCE_DATE_EPOCH: '1234567890' },
      encoding: 'utf8',
    });

    const provenance = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(provenance).toMatchObject({
      version: '4.61.0',
      buildCommit: expectedCommit,
      buildShortCommit: expectedCommit.slice(0, 12),
      buildTime: '2009-02-13T23:31:30.000Z',
      buildDirty: false,
      buildVersion: `4.61.0+${expectedCommit.slice(0, 12)}`,
    });
  });
});
