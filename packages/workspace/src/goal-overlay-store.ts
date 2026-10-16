import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type GoalOverlayEntryKind = 'modified' | 'added' | 'deleted';

export interface GoalOverlayEntryInput {
  readonly path: string;
  readonly kind: GoalOverlayEntryKind;
  /** Null for deletions (tombstone); exact 64-hex content hash otherwise. */
  readonly contentHash: string | null;
}

export type GoalOverlayEntry = GoalOverlayEntryInput;

export interface GoalOverlayBase {
  readonly baseCommitSha: string;
  readonly baseTreeOid: string;
  readonly baseManifestId: string;
}

export interface GoalOverlay {
  readonly goalWorkspaceId: string;
  readonly baseCommitSha: string;
  readonly baseTreeOid: string;
  readonly baseManifestId: string;
  readonly entries: readonly GoalOverlayEntry[];
  readonly updatedAt: string;
}

const HEX64 = /^[a-f0-9]{64}$/i;

function requireRepoRelativePath(value: string): string {
  if (value.length === 0 || value.startsWith('/') || value.includes('..')) {
    throw new Error(`invalid overlay path: ${value}`);
  }
  return value;
}

function requireContentHash(value: string | null, kind: GoalOverlayEntryKind): string | null {
  if (kind === 'deleted') {
    if (value !== null) throw new Error('deleted overlay entries must carry a null content hash');
    return null;
  }
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new Error('overlay content hash must be an exact 64-hex SHA-256');
  }
  return value.toLowerCase();
}

function requireGoalId(value: string): string {
  if (value.length === 0 || value.includes('/') || value.includes('..')) {
    throw new Error(`invalid goal workspace id: ${value}`);
  }
  return value;
}

/**
 * Goal overlay CRUD pinned to an exact base manifest (#210 U8).
 *
 * One JSON file per goal workspace under <root>/overlays/, written via
 * tmp+rename so a crash never leaves a torn file. The overlay tracks only
 * deviations from the pinned base revision: `resolve()` returns the overlay
 * entry first (including tombstones as null) and falls back to base
 * entries, so queries and pre-edit never see stale base content for a
 * dirty path. This store owns dirty-path truth; semantic materialization
 * stays with Thai-RAG (#60).
 */
export class GoalOverlayStore {
  public constructor(private readonly root: string) {}

  public async create(
    goalWorkspaceId: string,
    base: GoalOverlayBase,
  ): Promise<GoalOverlay> {
    const id = requireGoalId(goalWorkspaceId);
    const overlay: GoalOverlay = {
      goalWorkspaceId: id,
      baseCommitSha: base.baseCommitSha,
      baseTreeOid: base.baseTreeOid,
      baseManifestId: base.baseManifestId,
      entries: [],
      updatedAt: new Date().toISOString(),
    };
    await this.write(id, overlay);
    return overlay;
  }

  public async read(goalWorkspaceId: string): Promise<GoalOverlay | null> {
    try {
      const raw = await readFile(this.overlayPath(requireGoalId(goalWorkspaceId)), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isOverlay(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  public async upsert(
    goalWorkspaceId: string,
    entry: GoalOverlayEntryInput,
  ): Promise<GoalOverlay> {
    const id = requireGoalId(goalWorkspaceId);
    const current = await this.read(id);
    if (current === null) throw new Error(`unknown goal overlay: ${id}`);
    const validated: GoalOverlayEntry = {
      path: requireRepoRelativePath(entry.path),
      kind: entry.kind,
      contentHash: requireContentHash(entry.contentHash, entry.kind),
    };
    const entries = current.entries.filter((existing) => existing.path !== validated.path);
    entries.push(validated);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const next: GoalOverlay = { ...current, entries, updatedAt: new Date().toISOString() };
    await this.write(id, next);
    return next;
  }

  public async delete(goalWorkspaceId: string): Promise<boolean> {
    try {
      await rm(this.overlayPath(requireGoalId(goalWorkspaceId)), { force: false });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve one path: overlay entry wins (tombstone => null), else the
   * base manifest entry. Returns undefined only when neither knows it.
   */
  public resolve(
    relativePath: string,
    baseEntries: readonly { readonly path: string; readonly contentHash: string }[],
    overlay: GoalOverlay,
  ): string | null | undefined {
    const hit = overlay.entries.find((entry) => entry.path === relativePath);
    if (hit !== undefined) return hit.contentHash;
    return baseEntries.find((entry) => entry.path === relativePath)?.contentHash;
  }

  private overlayPath(goalWorkspaceId: string): string {
    return path.join(this.root, 'overlays', `${goalWorkspaceId}.json`);
  }

  private async write(goalWorkspaceId: string, overlay: GoalOverlay): Promise<void> {
    const finalPath = this.overlayPath(goalWorkspaceId);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(overlay, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}

function isOverlay(value: unknown): value is GoalOverlay {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.goalWorkspaceId === 'string'
    && typeof record.baseManifestId === 'string'
    && Array.isArray(record.entries);
}
