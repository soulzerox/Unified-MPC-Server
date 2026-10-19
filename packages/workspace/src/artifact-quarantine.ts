import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface QuarantineTimes {
  readonly quarantinedAt: string;
  readonly graceMs: number;
}

/** A content-hash candidate: the U21 original id space (a 64-hex blob hash). */
export interface ContentHashQuarantineEntry extends QuarantineTimes {
  readonly kind: 'content-hash';
  readonly hash: string;
}

/**
 * A canonical-artifact candidate (#210 §1). The key alone cannot be resolved or
 * deleted, so the row carries the owning repository: the same key registered in
 * two trust boundaries is two records and two rows.
 */
export interface ArtifactKeyQuarantineEntry extends QuarantineTimes {
  readonly kind: 'artifact-key';
  readonly repositoryId: string;
  readonly artifactKey: string;
}

export type QuarantineEntry = ContentHashQuarantineEntry | ArtifactKeyQuarantineEntry;

/**
 * What a caller asks to quarantine or release. A bare string stays the
 * content-hash shorthand, so existing U21 callers are unaffected; both id
 * spaces may be mixed in one call.
 */
export type QuarantineTarget =
  | string
  | { readonly kind: 'artifact-key'; readonly repositoryId: string; readonly artifactKey: string };

export interface QuarantineOptions {
  readonly now: Date;
  readonly graceMs: number;
}

export interface ReleaseCheck {
  readonly now: Date;
  /**
   * Re-checked per entry, so an artifact row is re-checked as repository + key
   * rather than as an unresolvable string. A row is released only while it is
   * still unreachable.
   */
  readonly isReachable: (entry: QuarantineEntry) => Promise<boolean>;
}

type QuarantineIdentity =
  | { readonly kind: 'content-hash'; readonly hash: string }
  | { readonly kind: 'artifact-key'; readonly repositoryId: string; readonly artifactKey: string };

const HASH64 = /^[a-f0-9]{64}$/i;
const ARTIFACT_KEY = /^(?:file|chunk):v1:[a-f0-9]{64}$/i;

function requireHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH64.test(value)) throw new Error(`invalid artifact hash: ${String(value)}`);
  return value.toLowerCase();
}

function requireRepositoryId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new Error('repositoryId must be a non-empty string');
  }
  return value;
}

function requireArtifactKey(value: unknown): string {
  if (typeof value !== 'string' || !ARTIFACT_KEY.test(value)) throw new Error(`invalid artifact key: ${String(value)}`);
  return value.toLowerCase();
}

function requireGraceMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('graceMs must be a positive safe integer');
  }
  return value;
}

function identityOf(target: QuarantineTarget): QuarantineIdentity {
  if (typeof target === 'string') return { kind: 'content-hash', hash: requireHash(target) };
  if (typeof target === 'object' && target !== null && target.kind === 'artifact-key') {
    return {
      kind: 'artifact-key',
      repositoryId: requireRepositoryId(target.repositoryId),
      artifactKey: requireArtifactKey(target.artifactKey),
    };
  }
  throw new Error(`unknown quarantine target: ${JSON.stringify(target)}`);
}

/** Stable identity of a row: a hash, or repository + key in its own id space. */
function identityKey(identity: QuarantineIdentity): string {
  return identity.kind === 'content-hash'
    ? identity.hash
    : `${identity.repositoryId}\u0000${identity.artifactKey}`;
}

function normalizeRow(value: unknown): QuarantineEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.quarantinedAt !== 'string' || typeof record.graceMs !== 'number') return null;
  if (record.kind === 'artifact-key') {
    try {
      return {
        kind: 'artifact-key',
        repositoryId: requireRepositoryId(record.repositoryId),
        artifactKey: requireArtifactKey(record.artifactKey),
        quarantinedAt: record.quarantinedAt,
        graceMs: record.graceMs,
      };
    } catch {
      return null;
    }
  }
  // Rows written before the discriminator carry only a hash.
  if ((record.kind === undefined || record.kind === 'content-hash') && typeof record.hash === 'string' && HASH64.test(record.hash)) {
    return { kind: 'content-hash', hash: record.hash.toLowerCase(), quarantinedAt: record.quarantinedAt, graceMs: record.graceMs };
  }
  return null;
}

