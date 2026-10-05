import { err, ok, type Result } from '@unified-mpc/domain';
import {
  reconcileCanonicalExtensionCandidates,
  type CanonicalExtensionCandidate,
  type CanonicalExtensionCompatibility,
  type CanonicalExtensionCompatibilityState,
  type CanonicalExtensionHostProfile,
  type CanonicalExtensionKind,
  type CanonicalExtensionProvenance,
} from './canonical-extension-registry.js';

export type CanonicalExtensionMigrationClassification =
  | 'unique'
  | 'identical'
  | 'conflict'
  | 'incompatible'
  | 'unknown';

export type CanonicalExtensionMigrationConflictReason =
  | 'variant_fingerprint'
  | 'name_drift'
  | 'compatibility_drift'
  | 'enabled_drift';

export type CanonicalExtensionCutoverBlocker =
  | 'conflicts_present'
  | 'unknown_compatibility_present'
  | 'canonical_active_set_empty';

export interface CanonicalExtensionMigrationCandidate extends CanonicalExtensionCandidate {
  readonly sourcePath?: string;
}

export interface CanonicalExtensionMigrationSource {
  readonly name: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly sourcePath?: string;
  readonly compatibility?: CanonicalExtensionCompatibility;
  readonly compatibilityState: CanonicalExtensionCompatibilityState;
  readonly missingCommands?: readonly string[];
  readonly provenance: CanonicalExtensionProvenance;
}

export interface CanonicalExtensionMigrationManifestEntry {
  readonly kind: CanonicalExtensionKind;
  readonly id: string;
  readonly name: string;
  readonly classification: CanonicalExtensionMigrationClassification;
  readonly selectedFingerprint?: string;
  readonly variantFingerprints: readonly string[];
  readonly sourceCount: number;
  readonly sources: readonly CanonicalExtensionMigrationSource[];
  readonly enabledStates: readonly boolean[];
  readonly compatibilityState: CanonicalExtensionCompatibilityState;
  readonly provenance: readonly CanonicalExtensionProvenance[];
  readonly conflictReasons: readonly CanonicalExtensionMigrationConflictReason[];
}

export interface CanonicalExtensionMigrationSummary {
  readonly inventoryCount: number;
  readonly activeInventoryCount: number;
  readonly canonicalCount: number;
  readonly activeCanonicalCount: number;
  readonly duplicatesCollapsed: number;
  readonly conflictCount: number;
  readonly incompatibleCount: number;
  readonly unknownCount: number;
}

export interface CanonicalExtensionCutoverDecision {
  readonly allowed: boolean;
  readonly reasons: readonly CanonicalExtensionCutoverBlocker[];
}

export interface CanonicalExtensionMigrationManifest {
  readonly schemaVersion: 1;
  readonly entries: readonly CanonicalExtensionMigrationManifestEntry[];
  readonly summary: CanonicalExtensionMigrationSummary;
  readonly cutover: CanonicalExtensionCutoverDecision;
}

