import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const script = path.resolve('scripts/check-workspace-dependencies.mjs');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace runtime dependency integrity', () => {
  it('accepts the repository runtime dependency graph', () => {
    const result = spawnSync(process.execPath, [script, '--root', process.cwd()], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Workspace runtime dependency audit passed');
  });

  it('fails when a workspace package imports an undeclared internal runtime dependency', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-dependency-audit-'));
    roots.push(root);
    await mkdir(path.join(root, 'packages', 'consumer', 'src'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'provider', 'src'), { recursive: true });
    await writeFile(path.join(root, 'packages', 'consumer', 'package.json'), JSON.stringify({
      name: '@unified-mpc/consumer',
      dependencies: {},
    }));
    await writeFile(path.join(root, 'packages', 'provider', 'package.json'), JSON.stringify({
      name: '@unified-mpc/provider',
    }));
    await writeFile(path.join(root, 'packages', 'consumer', 'src', 'index.ts'), "import { value } from '@unified-mpc/provider';\nexport { value };\n");
    await writeFile(path.join(root, 'packages', 'provider', 'src', 'index.ts'), 'export const value = 1;\n');

    const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@unified-mpc/consumer imports @unified-mpc/provider');
  });
});