/** The target a caller passes to `release` for an entry it has already handled. */
export function quarantineEntryTarget(entry: QuarantineEntry): QuarantineTarget {
  return entry.kind === 'content-hash'
    ? entry.hash
    : { kind: 'artifact-key', repositoryId: entry.repositoryId, artifactKey: entry.artifactKey };
}

/**
 * Artifact quarantine ledger (#210 U21).
 *
 * Physical deletion is reachability-based: unreferenced artifact
 * -> GC candidate -> quarantine/grace -> re-check leases/refs ->
 * physical delete. This ledger owns the middle two steps: `quarantine`
 * records candidates with a grace deadline, and `releaseDue` returns
 * only the entries that are both expired *and still unreachable when
 * re-checked*. Anything that became reachable again stays quarantined
 * for a human/operator to review — never released silently. One JSON
 * file under <root>/quarantine/, tmp+rename durable.
 *
 * Two id spaces are supported in the one ledger: content hashes (the U21
 * original) and canonical-artifact rows, which carry their owning repository
 * because a key is only resolvable inside one trust boundary. Dedupe keeps the
 * first quarantine time per identity; malformed rows are dropped rather than
 * trusted.
 *
 * Deletion itself stays a separate, explicitly scheduled step; this
 * returns release candidates only.
 */
export class ArtifactQuarantineStore {
  public constructor(private readonly root: string) {}

  public async quarantine(targets: readonly QuarantineTarget[], options: QuarantineOptions): Promise<QuarantineEntry[]> {
    const graceMs = requireGraceMs(options.graceMs);
    const entries = await this.readAll();
    const byIdentity = new Map(entries.map((entry) => [identityKey(entry), entry]));
    for (const target of targets) {
      const identity = identityOf(target);
      const key = identityKey(identity);
      if (!byIdentity.has(key)) {
        byIdentity.set(key, { ...identity, quarantinedAt: options.now.toISOString(), graceMs });
      }
    }
    const next = [...byIdentity.values()].sort(byIdentityKey);
    await this.write(next);
    return next;
  }

  public async list(): Promise<QuarantineEntry[]> {
    return this.readAll();
  }

  public async release(targets: readonly QuarantineTarget[]): Promise<void> {
    const drop = new Set(targets.map((target) => identityKey(identityOf(target))));
    const entries = await this.readAll();
    await this.write(entries.filter((entry) => !drop.has(identityKey(entry))));
  }

  public async releaseDue(check: ReleaseCheck): Promise<QuarantineEntry[]> {
    const entries = await this.readAll();
    const released: QuarantineEntry[] = [];
    const retained: QuarantineEntry[] = [];
    for (const entry of entries) {
      const expiresAt = Date.parse(entry.quarantinedAt) + entry.graceMs;
      if (!Number.isFinite(expiresAt) || check.now.getTime() < expiresAt) {
        retained.push(entry);
        continue;
      }
      if (await check.isReachable(entry)) {
        // Became reachable again after quarantine: keep the evidence for
        // operator review instead of releasing silently.
        retained.push(entry);
        continue;
      }
      released.push(entry);
    }
    if (released.length > 0) {
      await this.write(retained);
    }
    return released.sort(byIdentityKey);
  }

  private quarantinePath(): string {
    return path.join(this.root, 'quarantine', 'candidates.json');
  }

  private async readAll(): Promise<QuarantineEntry[]> {
    try {
      const raw = await readFile(this.quarantinePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const entries: QuarantineEntry[] = [];
      for (const value of parsed) {
        const entry = normalizeRow(value);
        if (entry !== null) entries.push(entry);
      }
      return entries.sort(byIdentityKey);
    } catch {
      return [];
    }
  }

  private async write(entries: readonly QuarantineEntry[]): Promise<void> {
    const finalPath = this.quarantinePath();
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}

function byIdentityKey(a: QuarantineEntry, b: QuarantineEntry): number {
  const left = identityKey(a);
  const right = identityKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