export function buildCanonicalExtensionMigrationManifest(
  candidates: readonly CanonicalExtensionMigrationCandidate[],
  host: CanonicalExtensionHostProfile,
): Result<CanonicalExtensionMigrationManifest> {
  const reconciled = reconcileCanonicalExtensionCandidates(candidates, host);
  if (!reconciled.ok) return err(reconciled.error);

  const grouped = groupCandidates(candidates);
  const sourceInventory = buildMigrationSourceInventory(grouped, host);
  if (!sourceInventory.ok) return err(sourceInventory.error);

  const entries = reconciled.value.entries.map((canonical) => {
    const sourceCandidates = grouped.get(candidateKey(canonical.kind, canonical.id)) ?? [];
    const sources = sourceInventory.value.get(candidateKey(canonical.kind, canonical.id)) ?? [];
    const conflictReasons = conflictReasonsFor(sourceCandidates);
    const hasConflict = canonical.conflict || conflictReasons.length > 0;
    const compatibilityState: CanonicalExtensionCompatibilityState = hasConflict
      ? 'conflict'
      : canonical.compatibilityState;
    const classification = classifyEntry(
      hasConflict,
      compatibilityState,
      sourceCandidates.length,
    );

    return {
      kind: canonical.kind,
      id: canonical.id,
      name: canonical.name,
      classification,
      ...(hasConflict || canonical.fingerprint === undefined
        ? {}
        : { selectedFingerprint: canonical.fingerprint }),
      variantFingerprints: canonical.variantFingerprints,
      sourceCount: sources.length,
      sources,
      enabledStates: uniqueEnabledStates(sourceCandidates),
      compatibilityState,
      provenance: canonical.provenance,
      conflictReasons,
    } satisfies CanonicalExtensionMigrationManifestEntry;
  });

  const activeInventoryCount = candidates.filter((candidate) => candidate.enabled).length;
  const activeCanonicalCount = entries.filter((entry) => isActiveCanonicalEntry(entry, grouped)).length;
  const conflictCount = entries.filter((entry) => entry.classification === 'conflict').length;
  const incompatibleCount = entries.filter((entry) => entry.classification === 'incompatible').length;
  const unknownCount = entries.filter((entry) => entry.classification === 'unknown').length;

  const duplicatesCollapsed = entries.reduce((total, entry) => {
    if (entry.classification === 'conflict') return total;
    return total + Math.max(0, entry.sourceCount - 1);
  }, 0);
  const summary: CanonicalExtensionMigrationSummary = {
    inventoryCount: candidates.length,
    activeInventoryCount,
    canonicalCount: entries.length,
    activeCanonicalCount,
    duplicatesCollapsed,
    conflictCount,
    incompatibleCount,
    unknownCount,
  };
  const reasons: CanonicalExtensionCutoverBlocker[] = [];
  if (conflictCount > 0) reasons.push('conflicts_present');
  if (unknownCount > 0) reasons.push('unknown_compatibility_present');
  if (activeInventoryCount > 0 && activeCanonicalCount === 0) {
    reasons.push('canonical_active_set_empty');
  }

  return ok({
    schemaVersion: 1,
    entries,
    summary,
    cutover: {
      allowed: reasons.length === 0,
      reasons,
    },
  });
}

function groupCandidates(
  candidates: readonly CanonicalExtensionMigrationCandidate[],
): ReadonlyMap<string, readonly CanonicalExtensionMigrationCandidate[]> {
  const groups = new Map<string, CanonicalExtensionMigrationCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.kind, candidate.id);
    const current = groups.get(key);
    if (current === undefined) groups.set(key, [candidate]);
    else current.push(candidate);
  }
  return groups;
}

function buildMigrationSourceInventory(
  grouped: ReadonlyMap<string, readonly CanonicalExtensionMigrationCandidate[]>,
  host: CanonicalExtensionHostProfile,
): Result<ReadonlyMap<string, readonly CanonicalExtensionMigrationSource[]>> {
  const inventory = new Map<string, readonly CanonicalExtensionMigrationSource[]>();
  for (const [key, candidates] of grouped) {
    const sources: CanonicalExtensionMigrationSource[] = [];
    for (const candidate of candidates) {
      const reconciled = reconcileCanonicalExtensionCandidates([candidate], host);
      if (!reconciled.ok) return err(reconciled.error);
      const canonical = reconciled.value.entries[0]!;
      sources.push({
        name: candidate.name,
        fingerprint: candidate.fingerprint,
        enabled: candidate.enabled,
        ...(candidate.sourcePath === undefined ? {} : { sourcePath: candidate.sourcePath }),
        ...(canonical.compatibility === undefined ? {} : { compatibility: canonical.compatibility }),
        compatibilityState: canonical.compatibilityState,
        ...(canonical.missingCommands === undefined ? {} : { missingCommands: canonical.missingCommands }),
        provenance: candidate.provenance,
      });
    }
    inventory.set(key, sources.sort(compareMigrationSources));
  }
  return ok(inventory);
}

