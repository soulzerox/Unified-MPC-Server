import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const generator = path.resolve('scripts/generate-typecheck-configs.mjs');
const freshness = path.resolve('scripts/check-dist-provenance-freshness.mjs');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace typecheck emit isolation', () => {
  it('keeps the committed typecheck configuration in sync with the project graph', () => {
    const result = spawnSync(process.execPath, [generator, '--check', '--root', process.cwd()], { encoding: 'utf8' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Typecheck configuration is up to date');
  });

  it('redirects every project emit outside its deployed dist directory', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
      files: [],
      references: [{ path: './packages/provider' }, { path: './apps/consumer' }],
    }));
    await writePackage(root, 'packages/provider', {});
    await writePackage(root, 'apps/consumer', { references: [{ path: '../../packages/provider' }] });

    const result = spawnSync(process.execPath, [generator, '--root', root], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);

    const consumer = JSON.parse(await readFile(path.join(root, 'apps/consumer/tsconfig.typecheck.json')));
    expect(consumer.compilerOptions.outDir).toBe('../../.typecheck/apps/consumer');
    expect(consumer.compilerOptions.emitDeclarationOnly).toBe(true);
    expect(consumer.compilerOptions.outDir).not.toContain('dist');
    expect(consumer.references).toEqual([{ path: '../../packages/provider/tsconfig.typecheck.json' }]);

    const solution = JSON.parse(await readFile(path.join(root, 'tsconfig.typecheck.json')));
    expect(solution.references).toEqual([
      { path: './packages/provider/tsconfig.typecheck.json' },
      { path: './apps/consumer/tsconfig.typecheck.json' },
    ]);

    const check = spawnSync(process.execPath, [generator, '--check', '--root', root], { encoding: 'utf8' });
    expect(check.status).toBe(0);

    await writeFile(path.join(root, 'packages/provider/tsconfig.json'), JSON.stringify({
      compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist' },
      references: [{ path: '../extra' }],
      include: ['src/**/*.ts'],
    }));
    await writePackage(root, 'packages/extra', {});
    const stale = spawnSync(process.execPath, [generator, '--check', '--root', root], { encoding: 'utf8' });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('packages/provider/tsconfig.typecheck.json');
  });
});

describe('deployment provenance freshness', () => {
  it('reports a deployment whose artifacts are newer than its provenance', async () => {
    const root = await fixtureRoot();
    const provenanceTime = new Date('2026-10-28T00:45:47Z');
    await writeDeployment(root, 'apps/cli', provenanceTime);
    const artifactTime = new Date(provenanceTime.getTime() + 60_000);
    await utimes(path.join(root, 'apps/cli/dist/index.js'), artifactTime, artifactTime);

    const result = spawnSync(process.execPath, [freshness, '--root', root], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stale deployment artifacts');
    expect(result.stderr).toContain('apps/cli/dist/index.js');
    expect(result.stderr).toContain('buildVersion 4.61.0+8bf6c80d8a35');
  });

  it('accepts a fresh deployment and skips directories without provenance', async () => {
    const root = await fixtureRoot();
    const provenanceTime = new Date('2026-10-28T00:45:47Z');
    await writeDeployment(root, 'apps/cli', provenanceTime);
    await utimes(path.join(root, 'apps/cli/dist/index.js'), new Date(provenanceTime.getTime() - 1_000), new Date(provenanceTime.getTime() - 1_000));
    await mkdir(path.join(root, 'packages/thai-rag/dist'), { recursive: true });

    const result = spawnSync(process.execPath, [freshness, '--root', root], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Deployment provenance is fresh: apps/cli/dist/build-provenance.json');
  });

  it('treats a sub-second write race as fresh but a later rewrite as stale', async () => {
    const root = await fixtureRoot();
    const provenanceTime = new Date('2026-10-28T00:45:47.000Z');
    await writeDeployment(root, 'apps/cli', provenanceTime);
    await utimes(path.join(root, 'apps/cli/dist/index.js'), provenanceTime, provenanceTime);

    const withinTolerance = spawnSync(process.execPath, [freshness, '--root', root, '--tolerance-ms', '2000'], { encoding: 'utf8' });
    expect(withinTolerance.status, withinTolerance.stderr).toBe(0);

    await utimes(path.join(root, 'apps/cli/dist/index.js'), new Date(provenanceTime.getTime() + 5), new Date(provenanceTime.getTime() + 5));
    const rewritten = spawnSync(process.execPath, [freshness, '--root', root, '--tolerance-ms', '0'], { encoding: 'utf8' });
    expect(rewritten.status).toBe(1);
    expect(rewritten.stderr).toContain('apps/cli/dist/index.js');
  });

  it('reports nothing to verify when no deployment has provenance', async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, 'apps/cli/dist'), { recursive: true });

    const result = spawnSync(process.execPath, [freshness, '--root', root, '--tolerance-ms', '0'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('nothing to verify');
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-typecheck-'));
  roots.push(root);
  return root;
}

async function writePackage(root: string, relativePath: string, options: { references?: Array<{ path: string }> }): Promise<void> {
  const directory = path.join(root, relativePath);
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@unified-mpc/${path.basename(relativePath)}` }));
  await writeFile(path.join(directory, 'src', 'index.ts'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { composite: true, declaration: true, rootDir: 'src', outDir: 'dist' },
    ...(options.references === undefined ? {} : { references: options.references }),
    include: ['src/**/*.ts'],
  }));
}

async function writeDeployment(root: string, relativePath: string, provenanceTime: Date): Promise<void> {
  const dist = path.join(root, relativePath, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'build-provenance.json'), JSON.stringify({
    version: '4.61.0',
    buildVersion: '4.61.0+8bf6c80d8a35',
    buildCommit: '8bf6c80d8a35ffffffffffffffffffffffffffff',
    buildShortCommit: '8bf6c80d8a35',
    buildTime: provenanceTime.toISOString(),
    buildDirty: false,
  }));
  await writeFile(path.join(dist, 'index.js'), 'export const value = 1;\n');
  await utimes(path.join(dist, 'build-provenance.json'), provenanceTime, provenanceTime);
  await utimes(path.join(dist, 'index.js'), new Date(provenanceTime.getTime() - 60_000), new Date(provenanceTime.getTime() - 60_000));
}
