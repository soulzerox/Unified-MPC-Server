import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBuildProvenance } from './build-provenance.js';

const roots: string[] = [];

async function fixture(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-build-provenance-'));
  roots.push(root);
  const file = path.join(root, 'build-provenance.json');
  await writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('build provenance loader', () => {
  it('loads a build artifact whose semantic version matches the runtime', async () => {
    const provenance = {
      version: '4.61.0',
      buildVersion: '4.61.0+0123456789ab',
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
      buildShortCommit: '0123456789ab',
      buildTime: '2026-09-21T09:00:00.000Z',
      buildDirty: false,
    };
    expect(loadBuildProvenance(await fixture(provenance))).toEqual(provenance);
  });

  it('rejects stale or internally inconsistent build artifacts', async () => {
    const stale = await fixture({
      version: '4.60.0',
      buildVersion: '4.60.0+0123456789ab',
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
      buildShortCommit: '0123456789ab',
      buildTime: '2026-09-21T09:00:00.000Z',
      buildDirty: false,
    });
    expect(() => loadBuildProvenance(stale)).toThrow('version mismatch');

    const inconsistent = await fixture({
      version: '4.61.0',
      buildVersion: '4.61.0+ffffffffffff',
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
      buildShortCommit: '0123456789ab',
      buildTime: '2026-09-21T09:00:00.000Z',
      buildDirty: false,
    });
    expect(() => loadBuildProvenance(inconsistent)).toThrow('Invalid Unified build version');
  });
});