function compareMigrationSources(
  left: CanonicalExtensionMigrationSource,
  right: CanonicalExtensionMigrationSource,
): number {
  return migrationSourceKey(left).localeCompare(migrationSourceKey(right));
}

function migrationSourceKey(source: CanonicalExtensionMigrationSource): string {
  return [
    source.fingerprint,
    source.enabled ? '1' : '0',
    source.name,
    stableCompatibility(source.compatibility),
    provenanceKey(source.provenance),
    source.sourcePath ?? '',
  ].join('\u0000');
}

function provenanceKey(value: CanonicalExtensionProvenance): string {
  return [
    value.originType,
    value.origin,
    value.sourceClient ?? '',
    value.version ?? '',
    value.revision ?? '',
    value.contentSha256 ?? '',
    value.importedAt ?? '',
  ].join('\u0000');
}

function conflictReasonsFor(
  candidates: readonly CanonicalExtensionCandidate[],
): readonly CanonicalExtensionMigrationConflictReason[] {
  const reasons: CanonicalExtensionMigrationConflictReason[] = [];
  if (uniqueStrings(candidates.map((candidate) => candidate.fingerprint)).length > 1) {
    reasons.push('variant_fingerprint');
  }
  if (uniqueStrings(candidates.map((candidate) => candidate.name)).length > 1) {
    reasons.push('name_drift');
  }
  if (uniqueStrings(candidates.map((candidate) => stableCompatibility(candidate.compatibility))).length > 1) {
    reasons.push('compatibility_drift');
  }
  if (new Set(candidates.map((candidate) => candidate.enabled)).size > 1) {
    reasons.push('enabled_drift');
  }
  return reasons;
}

function classifyEntry(
  conflict: boolean,
  compatibilityState: CanonicalExtensionCompatibilityState,
  sourceCount: number,
): CanonicalExtensionMigrationClassification {
  if (conflict) return 'conflict';
  if (compatibilityState === 'unknown') return 'unknown';
  if (
    compatibilityState === 'incompatible_platform'
    || compatibilityState === 'incompatible_architecture'
    || compatibilityState === 'missing_dependency'
  ) return 'incompatible';
  return sourceCount > 1 ? 'identical' : 'unique';
}

function isActiveCanonicalEntry(
  entry: CanonicalExtensionMigrationManifestEntry,
  grouped: ReadonlyMap<string, readonly CanonicalExtensionCandidate[]>,
): boolean {
  if (entry.classification === 'conflict') return false;
  if (entry.compatibilityState !== 'compatible') return false;
  const candidates = grouped.get(candidateKey(entry.kind, entry.id)) ?? [];
  return candidates.length > 0 && candidates.every((candidate) => candidate.enabled);
}

function stableCompatibility(value: CanonicalExtensionCompatibility | undefined): string {
  if (value === undefined) return '{}';
  const platforms = uniqueStrings(value.platforms ?? []);
  const architectures = uniqueStrings(value.architectures ?? []);
  const requiresCommands = uniqueStrings(value.requiresCommands ?? []);
  const optionalCommands = uniqueStrings(value.optionalCommands ?? []);
  if (
    platforms.length === 0
    && architectures.length === 0
    && requiresCommands.length === 0
    && optionalCommands.length === 0
  ) return '{}';

  return JSON.stringify({
    ...(platforms.length === 0 ? {} : { platforms }),
    ...(architectures.length === 0 ? {} : { architectures }),
    ...(requiresCommands.length === 0 ? {} : { requiresCommands }),
    ...(optionalCommands.length === 0 ? {} : { optionalCommands }),
  });
}

function uniqueStrings<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueEnabledStates(candidates: readonly CanonicalExtensionCandidate[]): readonly boolean[] {
  return [...new Set(candidates.map((candidate) => candidate.enabled))]
    .sort((left, right) => Number(left) - Number(right));
}

function candidateKey(kind: CanonicalExtensionKind, id: string): string {
  return kind + '\u0000' + id;
}
