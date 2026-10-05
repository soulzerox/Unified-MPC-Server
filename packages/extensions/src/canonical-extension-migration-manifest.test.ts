import { describe, expect, it } from 'vitest';
import {
  buildCanonicalExtensionMigrationManifest,
  type CanonicalExtensionMigrationManifest,
} from './canonical-extension-migration-manifest.js';
import type { CanonicalExtensionCandidate } from './canonical-extension-registry.js';

const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);

function candidate(overrides: Partial<CanonicalExtensionCandidate> = {}): CanonicalExtensionCandidate {
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
    compatibility: { platforms: ['linux'] },
    ...overrides,
  };
}

function manifestFor(candidates: readonly CanonicalExtensionCandidate[]): CanonicalExtensionMigrationManifest {
  const result = buildCanonicalExtensionMigrationManifest(candidates, {
    platform: 'linux',
    architecture: 'x64',
    availableCommands: new Set(['git']),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('canonical extension migration manifest', () => {
  it('collapses identical copies while preserving every source and deterministic counts', () => {
    const manifest = manifestFor([
      candidate(),
      candidate({
        provenance: {
          originType: 'client-import',
          origin: '/home/test/.codex/skills/code-review',
          sourceClient: 'codex',
        },
      }),
    ]);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      summary: {
        inventoryCount: 2,
        activeInventoryCount: 2,
        canonicalCount: 1,
        activeCanonicalCount: 1,
        duplicatesCollapsed: 1,
        conflictCount: 0,
        incompatibleCount: 0,
        unknownCount: 0,
      },
      cutover: { allowed: true, reasons: [] },
      entries: [{
        id: 'skill:code-review',
        classification: 'identical',
        selectedFingerprint: fingerprintA,
        variantFingerprints: [fingerprintA],
        sourceCount: 2,
        compatibilityState: 'compatible',
        provenance: [
          expect.objectContaining({ sourceClient: 'cline' }),
          expect.objectContaining({ sourceClient: 'codex' }),
        ],
      }],
    });
  });

  it('blocks cutover and surfaces divergent variants instead of selecting one silently', () => {
    const manifest = manifestFor([
      candidate(),
      candidate({
        fingerprint: fingerprintB,
        provenance: {
          originType: 'client-import',
          origin: '/home/test/.codex/skills/code-review',
          sourceClient: 'codex',
        },
      }),
    ]);

    expect(manifest.summary).toMatchObject({
      inventoryCount: 2,
      canonicalCount: 1,
      activeCanonicalCount: 0,
      duplicatesCollapsed: 0,
      conflictCount: 1,
    });
    expect(manifest.entries[0]).toMatchObject({
      classification: 'conflict',
      conflictReasons: ['variant_fingerprint'],
      variantFingerprints: [fingerprintA, fingerprintB],
    });
    expect(manifest.cutover).toEqual({
      allowed: false,
      reasons: ['conflicts_present', 'canonical_active_set_empty'],
    });
  });

  it('treats enabled-state drift as a migration conflict even when content is identical', () => {
    const manifest = manifestFor([
      candidate(),
      candidate({
        enabled: false,
        provenance: {
          originType: 'client-import',
          origin: '/home/test/.codex/skills/code-review',
          sourceClient: 'codex',
        },
      }),
    ]);

    expect(manifest.entries[0]).toMatchObject({
      classification: 'conflict',
      conflictReasons: ['enabled_drift'],
      enabledStates: [false, true],
    });
    expect(manifest.cutover.allowed).toBe(false);
  });

  it('treats empty compatibility metadata as equivalent to absent metadata', () => {
    const manifest = manifestFor([
      candidate({ compatibility: undefined }),
      candidate({
        compatibility: {},
        provenance: {
          originType: 'client-import',
          origin: '/home/test/.codex/skills/code-review',
          sourceClient: 'codex',
        },
      }),
    ]);

    expect(manifest.entries[0]).toMatchObject({
      classification: 'unknown',
      sourceCount: 2,
      conflictReasons: [],
    });
    expect(manifest.summary).toMatchObject({
      duplicatesCollapsed: 1,
      conflictCount: 0,
      unknownCount: 1,
    });
  });

  it('keeps unknown compatibility conservative and blocks cutover until resolved', () => {
    const manifest = manifestFor([
      candidate({ compatibility: undefined }),
    ]);

    expect(manifest.summary).toMatchObject({
      activeInventoryCount: 1,
      activeCanonicalCount: 0,
      unknownCount: 1,
    });
    expect(manifest.entries[0]).toMatchObject({
      classification: 'unknown',
      compatibilityState: 'unknown',
    });
    expect(manifest.cutover).toEqual({
      allowed: false,
      reasons: ['unknown_compatibility_present', 'canonical_active_set_empty'],
    });
  });

  it('records incompatible resources without making them active on the current host', () => {
    const manifest = manifestFor([
      candidate({ compatibility: { platforms: ['win32'] } }),
      candidate({
        id: 'skill:linux-ready',
        name: 'linux-ready',
        fingerprint: fingerprintB,
        provenance: {
          originType: 'bundled',
          origin: '/app/bundled/linux-ready',
        },
        compatibility: { platforms: ['linux'] },
      }),
    ]);

    expect(manifest.summary).toMatchObject({
      inventoryCount: 2,
      canonicalCount: 2,
      activeCanonicalCount: 1,
      incompatibleCount: 1,
      conflictCount: 0,
    });
    expect(manifest.entries.map((entry) => [entry.id, entry.classification])).toEqual([
      ['skill:code-review', 'incompatible'],
      ['skill:linux-ready', 'unique'],
    ]);
    expect(manifest.cutover).toEqual({ allowed: true, reasons: [] });
  });

  it('allows an empty inventory but blocks a non-empty active inventory that yields no active canonical entries', () => {
    expect(manifestFor([]).cutover).toEqual({ allowed: true, reasons: [] });

    const onlyConflict = manifestFor([
      candidate(),
      candidate({ fingerprint: fingerprintB }),
    ]);
    expect(onlyConflict.summary.activeInventoryCount).toBe(2);
    expect(onlyConflict.summary.activeCanonicalCount).toBe(0);
    expect(onlyConflict.cutover.allowed).toBe(false);
    expect(onlyConflict.cutover.reasons).toContain('canonical_active_set_empty');
  });
});
