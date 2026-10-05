import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';
import {
  CanonicalExtensionRegistry,
  canonicalExtensionRegistryPath,
  reconcileCanonicalExtensionCandidates,
  type CanonicalExtensionCandidate,
  type CanonicalExtensionEntry,
} from './canonical-extension-registry.js';

const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);

function skillCandidate(overrides: Partial<CanonicalExtensionCandidate> = {}): CanonicalExtensionCandidate {
  return {
    kind: 'skill',
    id: 'skill:code-review',
    name: 'code-review',
    fingerprint: fingerprintA,
    enabled: true,
    provenance: {
      originType: 'client-import',
      origin: '/home/test/.cline/skills/code-review',
      sourceClient: 'cline',
    },
    ...overrides,
  };
}

function mcpEntry(input: {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
}): CanonicalExtensionEntry {
  return {
    kind: 'mcp_server',
    id: input.id,
    name: input.name,
    fingerprint: input.fingerprint,
    enabled: true,
    compatibility: { platforms: ['linux'] },
    compatibilityState: 'compatible',
    conflict: false,
    variantFingerprints: [input.fingerprint],
    provenance: [{
      originType: 'client-import',
      origin: `/fixture/${input.name}`,
      sourceClient: 'cursor',
    }],
  };
}

describe('canonical extension registry', () => {
  it('collapses identical logical resources while preserving every provenance source', () => {
    const reconciled = reconcileCanonicalExtensionCandidates([
      skillCandidate(),
      skillCandidate({
        provenance: {
          originType: 'client-import',
          origin: '/home/test/.codex/skills/code-review',
          sourceClient: 'codex',
        },
      }),
    ], {
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(['git']),
    });

    expect(reconciled).toMatchObject({
      ok: true,
      value: {
        entries: [{
          id: 'skill:code-review',
          kind: 'skill',
          name: 'code-review',
          fingerprint: fingerprintA,
          enabled: true,
          compatibilityState: 'unknown',
          conflict: false,
          provenance: [
            expect.objectContaining({ sourceClient: 'cline' }),
            expect.objectContaining({ sourceClient: 'codex' }),
          ],
        }],
      },
    });
  });

  it('reports a stable conflict instead of silently choosing one variant', () => {
    const reconciled = reconcileCanonicalExtensionCandidates([
      skillCandidate(),
      skillCandidate({
        fingerprint: fingerprintB,
        provenance: {
          originType: 'client-import',
          origin: '/home/test/.codex/skills/code-review',
          sourceClient: 'codex',
        },
      }),
    ], {
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(),
    });

    expect(reconciled).toMatchObject({
      ok: true,
      value: {
        entries: [{
          id: 'skill:code-review',
          conflict: true,
          compatibilityState: 'conflict',
          variantFingerprints: [fingerprintA, fingerprintB],
        }],
      },
    });
  });

  it('classifies platform, architecture, and required-command compatibility without inventing support', () => {
    const reconciled = reconcileCanonicalExtensionCandidates([
      skillCandidate({
        id: 'skill:linux-ok',
        name: 'linux-ok',
        compatibility: { platforms: ['linux'], architectures: ['x64'], requiresCommands: ['git'] },
      }),
      skillCandidate({
        id: 'skill:windows-only',
        name: 'windows-only',
        compatibility: { platforms: ['win32'] },
      }),
      skillCandidate({
        id: 'skill:arm-only',
        name: 'arm-only',
        compatibility: { platforms: ['linux'], architectures: ['arm64'] },
      }),
      skillCandidate({
        id: 'skill:missing-command',
        name: 'missing-command',
        compatibility: { platforms: ['linux'], requiresCommands: ['rg'] },
      }),
      skillCandidate({
        id: 'skill:optional-only',
        name: 'optional-only',
        compatibility: { optionalCommands: ['rg'] },
      }),
    ], {
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(['git']),
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;

    expect(Object.fromEntries(reconciled.value.entries.map((entry) => [entry.id, entry.compatibilityState]))).toEqual({
      'skill:arm-only': 'incompatible_architecture',
      'skill:linux-ok': 'compatible',
      'skill:missing-command': 'missing_dependency',
      'skill:optional-only': 'unknown',
      'skill:windows-only': 'incompatible_platform',
    });
  });

  it('round-trips one parent-owned snapshot and advances generation atomically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-'));
    try {
      const registry = new CanonicalExtensionRegistry({ dataDir: root });
      const first = reconcileCanonicalExtensionCandidates([skillCandidate()], {
        platform: 'linux',
        architecture: 'x64',
        availableCommands: new Set(),
      });
      if (!first.ok) throw new Error(first.error.message);

      const saved = await registry.save(first.value);
      expect(saved).toMatchObject({ ok: true, value: { schemaVersion: 1, generation: 1 } });

      const loaded = await registry.load();
      expect(loaded).toEqual(saved);

      const savedAgain = await registry.save(first.value);
      expect(savedAgain).toEqual(saved);

      const changed = reconcileCanonicalExtensionCandidates([
        skillCandidate(),
        skillCandidate({ id: 'skill:second', name: 'second' }),
      ], {
        platform: 'linux',
        architecture: 'x64',
        availableCommands: new Set(),
      });
      if (!changed.ok) throw new Error(changed.error.message);
      const savedChanged = await registry.save(changed.value);
      expect(savedChanged).toMatchObject({ ok: true, value: { schemaVersion: 1, generation: 2 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically upserts one entry with sibling writes and keeps idempotent generation stable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-upsert-'));
    try {
      const registry = new CanonicalExtensionRegistry({ dataDir: root });
      const siblingFile = path.join(root, 'extensions', 'mcp', 'registry.json');
      await mkdir(path.dirname(siblingFile), { recursive: true });
      await writeFile(siblingFile, 'before\n', 'utf8');
      const host = {
        platform: 'linux' as const,
        architecture: 'x64',
        availableCommands: new Set<string>(),
      };
      const candidate: CanonicalExtensionCandidate = {
        kind: 'mcp_server',
        id: 'mcp:parent-child',
        name: 'parent-child',
        fingerprint: fingerprintA,
        enabled: true,
        provenance: {
          originType: 'managed',
          origin: 'unified-mpc:mcp_install',
        },
      };

      const first = await registry.upsertAtomically(candidate, host, [siblingFile], async () => {
        await writeFile(siblingFile, 'after\n', 'utf8');
      });
      expect(first).toMatchObject({
        ok: true,
        value: {
          schemaVersion: 1,
          generation: 1,
          entries: [{
            kind: 'mcp_server',
            id: 'mcp:parent-child',
            name: 'parent-child',
            fingerprint: fingerprintA,
            compatibilityState: 'unknown',
            provenance: [{ originType: 'managed', origin: 'unified-mpc:mcp_install' }],
          }],
        },
      });
      expect(await readFile(siblingFile, 'utf8')).toBe('after\n');

      const second = await registry.upsertAtomically(candidate, host, [siblingFile], async () => undefined);
      expect(second).toEqual(first);

      const failed = await registry.upsertAtomically({
        ...candidate,
        fingerprint: fingerprintB,
      }, host, [siblingFile], async () => {
        await writeFile(siblingFile, 'broken\n', 'utf8');
        throw new Error('simulated sibling write failure');
      });
      expect(failed.ok).toBe(false);
      expect(await readFile(siblingFile, 'utf8')).toBe('after\n');
      expect(await registry.load()).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compensates materialization when canonical registry persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-compensate-'));
    try {
      const registry = new CanonicalExtensionRegistry({ dataDir: root });
      const registryPath = canonicalExtensionRegistryPath(root);
      const host = {
        platform: 'linux' as const,
        architecture: 'x64',
        availableCommands: new Set<string>(),
      };
      let materialized = 'before';
      let compensated = false;

      const failed = await registry.upsertAtomically(
        skillCandidate(),
        host,
        [],
        async () => {
          materialized = 'after';
          await mkdir(registryPath, { recursive: true });
        },
        async () => {
          await rm(registryPath, { recursive: true, force: true });
          materialized = 'before';
          compensated = true;
        },
      );

      expect(failed.ok).toBe(false);
      expect(compensated).toBe(true);
      expect(materialized).toBe('before');
      const loaded = await registry.load();
      expect(loaded).toMatchObject({ ok: true, value: { generation: 0, entries: [] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically replaces one extension kind while preserving other installed entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-kind-'));
    try {
      const registry = new CanonicalExtensionRegistry({ dataDir: root });
      const initial = reconcileCanonicalExtensionCandidates([
        skillCandidate(),
        {
          kind: 'mcp_server',
          id: 'mcp:stale',
          name: 'stale',
          fingerprint: fingerprintA,
          enabled: true,
          compatibility: { platforms: ['linux'] },
          provenance: {
            originType: 'client-import',
            origin: '/fixture/stale',
            sourceClient: 'cursor',
          },
        },
      ], {
        platform: 'linux',
        architecture: 'x64',
        availableCommands: new Set(),
      });
      if (!initial.ok) throw new Error(initial.error.message);
      expect((await registry.save(initial.value)).ok).toBe(true);

      const siblingFile = path.join(root, 'extensions', 'state', 'migration', 'mcp-cutover-state.json');
      await mkdir(path.dirname(siblingFile), { recursive: true });
      await writeFile(siblingFile, 'before\n', 'utf8');

      const replacement = mcpEntry({
        id: 'mcp:active',
        name: 'active',
        fingerprint: fingerprintB,
      });
      const replaced = await registry.replaceKindAtomically(
        'mcp_server',
        [replacement],
        [siblingFile],
        async () => {
          await writeFile(siblingFile, 'after\n', 'utf8');
          return ok('updated');
        },
      );
      expect(replaced).toMatchObject({
        ok: true,
        value: {
          operationValue: 'updated',
          registry: {
            schemaVersion: 1,
            generation: 2,
            entries: [
              { kind: 'mcp_server', id: 'mcp:active' },
              { kind: 'skill', id: 'skill:code-review' },
            ],
          },
        },
      });
      expect(await readFile(siblingFile, 'utf8')).toBe('after\n');

      const repeated = await registry.replaceKindAtomically(
        'mcp_server',
        [replacement],
        [siblingFile],
        async () => ok('same'),
      );
      expect(repeated).toMatchObject({
        ok: true,
        value: {
          operationValue: 'same',
          registry: { generation: 2 },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls sibling mutations back when an atomic kind replacement returns an error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-kind-error-'));
    try {
      const registry = new CanonicalExtensionRegistry({ dataDir: root });
      const initial = reconcileCanonicalExtensionCandidates([skillCandidate()], {
        platform: 'linux',
        architecture: 'x64',
        availableCommands: new Set(),
      });
      if (!initial.ok) throw new Error(initial.error.message);
      const saved = await registry.save(initial.value);
      expect(saved.ok).toBe(true);

      const siblingFile = path.join(root, 'extensions', 'state', 'migration', 'mcp-cutover-state.json');
      await mkdir(path.dirname(siblingFile), { recursive: true });
      await writeFile(siblingFile, 'before\n', 'utf8');

      const failed = await registry.replaceKindAtomically(
        'mcp_server',
        [mcpEntry({ id: 'mcp:active', name: 'active', fingerprint: fingerprintB })],
        [siblingFile],
        async () => {
          await writeFile(siblingFile, 'broken\n', 'utf8');
          return err(appError('CONFLICT', 'simulated cutover race', true));
        },
      );
      expect(failed).toEqual(err(appError('CONFLICT', 'simulated cutover race', true)));
      expect(await readFile(siblingFile, 'utf8')).toBe('before\n');
      expect(await registry.load()).toEqual(saved);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent registry replacements through the shared config mutation lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-lock-'));
    try {
      const snapshots = Array.from({ length: 20 }, (_, index) => {
        const reconciled = reconcileCanonicalExtensionCandidates([
          skillCandidate({ id: `skill:concurrent-${index}`, name: `concurrent-${index}` }),
        ], {
          platform: 'linux',
          architecture: 'x64',
          availableCommands: new Set(),
        });
        if (!reconciled.ok) throw new Error(reconciled.error.message);
        return reconciled.value;
      });

      const results = await Promise.all(snapshots.map(async (snapshot) => {
        const registry = new CanonicalExtensionRegistry({ dataDir: root });
        return registry.save(snapshot);
      }));
      expect(results.every((result) => result.ok)).toBe(true);

      const loaded = await new CanonicalExtensionRegistry({ dataDir: root }).load();
      expect(loaded).toMatchObject({
        ok: true,
        value: {
          schemaVersion: 1,
          generation: 20,
          entries: [{ conflict: false }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed persisted registry metadata instead of trusting partial shape checks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-canonical-extension-registry-invalid-'));
    try {
      const registry = new CanonicalExtensionRegistry({ dataDir: root });
      const registryFile = path.join(root, 'extensions', 'state', 'registry.json');
      await mkdir(path.dirname(registryFile), { recursive: true });
      const baseEntry = {
        kind: 'skill',
        id: 'skill:code-review',
        name: 'code-review',
        fingerprint: fingerprintA,
        enabled: true,
        compatibility: {
          platforms: ['linux'],
          architectures: ['x64'],
          requiresCommands: ['git'],
        },
        compatibilityState: 'compatible',
        conflict: false,
        variantFingerprints: [fingerprintA],
        provenance: [{
          originType: 'client-import',
          origin: '/home/test/.cline/skills/code-review',
          sourceClient: 'cline',
        }],
      };

      const invalidEntries = [
        { ...baseEntry, fingerprint: 'not-a-sha256' },
        {
          ...baseEntry,
          provenance: [{ ...baseEntry.provenance[0], originType: 'unknown-origin' }],
        },
        {
          ...baseEntry,
          compatibility: { ...baseEntry.compatibility, platforms: ['plan9'] },
        },
        {
          ...baseEntry,
          missingCommands: [42],
          compatibilityState: 'missing_dependency',
        },
      ];

      for (const entry of invalidEntries) {
        await writeFile(registryFile, JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          entries: [entry],
        }), 'utf8');
        const loaded = await registry.load();
        expect(loaded).toMatchObject({
          ok: false,
          error: { code: 'INVALID_INPUT' },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
