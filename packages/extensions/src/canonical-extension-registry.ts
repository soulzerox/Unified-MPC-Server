import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { withConfigMutationTransaction } from './config-mutation-lock.js';
import { writeAtomic } from './ide-sync.js';

export type CanonicalExtensionKind = 'skill' | 'mcp_server';
export type CanonicalExtensionOriginType =
  | 'bundled'
  | 'github'
  | 'url'
  | 'local-import'
  | 'client-import'
  | 'managed';

export type CanonicalExtensionCompatibilityState =
  | 'compatible'
  | 'incompatible_platform'
  | 'incompatible_architecture'
  | 'missing_dependency'
  | 'unknown'
  | 'conflict';

export interface CanonicalExtensionProvenance {
  readonly originType: CanonicalExtensionOriginType;
  readonly origin: string;
  readonly sourceClient?: string;
  readonly version?: string;
  readonly revision?: string;
  readonly contentSha256?: string;
  readonly importedAt?: string;
}

export interface CanonicalExtensionCompatibility {
  readonly platforms?: readonly NodeJS.Platform[];
  readonly architectures?: readonly string[];
  readonly requiresCommands?: readonly string[];
  readonly optionalCommands?: readonly string[];
}

export interface CanonicalExtensionCandidate {
  readonly kind: CanonicalExtensionKind;
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly provenance: CanonicalExtensionProvenance;
  readonly compatibility?: CanonicalExtensionCompatibility;
}

export interface CanonicalExtensionHostProfile {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly availableCommands: ReadonlySet<string>;
}

export interface CanonicalExtensionEntry {
  readonly kind: CanonicalExtensionKind;
  readonly id: string;
  readonly name: string;
  readonly fingerprint?: string;
  readonly enabled: boolean;
  readonly compatibility?: CanonicalExtensionCompatibility;
  readonly compatibilityState: CanonicalExtensionCompatibilityState;
  readonly missingCommands?: readonly string[];
  readonly conflict: boolean;
  readonly variantFingerprints: readonly string[];
  readonly provenance: readonly CanonicalExtensionProvenance[];
}

export interface CanonicalExtensionRegistrySnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly entries: readonly CanonicalExtensionEntry[];
}

export interface CanonicalExtensionRegistryOptions {
  readonly dataDir: string;
}

const REGISTRY_SCHEMA_VERSION = 1 as const;

export function reconcileCanonicalExtensionCandidates(
  candidates: readonly CanonicalExtensionCandidate[],
  host: CanonicalExtensionHostProfile,
): Result<CanonicalExtensionRegistrySnapshot> {
  const groups = new Map<string, CanonicalExtensionCandidate[]>();
  for (const candidate of candidates) {
    const validated = validateCandidate(candidate);
    if (validated !== undefined) return err(validated);
    const key = candidateKey(candidate);
    const current = groups.get(key);
    if (current === undefined) groups.set(key, [candidate]);
    else current.push(candidate);
  }

  const entries = [...groups.values()]
    .map((group) => reconcileGroup(group, host))
    .sort(compareEntries);

  return ok({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generation: 0,
    entries,
  });
}

export class CanonicalExtensionRegistry {
  private readonly registryPath: string;

  public constructor(options: CanonicalExtensionRegistryOptions) {
    this.registryPath = canonicalExtensionRegistryPath(options.dataDir);
  }

  public async load(): Promise<Result<CanonicalExtensionRegistrySnapshot>> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown;
      if (!isRegistrySnapshot(parsed)) {
        return err(appError('INVALID_INPUT', 'Canonical extension registry is malformed: ' + this.registryPath));
      }
      return ok(parsed);
    } catch (error: unknown) {
      if (isMissingFile(error)) return ok(emptyRegistrySnapshot());
      return err(appError(
        'INTERNAL_ERROR',
        'Failed to read canonical extension registry: ' + (error instanceof Error ? error.message : String(error)),
        true,
      ));
    }
  }

  public async save(
    snapshot: Pick<CanonicalExtensionRegistrySnapshot, 'entries'>,
  ): Promise<Result<CanonicalExtensionRegistrySnapshot>> {
    try {
      return await withConfigMutationTransaction([this.registryPath], async () => {
        const current = await this.load();
        if (!current.ok) return current;

        const entries = [...snapshot.entries].sort(compareEntries);
        const currentEntries = [...current.value.entries].sort(compareEntries);
        if (JSON.stringify(entries) === JSON.stringify(currentEntries)) return current;

        const next: CanonicalExtensionRegistrySnapshot = {
          schemaVersion: REGISTRY_SCHEMA_VERSION,
          generation: current.value.generation + 1,
          entries,
        };
        await writeAtomic(this.registryPath, JSON.stringify(next, null, 2) + '\n');
        return ok(next);
      });
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        'Failed to persist canonical extension registry: ' + (error instanceof Error ? error.message : String(error)),
        true,
      ));
    }
  }
}

export function canonicalExtensionRegistryPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'extensions', 'state', 'registry.json');
}

function reconcileGroup(
  group: readonly CanonicalExtensionCandidate[],
  host: CanonicalExtensionHostProfile,
): CanonicalExtensionEntry {
  const ordered = [...group].sort(compareCandidates);
  const first = ordered[0]!;
  const variantFingerprints = uniqueSorted(ordered.map((candidate) => candidate.fingerprint));
  const names = uniqueSorted(ordered.map((candidate) => candidate.name));
  const compatibilityVariants = uniqueSorted(
    ordered.map((candidate) => stableCompatibility(candidate.compatibility)),
  );
  const conflict = variantFingerprints.length > 1 || names.length > 1 || compatibilityVariants.length > 1;
  const provenance = dedupeProvenance(ordered.map((candidate) => candidate.provenance));
  const enabled = ordered.every((candidate) => candidate.enabled);

  if (conflict) {
    return {
      kind: first.kind,
      id: first.id,
      name: names[0] ?? first.name,
      enabled,
      compatibilityState: 'conflict',
      conflict: true,
      variantFingerprints,
      provenance,
    };
  }

  const compatibility = normalizeCompatibility(first.compatibility);
  const evaluated = evaluateCompatibility(compatibility, host);
  return {
    kind: first.kind,
    id: first.id,
    name: first.name,
    fingerprint: first.fingerprint,
    enabled,
    ...(compatibility === undefined ? {} : { compatibility }),
    compatibilityState: evaluated.state,
    ...(evaluated.missingCommands.length === 0 ? {} : { missingCommands: evaluated.missingCommands }),
    conflict: false,
    variantFingerprints,
    provenance,
  };
}

function evaluateCompatibility(
  compatibility: CanonicalExtensionCompatibility | undefined,
  host: CanonicalExtensionHostProfile,
): { readonly state: CanonicalExtensionCompatibilityState; readonly missingCommands: readonly string[] } {
  if (compatibility === undefined || !hasDefinitiveCompatibilityConstraint(compatibility)) {
    return { state: 'unknown', missingCommands: [] };
  }
  if (
    compatibility.platforms !== undefined
    && compatibility.platforms.length > 0
    && !compatibility.platforms.includes(host.platform)
  ) {
    return { state: 'incompatible_platform', missingCommands: [] };
  }
  if (
    compatibility.architectures !== undefined
    && compatibility.architectures.length > 0
    && !compatibility.architectures.includes(host.architecture)
  ) {
    return { state: 'incompatible_architecture', missingCommands: [] };
  }
  const missingCommands = (compatibility.requiresCommands ?? [])
    .filter((command) => !host.availableCommands.has(command))
    .sort((left, right) => left.localeCompare(right));
  if (missingCommands.length > 0) return { state: 'missing_dependency', missingCommands };
  return { state: 'compatible', missingCommands: [] };
}

function normalizeCompatibility(
  value: CanonicalExtensionCompatibility | undefined,
): CanonicalExtensionCompatibility | undefined {
  if (value === undefined) return undefined;
  const normalized: CanonicalExtensionCompatibility = {
    ...(value.platforms === undefined ? {} : { platforms: uniqueSorted(value.platforms) as readonly NodeJS.Platform[] }),
    ...(value.architectures === undefined ? {} : { architectures: uniqueSorted(value.architectures) }),
    ...(value.requiresCommands === undefined ? {} : { requiresCommands: uniqueSorted(value.requiresCommands) }),
    ...(value.optionalCommands === undefined ? {} : { optionalCommands: uniqueSorted(value.optionalCommands) }),
  };
  return hasCompatibilityMetadata(normalized) ? normalized : undefined;
}

