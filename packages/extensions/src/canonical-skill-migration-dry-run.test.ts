import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  type CanonicalSkillMigrationStageResult,
} from './canonical-skill-migration-stager.js';
import { CanonicalSkillMigrationDryRunVerifier } from './canonical-skill-migration-dry-run.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
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
  body: string,
): Promise<{ readonly sourcePath: string; readonly fingerprint: string }> {
  const sourcePath = path.join(root, directoryName);
  await mkdir(sourcePath, { recursive: true });
  await writeFile(
    path.join(sourcePath, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Dry-run fixture\n---\n${body}\n`,
    'utf8',
  );
  await writeFile(path.join(sourcePath, 'helper.txt'), `helper:${directoryName}\n`, 'utf8');
  const fingerprint = await fingerprintCanonicalSkillDirectory(sourcePath);
  if (!fingerprint.ok) throw new Error(fingerprint.error.message);
  return { sourcePath, fingerprint: fingerprint.value };
}

function candidate(input: {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly sourcePath: string;
  readonly sourceClient: string;
  readonly enabled?: boolean;
  readonly platform?: NodeJS.Platform;
}): CanonicalExtensionMigrationCandidate {
  return {
    kind: 'skill',
    id: input.id,
    name: input.name,
    fingerprint: input.fingerprint,
    enabled: input.enabled ?? true,
    sourcePath: input.sourcePath,
    provenance: {
      originType: 'client-import',
      origin: input.sourcePath,
      sourceClient: input.sourceClient,
    },
    compatibility: { platforms: [input.platform ?? 'linux'] },
  };
}

function manifestFor(
  candidates: readonly CanonicalExtensionMigrationCandidate[],
): CanonicalExtensionMigrationManifest {
  const result = buildCanonicalExtensionMigrationManifest(candidates, {
    platform: 'linux',
    architecture: 'x64',
    availableCommands: new Set(['git']),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function stage(
  dataDir: string,
  manifest: CanonicalExtensionMigrationManifest,
): Promise<CanonicalSkillMigrationStageResult> {
  const staged = await new CanonicalSkillMigrationStager({ dataDir }).stage(manifest);
  if (!staged.ok) throw new Error(staged.error.message);
  return staged.value;
}

describe('CanonicalSkillMigrationDryRunVerifier', () => {
  it('proves exact staged catalog parity and preserves unrelated same-name skills as distinct canonical ids', async () => {
    const root = await fixtureRoot('canonical-skill-dry-run-parity-');
    const dataDir = path.join(root, 'data');
    const alpha = await createSkill(root, 'alpha-source', 'shared-name', '# Alpha');
    const beta = await createSkill(root, 'beta-source', 'shared-name', '# Beta');
    const disabled = await createSkill(root, 'disabled-source', 'disabled', '# Disabled');
    const windowsOnly = await createSkill(root, 'windows-source', 'windows-only', '# Windows');

    const manifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'shared-name',
        fingerprint: alpha.fingerprint,
        sourcePath: alpha.sourcePath,
        sourceClient: 'cline',
      }),
      candidate({
        id: 'skill:beta',
        name: 'shared-name',
        fingerprint: beta.fingerprint,
        sourcePath: beta.sourcePath,
        sourceClient: 'codex',
      }),
      candidate({
        id: 'skill:disabled',
        name: 'disabled',
        fingerprint: disabled.fingerprint,
        sourcePath: disabled.sourcePath,
        sourceClient: 'cline',
        enabled: false,
      }),
      candidate({
        id: 'skill:windows-only',
        name: 'windows-only',
        fingerprint: windowsOnly.fingerprint,
        sourcePath: windowsOnly.sourcePath,
        sourceClient: 'cline',
        platform: 'win32',
      }),
    ]);
    expect(manifest.cutover.allowed).toBe(true);

    const staged = await stage(dataDir, manifest);
    const result = await new CanonicalSkillMigrationDryRunVerifier().verify(manifest, staged);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exactParity).toBe(true);
    expect(result.value.generationId).toBe(staged.generationId);
    expect(result.value.resolved.map((entry) => entry.canonicalId)).toEqual([
      'skill:alpha',
      'skill:beta',
    ]);
    expect(result.value.resolved.map((entry) => entry.name)).toEqual([
      'shared-name',
      'shared-name',
    ]);
    expect(new Set(result.value.resolved.map((entry) => entry.catalogSkillId)).size).toBe(2);
    expect(result.value.skipped).toEqual(staged.skipped);
  });

  it('fails closed when a staged skill disappears after staging', async () => {
    const root = await fixtureRoot('canonical-skill-dry-run-missing-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'missing', '# Missing');
    const manifest = manifestFor([
      candidate({
        id: 'skill:missing',
        name: 'missing',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
        sourceClient: 'cline',
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    await rm(
      path.join(staged.generationPath, staged.stagedSkills[0]!.relativePath),
      { recursive: true, force: true },
    );

    const result = await new CanonicalSkillMigrationDryRunVerifier().verify(manifest, staged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('parity');
    }
  });

  it('fails closed when an extra staged skill is discoverable by the canonical catalog', async () => {
    const root = await fixtureRoot('canonical-skill-dry-run-extra-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'expected', '# Expected');
    const extra = await createSkill(root, 'extra-source', 'unexpected', '# Unexpected');
    const manifest = manifestFor([
      candidate({
        id: 'skill:expected',
        name: 'expected',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
        sourceClient: 'cline',
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    await cp(extra.sourcePath, path.join(staged.generationPath, 'skills', 'unexpected-extra'), {
      recursive: true,
    });

    const result = await new CanonicalSkillMigrationDryRunVerifier().verify(manifest, staged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('parity');
    }
  });

  it('fails closed when staged content no longer matches its expected fingerprint', async () => {
    const root = await fixtureRoot('canonical-skill-dry-run-drift-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'drifted', '# Drifted');
    const manifest = manifestFor([
      candidate({
        id: 'skill:drifted',
        name: 'drifted',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
        sourceClient: 'cline',
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    await writeFile(
      path.join(staged.generationPath, staged.stagedSkills[0]!.relativePath, 'helper.txt'),
      'tampered after staging\n',
      'utf8',
    );

    const result = await new CanonicalSkillMigrationDryRunVerifier().verify(manifest, staged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('fingerprint');
    }
  });

  it('fails closed when the staged generation id is not bound to the supplied manifest', async () => {
    const root = await fixtureRoot('canonical-skill-dry-run-generation-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'generation', '# Generation');
    const manifest = manifestFor([
      candidate({
        id: 'skill:generation',
        name: 'generation',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
        sourceClient: 'cline',
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const mismatched: CanonicalSkillMigrationStageResult = {
      ...staged,
      generationId: 'f'.repeat(64),
    };

    const result = await new CanonicalSkillMigrationDryRunVerifier().verify(manifest, mismatched);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('generation');
    }
  });

  it('fails closed when stage metadata does not match the manifest active set', async () => {
    const root = await fixtureRoot('canonical-skill-dry-run-metadata-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'metadata', '# Metadata');
    const manifest = manifestFor([
      candidate({
        id: 'skill:metadata',
        name: 'metadata',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
        sourceClient: 'cline',
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const mismatched: CanonicalSkillMigrationStageResult = {
      ...staged,
      stagedSkills: [],
    };

    const result = await new CanonicalSkillMigrationDryRunVerifier().verify(manifest, mismatched);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('metadata');
    }
  });
});
