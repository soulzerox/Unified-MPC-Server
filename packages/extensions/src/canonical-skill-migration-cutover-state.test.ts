import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { CanonicalSkillMigrationCutoverStateStore } from './canonical-skill-migration-cutover-state.js';

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
    `---\nname: ${skillName}\ndescription: Cutover fixture\n---\n${body}\n`,
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
  readonly sourceClient?: string;
}): CanonicalExtensionMigrationCandidate {
  return {
    kind: 'skill',
    id: input.id,
    name: input.name,
    fingerprint: input.fingerprint,
    enabled: true,
    sourcePath: input.sourcePath,
    provenance: {
      originType: 'client-import',
      origin: input.sourcePath,
      sourceClient: input.sourceClient ?? 'cline',
    },
    compatibility: { platforms: ['linux'] },
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
  const result = await new CanonicalSkillMigrationStager({ dataDir }).stage(manifest);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('CanonicalSkillMigrationCutoverStateStore', () => {
  it('activates a verified staged generation atomically without touching the runtime skill root', async () => {
    const root = await fixtureRoot('canonical-cutover-first-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);
    const staged = await stage(dataDir, manifest);

    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const activated = await store.activate(manifest, staged);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.value.changed).toBe(true);
    expect(activated.value.state).toEqual({
      schemaVersion: 1,
      activeGenerationId: staged.generationId,
    });

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(activated.value.state);

    const statePath = path.join(dataDir, 'extensions', 'state', 'migration', 'cutover-state.json');
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(activated.value.state);
    await expect(stat(path.join(dataDir, 'extensions', 'skills'))).rejects.toThrow();
  });

  it('reuses the same active generation idempotently without inventing rollback history', async () => {
    const root = await fixtureRoot('canonical-cutover-idempotent-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'same', '# Same');
    const manifest = manifestFor([
      candidate({
        id: 'skill:same',
        name: 'same',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });

    const first = await store.activate(manifest, staged);
    const second = await store.activate(manifest, staged);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.changed).toBe(true);
    expect(second.value.changed).toBe(false);
    expect(second.value.state).toEqual(first.value.state);
    expect(second.value.state.previousGenerationId).toBeUndefined();
  });

  it('preserves the previously active generation for rollback when activating a new generation', async () => {
    const root = await fixtureRoot('canonical-cutover-history-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'source-a', 'alpha', '# Alpha');
    const firstManifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: firstSource.fingerprint,
        sourcePath: firstSource.sourcePath,
      }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);

    const secondSource = await createSkill(root, 'source-b', 'beta', '# Beta');
    const secondManifest = manifestFor([
      candidate({
        id: 'skill:beta',
        name: 'beta',
        fingerprint: secondSource.fingerprint,
        sourcePath: secondSource.sourcePath,
        sourceClient: 'codex',
      }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);

    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const first = await store.activate(firstManifest, firstStage);
    expect(first.ok).toBe(true);

    const second = await store.activate(secondManifest, secondStage);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.changed).toBe(true);
    expect(second.value.state).toEqual({
      schemaVersion: 1,
      activeGenerationId: secondStage.generationId,
      previousGenerationId: firstStage.generationId,
    });
  });

  it('fails closed on staged content drift and preserves the current active pointer', async () => {
    const root = await fixtureRoot('canonical-cutover-drift-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'source-a', 'alpha', '# Alpha');
    const firstManifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: firstSource.fingerprint,
        sourcePath: firstSource.sourcePath,
      }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const first = await store.activate(firstManifest, firstStage);
    expect(first.ok).toBe(true);

    const secondSource = await createSkill(root, 'source-b', 'beta', '# Beta');
    const secondManifest = manifestFor([
      candidate({
        id: 'skill:beta',
        name: 'beta',
        fingerprint: secondSource.fingerprint,
        sourcePath: secondSource.sourcePath,
      }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    await writeFile(
      path.join(secondStage.generationPath, secondStage.stagedSkills[0]!.relativePath, 'helper.txt'),
      'tampered after dry-run staging\n',
      'utf8',
    );

    const activation = await store.activate(secondManifest, secondStage);
    expect(activation.ok).toBe(false);
    if (!activation.ok) expect(activation.error.message).toContain('fingerprint');

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !first.ok) return;
    expect(loaded.value).toEqual(first.value.state);
  });

  it('fails closed instead of replacing a corrupt persisted cutover state', async () => {
    const root = await fixtureRoot('canonical-cutover-corrupt-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const statePath = path.join(dataDir, 'extensions', 'state', 'migration', 'cutover-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, '{"schemaVersion":1,"activeGenerationId":"not-a-sha"}\n', 'utf8');

    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const activation = await store.activate(manifest, staged);
    expect(activation.ok).toBe(false);
    if (!activation.ok) {
      expect(activation.error.code).toBe('INVALID_INPUT');
      expect(activation.error.message).toContain('cutover state');
    }
    expect(await readFile(statePath, 'utf8')).toContain('not-a-sha');
  });

  it('resolves an active generation only after revalidating persisted generation metadata and fingerprints', async () => {
    const root = await fixtureRoot('canonical-cutover-resolve-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const activated = await store.activate(manifest, staged);
    expect(activated.ok).toBe(true);

    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({
      state: {
        schemaVersion: 1,
        activeGenerationId: staged.generationId,
      },
      generationPath: staged.generationPath,
      managedRoot: path.join(staged.generationPath, 'skills'),
      stagedSkills: staged.stagedSkills,
    });
  });

  it('fails closed when an already-active generation is corrupted after activation', async () => {
    const root = await fixtureRoot('canonical-cutover-resolve-corrupt-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const activated = await store.activate(manifest, staged);
    expect(activated.ok).toBe(true);

    await writeFile(
      path.join(staged.generationPath, staged.stagedSkills[0]!.relativePath, 'helper.txt'),
      'corrupt after activation\n',
      'utf8',
    );

    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('INVALID_INPUT');
      expect(resolved.error.message).toContain('fingerprint');
    }
  });

  it('reports legacy as the rollback target after the first canonical cutover without mutating state', async () => {
    const root = await fixtureRoot('canonical-cutover-target-legacy-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: source.fingerprint, sourcePath: source.sourcePath }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const activated = await store.activate(manifest, staged);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;

    const target = await store.resolveRollbackTarget();
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.value).toEqual({
      target: 'legacy',
      fromGenerationId: staged.generationId,
    });

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(activated.value.state);
  });

  it('verifies the previous canonical generation as a rollback target without changing the active pointer', async () => {
    const root = await fixtureRoot('canonical-cutover-target-canonical-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'source-a', 'alpha', '# Alpha');
    const firstManifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: firstSource.fingerprint, sourcePath: firstSource.sourcePath }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondSource = await createSkill(root, 'source-b', 'beta', '# Beta');
    const secondManifest = manifestFor([
      candidate({ id: 'skill:beta', name: 'beta', fingerprint: secondSource.fingerprint, sourcePath: secondSource.sourcePath }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(firstManifest, firstStage)).ok).toBe(true);
    const second = await store.activate(secondManifest, secondStage);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const target = await store.resolveRollbackTarget();
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.value).toMatchObject({
      target: 'canonical',
      fromGenerationId: secondStage.generationId,
      toGenerationId: firstStage.generationId,
      generation: {
        state: {
          schemaVersion: 1,
          activeGenerationId: firstStage.generationId,
          previousGenerationId: secondStage.generationId,
        },
        generationPath: firstStage.generationPath,
        managedRoot: path.join(firstStage.generationPath, 'skills'),
        stagedSkills: firstStage.stagedSkills,
      },
    });

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(second.value.state);
  });

  it('rolls back atomically to a verified previous generation and swaps rollback history', async () => {
    const root = await fixtureRoot('canonical-cutover-rollback-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'source-a', 'alpha', '# Alpha');
    const firstManifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: firstSource.fingerprint, sourcePath: firstSource.sourcePath }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondSource = await createSkill(root, 'source-b', 'beta', '# Beta');
    const secondManifest = manifestFor([
      candidate({ id: 'skill:beta', name: 'beta', fingerprint: secondSource.fingerprint, sourcePath: secondSource.sourcePath }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(firstManifest, firstStage)).ok).toBe(true);
    expect((await store.activate(secondManifest, secondStage)).ok).toBe(true);

    const rolledBack = await store.rollback(secondStage.generationId);
    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.value).toEqual({
      target: 'canonical',
      fromGenerationId: secondStage.generationId,
      toGenerationId: firstStage.generationId,
      state: {
        schemaVersion: 1,
        activeGenerationId: firstStage.generationId,
        previousGenerationId: secondStage.generationId,
      },
    });

    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value?.state).toEqual(rolledBack.value.state);
    expect(resolved.value?.generationPath).toBe(firstStage.generationPath);
  });

  it('rolls the first canonical cutover back to legacy mode without touching staged or live roots', async () => {
    const root = await fixtureRoot('canonical-cutover-rollback-legacy-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: source.fingerprint, sourcePath: source.sourcePath }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const activated = await store.activate(manifest, staged);
    expect(activated.ok).toBe(true);

    const stagedSkillPath = path.join(
      staged.generationPath,
      staged.stagedSkills[0]!.relativePath,
      'SKILL.md',
    );
    const stagedSkillBeforeRollback = await readFile(stagedSkillPath, 'utf8');

    const rolledBack = await store.rollback(staged.generationId);
    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.value).toEqual({
      target: 'legacy',
      fromGenerationId: staged.generationId,
    });

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBeUndefined();
    expect((await stat(staged.generationPath)).isDirectory()).toBe(true);
    expect(await readFile(stagedSkillPath, 'utf8')).toBe(stagedSkillBeforeRollback);
    await expect(stat(path.join(dataDir, 'extensions', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes concurrent first-cutover rollback retry-safe and leaves legacy mode active', async () => {
    const root = await fixtureRoot('canonical-cutover-rollback-legacy-concurrent-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: source.fingerprint, sourcePath: source.sourcePath }),
    ]);
    const staged = await stage(dataDir, manifest);
    const firstStore = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const secondStore = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    expect((await firstStore.activate(manifest, staged)).ok).toBe(true);

    const stagedSkillPath = path.join(
      staged.generationPath,
      staged.stagedSkills[0]!.relativePath,
      'SKILL.md',
    );
    const stagedSkillBeforeRollback = await readFile(stagedSkillPath, 'utf8');

    const results = await Promise.all([
      firstStore.rollback(staged.generationId),
      secondStore.rollback(staged.generationId),
    ]);
    const successful = results.filter((result) => result.ok);
    expect(successful).toHaveLength(1);
    expect(successful[0]?.ok && successful[0].value).toEqual({
      target: 'legacy',
      fromGenerationId: staged.generationId,
    });
    const rejected = results.find((result) => !result.ok);
    expect(rejected?.ok).toBe(false);
    if (rejected !== undefined && !rejected.ok) {
      expect(rejected.error.code).toBe('CONFLICT');
    }

    const loaded = await firstStore.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBeUndefined();
    expect((await stat(staged.generationPath)).isDirectory()).toBe(true);
    expect(await readFile(stagedSkillPath, 'utf8')).toBe(stagedSkillBeforeRollback);
    await expect(stat(path.join(dataDir, 'extensions', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the previous generation is corrupt and preserves the active pointer', async () => {
    const root = await fixtureRoot('canonical-cutover-rollback-corrupt-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'source-a', 'alpha', '# Alpha');
    const firstManifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: firstSource.fingerprint, sourcePath: firstSource.sourcePath }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondSource = await createSkill(root, 'source-b', 'beta', '# Beta');
    const secondManifest = manifestFor([
      candidate({ id: 'skill:beta', name: 'beta', fingerprint: secondSource.fingerprint, sourcePath: secondSource.sourcePath }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const store = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(firstManifest, firstStage)).ok).toBe(true);
    const second = await store.activate(secondManifest, secondStage);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await writeFile(
      path.join(firstStage.generationPath, firstStage.stagedSkills[0]!.relativePath, 'helper.txt'),
      'corrupt rollback target\n',
      'utf8',
    );

    const target = await store.resolveRollbackTarget();
    expect(target.ok).toBe(false);
    if (!target.ok) {
      expect(target.error.code).toBe('INVALID_INPUT');
      expect(target.error.message).toContain('fingerprint');
    }

    const rolledBack = await store.rollback(secondStage.generationId);
    expect(rolledBack.ok).toBe(false);
    if (!rolledBack.ok) {
      expect(rolledBack.error.code).toBe('INVALID_INPUT');
      expect(rolledBack.error.message).toContain('fingerprint');
    }
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(second.value.state);
  });

  it('makes concurrent rollback retry-safe by requiring the expected active generation', async () => {
    const root = await fixtureRoot('canonical-cutover-rollback-concurrent-');
    const dataDir = path.join(root, 'data');
    const firstSource = await createSkill(root, 'source-a', 'alpha', '# Alpha');
    const firstManifest = manifestFor([
      candidate({ id: 'skill:alpha', name: 'alpha', fingerprint: firstSource.fingerprint, sourcePath: firstSource.sourcePath }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondSource = await createSkill(root, 'source-b', 'beta', '# Beta');
    const secondManifest = manifestFor([
      candidate({ id: 'skill:beta', name: 'beta', fingerprint: secondSource.fingerprint, sourcePath: secondSource.sourcePath }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const firstStore = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const secondStore = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    expect((await firstStore.activate(firstManifest, firstStage)).ok).toBe(true);
    expect((await firstStore.activate(secondManifest, secondStage)).ok).toBe(true);

    const results = await Promise.all([
      firstStore.rollback(secondStage.generationId),
      secondStore.rollback(secondStage.generationId),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rejected = results.find((result) => !result.ok);
    expect(rejected?.ok).toBe(false);
    if (rejected !== undefined && !rejected.ok) {
      expect(rejected.error.code).toBe('CONFLICT');
      expect(rejected.error.message).toContain('active generation changed');
    }

    const loaded = await firstStore.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual({
      schemaVersion: 1,
      activeGenerationId: firstStage.generationId,
      previousGenerationId: secondStage.generationId,
    });
  });

  it('serializes concurrent activation of the same generation so exactly one call mutates state', async () => {
    const root = await fixtureRoot('canonical-cutover-concurrent-');
    const dataDir = path.join(root, 'data');
    const source = await createSkill(root, 'source', 'alpha', '# Alpha');
    const manifest = manifestFor([
      candidate({
        id: 'skill:alpha',
        name: 'alpha',
        fingerprint: source.fingerprint,
        sourcePath: source.sourcePath,
      }),
    ]);
    const staged = await stage(dataDir, manifest);
    const firstStore = new CanonicalSkillMigrationCutoverStateStore({ dataDir });
    const secondStore = new CanonicalSkillMigrationCutoverStateStore({ dataDir });

    const results = await Promise.all([
      firstStore.activate(manifest, staged),
      secondStore.activate(manifest, staged),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const changed = results.flatMap((result) => result.ok ? [result.value.changed] : []);
    expect(changed.sort()).toEqual([false, true]);

    const loaded = await firstStore.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual({
      schemaVersion: 1,
      activeGenerationId: staged.generationId,
    });
  });
});
