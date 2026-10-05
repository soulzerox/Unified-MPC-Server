import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonicalExtensionMigrationManifest,
  type CanonicalExtensionMigrationCandidate,
  type CanonicalExtensionMigrationManifest,
} from './canonical-extension-migration-manifest.js';
import {
  CanonicalSkillMigrationStager,
  fingerprintCanonicalSkillDirectory,
} from './canonical-skill-migration-stager.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryRoots.push(root);
  return root;
}

async function createSkill(
  root: string,
  directoryName: string,
  skillName: string,
  body = '# Skill\n',
): Promise<{ readonly sourcePath: string; readonly fingerprint: string }> {
  const sourcePath = path.join(root, directoryName);
  await mkdir(sourcePath, { recursive: true });
  await writeFile(
    path.join(sourcePath, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Migration fixture\n---\n${body}`,
    'utf8',
  );
  await writeFile(path.join(sourcePath, 'helper.txt'), `helper:${skillName}\n`, 'utf8');
  const fingerprint = await fingerprintCanonicalSkillDirectory(sourcePath);
  if (!fingerprint.ok) throw new Error(fingerprint.error.message);
  return { sourcePath, fingerprint: fingerprint.value };
}

function manifestFor(candidates: readonly CanonicalExtensionMigrationCandidate[]): CanonicalExtensionMigrationManifest {
  const result = buildCanonicalExtensionMigrationManifest(candidates, {
    platform: 'linux',
    architecture: 'x64',
    availableCommands: new Set(['git']),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function candidate(input: {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly sourcePath?: string;
  readonly enabled?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly sourceClient?: string;
}): CanonicalExtensionMigrationCandidate {
  const origin = input.sourcePath ?? `/missing/${input.name}`;
  return {
    kind: 'skill',
    id: input.id,
    name: input.name,
    fingerprint: input.fingerprint,
    enabled: input.enabled ?? true,
    provenance: {
      originType: 'client-import',
      origin,
      sourceClient: input.sourceClient ?? 'cline',
    },
    compatibility: { platforms: [input.platform ?? 'linux'] },
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
  };
}

describe('CanonicalSkillMigrationStager', () => {
  it('stages one deterministic inactive generation and reuses it idempotently', async () => {
    const root = await fixtureRoot('canonical-skill-stage-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'cline-copy', 'code-review');
    const secondSource = await createSkill(root, 'codex-copy', 'code-review');

    const manifest = manifestFor([
      candidate({
        id: 'skill:code-review',
        name: 'code-review',
        fingerprint: secondSource.fingerprint,
        sourcePath: secondSource.sourcePath,
        sourceClient: 'codex',
      }),
      candidate({
        id: 'skill:code-review',
        name: 'code-review',
        fingerprint: firstSource.fingerprint,
        sourcePath: firstSource.sourcePath,
        sourceClient: 'cline',
      }),
    ]);
    expect(firstSource.fingerprint).toBe(secondSource.fingerprint);

    const stager = new CanonicalSkillMigrationStager({ dataDir });
    const first = await stager.stage(manifest);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.reused).toBe(false);
    expect(first.value.stagedSkills).toHaveLength(1);
    expect(first.value.stagedSkills[0]).toMatchObject({
      id: 'skill:code-review',
      fingerprint: firstSource.fingerprint,
      sourcePath: firstSource.sourcePath,
    });
    expect(first.value.generationId).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(
      path.join(first.value.generationPath, first.value.stagedSkills[0]!.relativePath, 'SKILL.md'),
      'utf8',
    )).toContain('name: code-review');
    await expect(stat(path.join(dataDir, 'extensions', 'skills'))).rejects.toThrow();

    const again = await stager.stage(manifest);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.reused).toBe(true);
    expect(again.value.generationId).toBe(first.value.generationId);
    expect(again.value.generationPath).toBe(first.value.generationPath);
  });

  it('fails closed when an existing staged generation has been modified', async () => {
    const root = await fixtureRoot('canonical-skill-stage-corrupt-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'corrupt-me');
    const manifest = manifestFor([
      candidate({
        id: 'skill:corrupt-me',
        name: 'corrupt-me',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);

    const stager = new CanonicalSkillMigrationStager({ dataDir });
    const first = await stager.stage(manifest);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stagedSkill = first.value.stagedSkills[0]!;
    await writeFile(
      path.join(first.value.generationPath, stagedSkill.relativePath, 'helper.txt'),
      'tampered staged content\n',
      'utf8',
    );

    const again = await stager.stage(manifest);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('INVALID_INPUT');
      expect(again.error.message).toContain('fingerprint');
    }
    expect(await readFile(
      path.join(first.value.generationPath, stagedSkill.relativePath, 'helper.txt'),
      'utf8',
    )).toBe('tampered staged content\n');
  });

  it('aborts on source drift before publishing a staged generation', async () => {
    const root = await fixtureRoot('canonical-skill-stage-drift-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'drifted');
    const manifest = manifestFor([
      candidate({
        id: 'skill:drifted',
        name: 'drifted',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);

    await writeFile(path.join(source.sourcePath, 'helper.txt'), 'changed after inventory\n', 'utf8');
    const result = await new CanonicalSkillMigrationStager({ dataDir }).stage(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('fingerprint');
    }

    const stagedRoot = path.join(dataDir, 'extensions', 'state', 'migration', 'staged-generations');
    const entries = await readdir(stagedRoot).catch(() => []);
    expect(entries.filter((entry) => !entry.startsWith('.tmp-'))).toEqual([]);
  });

  it('refuses a blocked manifest without publishing any generation', async () => {
    const root = await fixtureRoot('canonical-skill-stage-conflict-');
    const dataDir = path.join(root, 'data');
    const first = await createSkill(root, 'first', 'conflicted', '# First\n');
    const second = await createSkill(root, 'second', 'conflicted', '# Second\n');
    expect(first.fingerprint).not.toBe(second.fingerprint);

    const manifest = manifestFor([
      candidate({
        id: 'skill:conflicted',
        name: 'conflicted',
        fingerprint: first.fingerprint,
        sourcePath: first.sourcePath,
      }),
      candidate({
        id: 'skill:conflicted',
        name: 'conflicted',
        fingerprint: second.fingerprint,
        sourcePath: second.sourcePath,
        sourceClient: 'codex',
      }),
    ]);
    expect(manifest.cutover.allowed).toBe(false);

    const result = await new CanonicalSkillMigrationStager({ dataDir }).stage(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cutover blockers');
    await expect(stat(path.join(dataDir, 'extensions', 'state', 'migration', 'staged-generations'))).rejects.toThrow();
  });

  it('stages only compatible active skills while recording safe skips', async () => {
    const root = await fixtureRoot('canonical-skill-stage-filter-');
    const dataDir = path.join(root, 'data');
    const active = await createSkill(root, 'active', 'active');
    const windowsOnly = await createSkill(root, 'windows', 'windows-only');
    const disabled = await createSkill(root, 'disabled', 'disabled');

    const manifest = manifestFor([
      candidate({
        id: 'skill:active',
        name: 'active',
        fingerprint: active.fingerprint,
        sourcePath: active.sourcePath,
      }),
      candidate({
        id: 'skill:windows-only',
        name: 'windows-only',
        fingerprint: windowsOnly.fingerprint,
        sourcePath: windowsOnly.sourcePath,
        platform: 'win32',
      }),
      candidate({
        id: 'skill:disabled',
        name: 'disabled',
        fingerprint: disabled.fingerprint,
        sourcePath: disabled.sourcePath,
        enabled: false,
      }),
    ]);
    expect(manifest.cutover.allowed).toBe(true);

    const result = await new CanonicalSkillMigrationStager({ dataDir }).stage(manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stagedSkills.map((skill) => skill.id)).toEqual(['skill:active']);
    expect(result.value.skipped).toEqual([
      { id: 'skill:disabled', reason: 'disabled' },
      { id: 'skill:windows-only', reason: 'incompatible' },
    ]);
  });

  it('fails closed when an eligible manifest source has no local source path', async () => {
    const root = await fixtureRoot('canonical-skill-stage-no-path-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'no-path');
    const manifest = manifestFor([
      candidate({
        id: 'skill:no-path',
        name: 'no-path',
        fingerprint: source.fingerprint,
      }),
    ]);

    const result = await new CanonicalSkillMigrationStager({ dataDir }).stage(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('source path');
    }
  });
});
