import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What the provider must find on disk for one expected path.
 *
 * `unfenceable` covers a symlink, a non-regular file, an unreadable path or a
 * name that escapes the workspace: the scanner may skip it or read it through
 * a different policy, so declaring a hash would turn an ordinary index into a
 * stale verdict. Such a path is omitted from both fences.
 */
export type LiveContentHash =
  | { readonly kind: 'file'; readonly contentHash: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unfenceable' };

export interface CanonicalSourceExpectationInput {
  /** Absolute workspace root the request indexes. */
  readonly rootPath: string;
  /** Exact requested repo-relative paths, or null for a full request. */
  readonly requestedPaths: readonly string[] | null;
  /**
   * Effective path->content-hash view: the admitted Goal logical view or the
   * manifest of the revision this checkout is actually on. Null when no
   * revision describes the worktree, so a full request has no path set.
   */
  readonly view: ReadonlyMap<string, string> | null;
  /** Removals already observed in the worktree (tracked deletions, tombstones). */
  readonly deletedPaths?: readonly string[];
}

export interface CanonicalSourceExpectations {
  readonly expectedPaths: Readonly<Record<string, string>>;
  readonly deletedPaths: readonly string[];
  /**
   * Paths the view claims but the worktree no longer holds: a tracked file
   * whose bytes differ from the view entry, or a view entry missing from disk
   * without a declared removal. A caller that still claimed the view for this
   * request would publish those bytes under it, so the adapter downgrades the
   * binding instead of treating the fence as a claim about the revision.
   */
  readonly driftedPaths: readonly string[];
}

/** A requested path the caller cannot describe at all: neither view nor disk knows it. */
export class CanonicalSourceExpectationError extends Error {
  public constructor(public readonly relativePath: string) {
    super(`requested path ${relativePath} exists in neither the workspace nor the canonical view`);
    this.name = 'CanonicalSourceExpectationError';
  }
}

/**
 * Build the provider's source fence for one `code_index` request (#210 §13).
 *
 * `expected_paths` is the hash of the byte the scanner will read: the
 * effective-view hash when the worktree still holds it, and the live content
 * hash for a path the view does not describe or no longer matches. The fence
 * never declares a view hash for bytes the worktree already contradicts —
 * doing so turns a dirty checkout or an unsynced Goal overlay into
 * `stale_index`, and the provider only ever observes the live byte. Paths whose
 * bytes disagree with the view are reported in `driftedPaths` so the caller can
 * stop claiming the view for this request instead of publishing drift under it.
 * A tracked path that is absent from disk is never an expectation — the
 * scanner cannot observe bytes for it — so it becomes a declaration in
 * `deleted_paths` and is removed from the fence. A requested path that exists
 * nowhere is refused before the child call instead of being "declared" as a
 * deletion the caller never owned.
 *
 * A removal is a declaration, not a fence: it never hides an unexpected live
 * file, so it needs no skip-policy rule in the caller.
 */
export async function buildCanonicalSourceExpectations(
  input: CanonicalSourceExpectationInput,
): Promise<CanonicalSourceExpectations> {
  const declared = new Set<string>();
  for (const removal of input.deletedPaths ?? []) {
    const normalized = normalizeRelativePath(removal);
    if (normalized !== null) declared.add(normalized);
  }
  const candidates = input.requestedPaths === null
    ? [...(input.view?.keys() ?? [])]
    : dedupeRequestedPaths(input.requestedPaths);
  const expected = new Map<string, string>();
  const deleted = new Set<string>();
  const drifted = new Set<string>();
  for (const candidate of candidates) {
    if (declared.has(candidate)) {
      deleted.add(candidate);
      continue;
    }
    const live = await hashLivePath(input.rootPath, candidate);
    if (live.kind === 'unfenceable') continue;
    if (live.kind === 'file') {
      const viewHash = input.view?.get(candidate);
      if (viewHash !== undefined && viewHash !== live.contentHash) {
        // The view says these bytes belong to the declared revision, but the
        // worktree holds something else. Fence what the scanner will actually
        // read, and report the disagreement so the caller does not claim the
        // view for it.
        drifted.add(candidate);
        expected.set(candidate, live.contentHash);
        continue;
      }
      expected.set(candidate, viewHash ?? live.contentHash);
      continue;
    }
    if (input.view?.has(candidate) === true) {
      // Tracked in the view but gone from the worktree: a removal is only a
      // declaration, so it is drift unless the caller already declared it.
      drifted.add(candidate);
      deleted.add(candidate);
      continue;
    }
    if (input.requestedPaths !== null) throw new CanonicalSourceExpectationError(candidate);
  }
  for (const removal of declared) {
    // A declared removal must never also carry a content hash: the provider
    // refuses that contradiction.
    expected.delete(removal);
    deleted.add(removal);
  }
  return {
    expectedPaths: Object.fromEntries([...expected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    deletedPaths: [...deleted].sort(),
    driftedPaths: [...drifted].sort(),
  };
}

/**
 * Hash the byte the provider scanner will read for one repo-relative path.
 *
 * `lstat` is deliberate: a symlink is `unfenceable` rather than hashed through
 * its target, because the scanner's own skip policy may refuse or follow it.
 */
export async function hashLivePath(rootPath: string, relativePath: string): Promise<LiveContentHash> {
  const resolved = resolveInsideRoot(rootPath, relativePath);
  if (resolved === null) return { kind: 'unfenceable' };
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unfenceable' };
  }
  if (!metadata.isFile()) return { kind: 'unfenceable' };
  try {
    const bytes = await readFile(resolved);
    return { kind: 'file', contentHash: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { kind: 'unfenceable' };
  }
}

function resolveInsideRoot(rootPath: string, relativePath: string): string | null {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === null) return null;
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, resolved);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function normalizeRelativePath(value: string): string | null {
  if (value.length === 0 || value.includes(String.fromCharCode(0))) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized.startsWith('/') || normalized.startsWith('../')) return null;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function dedupeRequestedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of paths) {
    const candidate = normalizeRelativePath(value);
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}
