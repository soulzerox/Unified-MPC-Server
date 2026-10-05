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
