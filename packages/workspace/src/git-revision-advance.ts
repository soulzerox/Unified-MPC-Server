import path from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalRevisionId, type CanonicalRefState } from '@unified-mpc/domain';

import { advanceCanonicalRevision, type AdvanceReuseReport } from './advance-revision.js';
import { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { errorMessage } from './reachability-read.js';
import {
  registerManifestArtifacts,
  type ArtifactClassification,
  type ManifestArtifactRegistrationReport,
} from './manifest-artifact-registration.js';

/** One leaf of a Git tree: a blob and the path it is checked out at. */
export interface CanonicalGitTreeEntry {
  /** Repository-relative path, exactly as `git ls-tree -r` reports it. */
  readonly path: string;
  /** Git object id of the blob. */
  readonly blobOid: string;
  /** Git file mode, for example `100644`, `100755` or `120000`. */
  readonly mode: string;
}

/** Exact revision identity of one commit (#210 §1). */
export interface CanonicalGitRevision {
  readonly commitSha: string;
  /** Git *tree* object id. Revision identity only; never an artifact key. */
  readonly treeOid: string;
  readonly parents: readonly string[];
}

/**
 * Read-only view of one local Git repository (#210 §2).
 *
 * Deliberately a port, not an adapter: `@unified-mpc/workspace` keeps its
 * dependency set and tests drive a fake source, while the `spawn`-based
 * implementation lives at the CLI edge. The contract is narrow on purpose —
 * revision resolution, the tree of that exact revision, and a byte-exact
 * content hash per blob. Nothing here may consult the worktree or the index:
 * the resulting Git tree is truth, and a diff is only an optimization hint.
 */
export interface CanonicalGitSource {
  /** Resolve `targetRef` to the exact commit it points at, or null when it does not resolve. */
  resolveRevision(targetRef: string): Promise<CanonicalGitRevision | null>;
  /** Every leaf of the given commit's tree. */
  listTree(commitSha: string): Promise<readonly CanonicalGitTreeEntry[]>;
  /**
   * SHA-256 (64 lowercase hex) of each blob's exact bytes. Implementations
   * must hash bytes, never a decoded string, so a binary blob is verifiable.
   */
  hashBlobs(blobOids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Canonical remote URL, or null when the repository has no remote. */
  remoteUrl(): Promise<string | null>;
}

export interface GitRevisionAdvanceInput {
  /** Root of the canonical store; refs/manifests/artifacts live beneath it. */
  readonly root: string;
  readonly source: CanonicalGitSource;
  /** Git ref that is also the canonical ref key, for example `refs/remotes/origin/main`. */
  readonly targetRef: string;
  readonly now: Date;
  /** Pins the trust boundary instead of deriving it from the remote URL. */
  readonly repositoryId?: string;
  /**
   * Additional repository ids an already-bound ref may carry.
   *
   * A ref written before the GitHub remote forms were normalized is bound to
   * the released id for this same remote. Naming that id here adopts the ref
   * and re-binds it to `repositoryId` instead of refusing it forever. The list
   * never widens the boundary to a different remote.
   */
  readonly adoptedRepositoryIds?: readonly string[];
  /**
   * Exact commit the caller already verified for `targetRef`.
   *
   * The advance resolves the ref itself, so a caller that checked ancestry (or
   * anything else) against an earlier resolution would otherwise promote a
   * commit its check never saw: a concurrent fetch can move the ref between the
   * two reads. Pinning turns that race into a refusal instead of a promotion.
   */
  readonly commitSha?: string;
}

export interface GitRevisionAdvanceReport {
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly commitSha: string;
  readonly gitTreeOid: string;
  /** Unified tree identity over `path -> contentHash`; what the ref state carries. */
  readonly unifiedTreeOid: string;
  readonly revisionId: string;
  readonly manifestId: string;
  /** Classification of the logical delta against the previously active manifest. */
  readonly reuse: AdvanceReuseReport;
  readonly artifacts:
    | {
      readonly status: 'registered';
      readonly registered: number;
      readonly reused: number;
      /** Manifest paths the source policy does not cover. Never claimed as indexed. */
      readonly unclassified: readonly string[];
    }
    | { readonly status: 'refused'; readonly reason: string };
}

export type GitRevisionAdvanceResult =
  | ({ readonly status: 'promoted' | 'noop' } & GitRevisionAdvanceReport)
  | { readonly status: 'conflict'; readonly targetRef: string; readonly currentCommitSha: string | null }
  | { readonly status: 'refused'; readonly targetRef: string; readonly reason: string };

const REPOSITORY_ID_PREFIX = 'repo:v1:';
/**
 * GitHub remote in each form the tooling meets: `git@github.com:owner/repo`,
 * `ssh://git@github.com/owner/repo` and `https://github.com/owner/repo`
 * (optionally with credentials on the HTTPS form). Everything else keeps the
 * trimmed raw text as its identity.
 */
const GITHUB_REMOTE = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)(github\.com)[:/]([^/]+)\/([^/]+)$/i;
const BLOB_MODES = new Set(['100644', '100755', '120000']);
const CONTENT_HASH = /^[a-f0-9]{64}$/;

/**
 * Stable repository trust boundary derived from a Git remote URL (#210 §1).
 *
 * Content-addressed reuse is only ever claimed inside one boundary, so the
 * identity must be derived from the same observable source everywhere: the
 * remote URL. GitHub's SSH, `ssh://` and HTTPS spellings of one repository
 * (any credentials, any case) hash `github.com/owner/repo`, because the same
 * checkout changing spelling must not become a second trust boundary. An SSH
 * host alias that resolves to github.com is not rewritten here — resolving it
 * needs `ssh -G` side effects that do not belong in an identity function — so
 * such a checkout passes `repositoryId` explicitly. Callers that need a stable
 * id across arbitrary remotes pin `repositoryId` explicitly.
 */
export function repositoryIdForRemoteUrl(remoteUrl: string): string {
  const normalized = normalizeRemoteText(remoteUrl);
  const github = GITHUB_REMOTE.exec(normalized);
  const identity = github === null ? normalized : githubIdentity(github.slice(1));
  return `${REPOSITORY_ID_PREFIX}${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

/**
 * Repository id the released `index revision advance` derived (#210 §1).
 *
 * Kept only to adopt a canonical ref written before GitHub remote forms were
 * normalized: that ref is bound to this id for the same remote, and refusing it
 * would strand a store that only ever used the operator command. New writes use
 * `repositoryIdForRemoteUrl`.
 */
export function legacyRepositoryIdForRemoteUrl(remoteUrl: string): string {
  const normalized = normalizeRemoteText(remoteUrl);
  return `${REPOSITORY_ID_PREFIX}${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function normalizeRemoteText(remoteUrl: string): string {
  const normalized = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (normalized.length === 0) throw new TypeError('remote URL must not be empty');
  return normalized;
}

function githubIdentity(parts: readonly string[]): string {
  const [host = '', owner = '', repo = ''] = parts;
  return `${host.toLowerCase()}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Source classification policy for registered file artifacts (#210 §1/§8).
 *
 * Representation identity must not be invented from whatever the caller has at
 * hand, so this policy is a fixed table: a known extension (or a known
 * extension-less build file) is a text source artifact of that language, and
 * everything else stays unclassified. Unclassified is a real answer — §11
 * forbids reporting a file as indexed when nothing indexed it — and the report
 * carries the paths so a policy gap is visible rather than silent.
 */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'], ['.tsx', 'typescript'],
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'javascript'],
  ['.py', 'python'], ['.rs', 'rust'], ['.go', 'go'], ['.rb', 'ruby'], ['.java', 'java'],
  ['.kt', 'kotlin'], ['.swift', 'swift'], ['.php', 'php'], ['.cs', 'csharp'], ['.lua', 'lua'],
  ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.hpp', 'cpp'],
  ['.json', 'json'], ['.md', 'markdown'], ['.mdx', 'markdown'], ['.html', 'html'], ['.htm', 'html'],
  ['.css', 'css'], ['.scss', 'scss'], ['.vue', 'vue'], ['.svelte', 'svelte'],
  ['.yml', 'yaml'], ['.yaml', 'yaml'], ['.toml', 'toml'], ['.sql', 'sql'],
  ['.sh', 'shell'], ['.bash', 'shell'],
]);

const LANGUAGE_BY_BASENAME: ReadonlyMap<string, string> = new Map([
  ['Dockerfile', 'dockerfile'],
  ['Makefile', 'make'],
]);

/** Representation contract for every classified source artifact. */
export const SOURCE_ARTIFACT_SOURCE_KIND = 'source';
export const SOURCE_ARTIFACT_REPRESENTATION_VERSION = 'v1';

/** Classify one repository-relative path, or null when the policy does not cover it. */
export function classifySourcePath(filePath: string, language?: string): ArtifactClassification | null {
  const languageId = language
    ?? LANGUAGE_BY_EXTENSION.get(path.extname(filePath).toLowerCase())
    ?? LANGUAGE_BY_BASENAME.get(path.posix.basename(filePath));
  if (languageId === undefined) return null;
  return {
    path: filePath,
    language: languageId,
    sourceKind: SOURCE_ARTIFACT_SOURCE_KIND,
    representationVersion: SOURCE_ARTIFACT_REPRESENTATION_VERSION,
  };
}

function refused(targetRef: string, reason: string): GitRevisionAdvanceResult {
  return { status: 'refused', targetRef, reason };
}

/**
 * Drive the Canonical Revision Advancement Gate from one exact Git revision
 * (#210 §3): the missing producer that makes the canonical ref real.
 *
 * Without a producer nothing ever writes a ref or an artifact in production, so
 * every GC pass has an empty candidate set and reuse is never observable. This
 * runs the §3 sequence for one already-fetched `targetRef`:
 *
 * 1. resolve the exact commit the ref points at (never "the latest");
 * 2. read its *Git tree*, not the worktree, and content-hash every blob;
 * 3. classify the logical delta against the active manifest;
 * 4. persist the manifest, then compare-and-swap the ref;
 * 5. register the manifest's entries as content-addressed file artifacts.
 *
 * Ordering is the correctness argument. The state a promoter believes is
 * current is read *before* hashing, so a concurrent advance conflicts instead
 * of being silently overwritten; the manifest is written before the ref moves,
 * so a reader that follows the ref always finds its manifest. `targetVerified`
 * is `true` only because the entries above came from the exact commit's tree
 * with byte-exact hashes — that is the sole meaning the gate accepts for it.
 *
 * Refusals happen before any write: an unresolvable ref, a tree entry that is
 * not a blob (submodule gitlink or nested tree — §8 semantics are not decided,
 * so it is refused rather than skipped), a malformed content hash, a missing
 * repository identity, or an unverifiable base manifest.
 *
 * Artifact registration failures do not undo a promotion: the ref and manifest
 * are the authoritative record and artifacts are re-derivable metadata, so the
 * refusal is reported through `artifacts` instead of throwing. A caller that
 * must not leave the store half-populated should surface it as a failure.
 */
export async function advanceRevisionFromGit(input: GitRevisionAdvanceInput): Promise<GitRevisionAdvanceResult> {
  const { targetRef, source } = input;
  if (!targetRef.startsWith('refs/') || targetRef.includes('..')) {
    return refused(targetRef, 'targetRef must be an exact Git ref starting with refs/');
  }

  const revision = await source.resolveRevision(targetRef);
  if (revision === null) {
    return refused(targetRef, `ref ${targetRef} does not resolve to a commit`);
  }
  if (input.commitSha !== undefined && revision.commitSha !== input.commitSha) {
    return refused(
      targetRef,
      `ref ${targetRef} moved to ${revision.commitSha} after the caller verified ${input.commitSha}`,
    );
  }

  let repositoryId = input.repositoryId;
  let adoptedRepositoryIds = input.adoptedRepositoryIds;
  if (repositoryId === undefined) {
    const remote = await source.remoteUrl();
    if (remote === null) {
      return refused(targetRef, 'repository has no remote; pass an explicit repository id');
    }
    try {
      repositoryId = repositoryIdForRemoteUrl(remote);
      // A ref written by the released operator command for this same remote is
      // bound to the pre-normalization id; adopt it once and re-bind.
      adoptedRepositoryIds = [legacyRepositoryIdForRemoteUrl(remote)];
    } catch (error) {
      return refused(targetRef, error instanceof Error ? error.message : String(error));
    }
  }

  const refs = new CanonicalRefStore(input.root);
  const manifests = new CanonicalManifestStore(input.root);
  const artifacts = new CanonicalArtifactStore(input.root);

  // Read the believed-current state before the (potentially slow) hashing pass
  // so a concurrent advance is detected as a conflict at promote time. Strict:
  // a corrupt ref must refuse before any hashing or write, not read as "never
  // promoted" and be replaced by this advance.
  let expectedCurrent: CanonicalRefState | null;
  try {
    expectedCurrent = await refs.read(targetRef, { strict: true });
  } catch (error) {
    return refused(targetRef, errorMessage(error));
  }

  const tree = await source.listTree(revision.commitSha);
  const unsupported = tree.filter((entry) => !BLOB_MODES.has(entry.mode)).map((entry) => entry.path);
  if (unsupported.length > 0) {
    return refused(targetRef, `tree entries are not blobs: ${[...unsupported].sort().slice(0, 5).join(', ')}`
      + (unsupported.length > 5 ? ` (+${unsupported.length - 5} more)` : ''));
  }

  const seen = new Set<string>();
  for (const entry of tree) {
    if (entry.path.length === 0 || entry.path.startsWith('/') || entry.path.includes('..')) {
      return refused(targetRef, `invalid tree path: ${entry.path}`);
    }
    if (seen.has(entry.path)) return refused(targetRef, `duplicate tree path: ${entry.path}`);
    seen.add(entry.path);
  }

  const hashes = await source.hashBlobs(tree.map((entry) => entry.blobOid));
  const targetEntries: { readonly path: string; readonly contentHash: string }[] = [];
  for (const entry of tree) {
    const contentHash = hashes.get(entry.blobOid);
    if (contentHash === undefined) {
      return refused(targetRef, `no content hash for blob ${entry.blobOid} (${entry.path})`);
    }
    const normalized = contentHash.toLowerCase();
    if (!CONTENT_HASH.test(normalized)) {
      return refused(targetRef, `content hash for ${entry.path} is not an exact SHA-256`);
    }
    targetEntries.push({ path: entry.path, contentHash: normalized });
  }

  let revisionId: string;
  try {
    revisionId = canonicalRevisionId({
      repositoryId,
      commitSha: revision.commitSha,
      treeOid: revision.treeOid,
      targetRef,
      parents: revision.parents,
    });
  } catch (error) {
    return refused(targetRef, error instanceof Error ? error.message : String(error));
  }

  const advanced = await advanceCanonicalRevision(manifests, refs, {
    canonicalRef: targetRef,
    repositoryId,
    ...(adoptedRepositoryIds === undefined ? {} : { adoptedRepositoryIds }),
    revisionId,
    commitSha: revision.commitSha,
    targetEntries,
    expectedCurrent,
    // Entries came from the exact commit's tree with byte-exact hashes.
    targetVerified: true,
    createdAt: input.now.toISOString(),
  });

  if (advanced.status === 'conflict') {
    return { status: 'conflict', targetRef, currentCommitSha: advanced.current?.commitSha ?? null };
  }
  if (advanced.status === 'rejected') {
    return refused(targetRef, advanced.reason);
  }
  const decision = advanced.decision;
  if (decision.action !== 'promote' && decision.action !== 'noop') {
    // Unreachable: `advanceCanonicalRevision` only reports promoted/noop with a
    // promotion decision, but the gate's type is wider than the status it
    // reports, so state the invariant instead of trusting it.
    return refused(targetRef, 'advancement gate produced no promotion decision');
  }

  const classifications: ArtifactClassification[] = [];
  for (const entry of targetEntries) {
    const classification = classifySourcePath(entry.path);
    if (classification !== null) classifications.push(classification);
  }
  const registration: ManifestArtifactRegistrationReport = await registerManifestArtifacts({
    manifests,
    store: artifacts,
    manifestId: advanced.manifestId,
    now: input.now,
    classifications,
  });

  return {
    status: advanced.status,
    repositoryId,
    targetRef,
    commitSha: revision.commitSha,
    gitTreeOid: revision.treeOid,
    unifiedTreeOid: decision.target.treeOid,
    revisionId,
    manifestId: advanced.manifestId,
    reuse: {
      reusedPaths: advanced.reusedPaths,
      newPaths: advanced.newPaths,
      renamedPaths: advanced.renamedPaths,
      deletedPaths: advanced.deletedPaths,
    },
    artifacts: registration.status === 'registered'
      ? {
        status: 'registered',
        registered: registration.artifacts.filter((artifact) => !artifact.reused).length,
        reused: registration.artifacts.filter((artifact) => artifact.reused).length,
        unclassified: registration.unclassifiedPaths,
      }
      : { status: 'refused', reason: registration.reason },
  };
}