function hasCompatibilityMetadata(value: CanonicalExtensionCompatibility): boolean {
  return hasDefinitiveCompatibilityConstraint(value)
    || (value.optionalCommands?.length ?? 0) > 0;
}

function hasDefinitiveCompatibilityConstraint(value: CanonicalExtensionCompatibility): boolean {
  return (value.platforms?.length ?? 0) > 0
    || (value.architectures?.length ?? 0) > 0
    || (value.requiresCommands?.length ?? 0) > 0;
}

function stableCompatibility(value: CanonicalExtensionCompatibility | undefined): string {
  const normalized = normalizeCompatibility(value);
  return normalized === undefined ? '{}' : JSON.stringify(normalized);
}

function validateCandidate(candidate: CanonicalExtensionCandidate): ReturnType<typeof appError> | undefined {
  const id = candidate.id.trim();
  const name = candidate.name.trim();
  if (id.length === 0 || id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(id)) {
    return appError('INVALID_INPUT', 'Canonical extension id is invalid: ' + candidate.id);
  }
  if (name.length === 0 || name.length > 256) {
    return appError('INVALID_INPUT', 'Canonical extension name is invalid: ' + candidate.name);
  }
  if (!/^[a-f0-9]{64}$/.test(candidate.fingerprint)) {
    return appError('INVALID_INPUT', 'Canonical extension fingerprint must be lowercase SHA-256: ' + candidate.id);
  }
  if (candidate.provenance.origin.trim().length === 0) {
    return appError('INVALID_INPUT', 'Canonical extension provenance origin is required: ' + candidate.id);
  }
  return undefined;
}

function candidateKey(candidate: CanonicalExtensionCandidate): string {
  return candidate.kind + '\u0000' + candidate.id;
}

function compareCandidates(left: CanonicalExtensionCandidate, right: CanonicalExtensionCandidate): number {
  return candidateKey(left).localeCompare(candidateKey(right))
    || left.fingerprint.localeCompare(right.fingerprint)
    || left.name.localeCompare(right.name)
    || provenanceKey(left.provenance).localeCompare(provenanceKey(right.provenance));
}

function compareEntries(left: CanonicalExtensionEntry, right: CanonicalExtensionEntry): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function dedupeProvenance(values: readonly CanonicalExtensionProvenance[]): readonly CanonicalExtensionProvenance[] {
  const byKey = new Map<string, CanonicalExtensionProvenance>();
  for (const value of values) byKey.set(provenanceKey(value), value);
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
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

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function emptyRegistrySnapshot(): CanonicalExtensionRegistrySnapshot {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, generation: 0, entries: [] };
}

function isRegistrySnapshot(value: unknown): value is CanonicalExtensionRegistrySnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== REGISTRY_SCHEMA_VERSION) return false;
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return false;
  if (!Array.isArray(value.entries)) return false;
  return value.entries.every(isRegistryEntry);
}

function isRegistryEntry(value: unknown): value is CanonicalExtensionEntry {
  if (!isRecord(value)) return false;
  if (value.kind !== 'skill' && value.kind !== 'mcp_server') return false;
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return false;
  if (typeof value.enabled !== 'boolean' || typeof value.conflict !== 'boolean') return false;
  if (!Array.isArray(value.variantFingerprints) || !value.variantFingerprints.every((entry) => typeof entry === 'string')) return false;
  if (!Array.isArray(value.provenance) || !value.provenance.every(isProvenance)) return false;
  return [
    'compatible',
    'incompatible_platform',
    'incompatible_architecture',
    'missing_dependency',
    'unknown',
    'conflict',
  ].includes(String(value.compatibilityState));
}

function isProvenance(value: unknown): value is CanonicalExtensionProvenance {
  return isRecord(value)
    && typeof value.originType === 'string'
    && typeof value.origin === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
