import { execFile, spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { promisify } from 'node:util';

import {
  legacyRepositoryIdForRemoteUrl,
  repositoryIdForRemoteUrl,
  type CanonicalGitRevision,
  type CanonicalGitSource,
  type CanonicalGitTreeEntry,
} from '@unified-mpc/workspace';

import { githubRepositoryFromRemote } from './github-remote.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const LS_TREE_MAX_BUFFER = 64 * 1024 * 1024;

async function gitText(cwd: string, args: readonly string[], maxBuffer = 1024 * 1024): Promise<string | null> {
  try {
    const result = await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer });
    return result.stdout;
  } catch {
    return null;
  }
}

interface BatchFrame {
  readonly oid: string;
  readonly size: number;
  readonly hash: Hash;
}

/**
 * Real `CanonicalGitSource` over one checkout (#210 §2/§6).
 *
 * Everything this reads is Git plumbing against an exact object id, never the
 * worktree or the index, so the values it returns describe the commit rather
 * than whatever happens to be checked out.
 *
 * `cat-file --batch` serves the whole tree in one process. The reader is a
 * size-framed state machine over raw bytes: the header gives the blob length,
 * exactly that many bytes are streamed into a SHA-256, and the trailing
 * newline closes the frame. Nothing is buffered whole and nothing is decoded
 * as text, so a binary blob is hashed as bytes and a large blob cannot blow up
 * memory.
 */
export function createCanonicalGitSource(cwd: string): CanonicalGitSource {
  return {
    async resolveRevision(targetRef: string): Promise<CanonicalGitRevision | null> {
      if (!targetRef.startsWith('refs/') || targetRef.includes('..')) return null;
      const commit = (await gitText(cwd, ['rev-parse', '--verify', '--quiet', `${targetRef}^{commit}`]))?.trim();
      if (commit === undefined || commit.length === 0) return null;
      const treeOid = (await gitText(cwd, ['rev-parse', '--verify', `${commit}^{tree}`]))?.trim();
      if (treeOid === undefined || treeOid.length === 0) return null;
      const parentsLine = (await gitText(cwd, ['rev-list', '--parents', '-n', '1', commit]))?.trim() ?? '';
      const parents = parentsLine.split(/\s+/).slice(1).filter((parent) => parent.length > 0);
      return { commitSha: commit, treeOid, parents };
    },

    async listTree(commitSha: string): Promise<readonly CanonicalGitTreeEntry[]> {
      const raw = await gitText(cwd, ['ls-tree', '-r', '-z', '--full-tree', commitSha], LS_TREE_MAX_BUFFER);
      if (raw === null) throw new Error(`git ls-tree failed for ${commitSha}`);
      const entries: CanonicalGitTreeEntry[] = [];
      for (const record of raw.split('\u0000')) {
        if (record.length === 0) continue;
        const tab = record.indexOf('\t');
        if (tab < 0) throw new Error(`unexpected git ls-tree record: ${record}`);
        const [mode, , oid] = record.slice(0, tab).split(' ');
        if (mode === undefined || oid === undefined) throw new Error(`unexpected git ls-tree record: ${record}`);
        entries.push({ path: record.slice(tab + 1), blobOid: oid, mode });
      }
      return entries;
    },

    hashBlobs: (blobOids: readonly string[]): Promise<ReadonlyMap<string, string>> => hashBlobs(cwd, blobOids),

    async remoteUrl(): Promise<string | null> {
      const url = (await gitText(cwd, ['remote', 'get-url', 'origin']))?.trim();
      return url === undefined || url.length === 0 ? null : url;
    },
  };
}

/**
 * Repository identities a Goal worktree may legitimately pin (#210 §1).
 *
 * Canonical refs are store-wide and two repositories can share a commit sha, so
 * the admission guard needs the identity the worktree itself belongs to. Both
 * the current normalized id and the id the released operator command wrote for
 * the same remote are accepted once. A checkout without `origin` has no
 * provable identity, and `null` lets admission skip instead of guessing.
 */
export async function resolveGoalRepositoryIds(
  worktreePath: string,
  sourceFor: (cwd: string) => CanonicalGitSource = createCanonicalGitSource,
): Promise<readonly string[] | null> {
  const remote = await sourceFor(worktreePath).remoteUrl();
  if (remote === null) return null;
  return [repositoryIdForRemoteUrl(remote), legacyRepositoryIdForRemoteUrl(remote)];
}

/** Minimal merge-policy lookup the base-branch resolver needs. */
export interface GoalBaseBranchPolicyPort {
  getByRepository(repository: string): Promise<{ readonly defaultBranch: string } | undefined>;
}

/**
 * Branch admission must treat as the moving base (#210 §1).
 *
 * Merge reconciliation advances the canonical ref for the policy's
 * `defaultBranch`; admission must read the same ref or a non-main policy never
 * pins. A repository without a policy keeps the checkout's main/master branch,
 * and a feature checkout falls back to `main` (its exact HEAD is pinned
 * instead, so the branch name only selects the ref admission may match).
 */
export async function resolveGoalBaseBranch(
  worktreePath: string,
  currentBranch: string,
  policyFor: GoalBaseBranchPolicyPort,
  sourceFor: (cwd: string) => CanonicalGitSource = createCanonicalGitSource,
): Promise<string> {
  const fallback = currentBranch === 'main' || currentBranch === 'master' ? currentBranch : 'main';
  const remote = await sourceFor(worktreePath).remoteUrl();
  if (remote === null) return fallback;
  // A local or unknown remote cannot have a merge policy; the reconciliation
  // path that advances canonical refs requires this same GitHub identity.
  const repository = await githubRepositoryFromRemote(remote).catch(() => undefined);
  if (repository === undefined) return fallback;
  const policy = await policyFor.getByRepository(repository);
  const configured = policy?.defaultBranch.trim() ?? '';
  return configured.length === 0 ? fallback : configured;
}

async function hashBlobs(cwd: string, blobOids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const digests = new Map<string, string>();
  if (blobOids.length === 0) return digests;

  const child = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const closed = new Promise<number>((resolve, reject) => {
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', reject);
  });

  let pending: Buffer = Buffer.alloc(0);
  let frame: BatchFrame | null = null;
  let awaitingTerminator = false;
  let failure: Error | null = null;

  const consume = (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (failure !== null) return;
      if (awaitingTerminator) {
        if (pending.length === 0) return;
        if (pending[0] !== 0x0a) {
          failure = new Error(`git cat-file frame ${frame?.oid ?? '?'} is not newline-terminated`);
          return;
        }
        pending = pending.subarray(1);
        if (frame !== null) digests.set(frame.oid, frame.hash.digest('hex'));
        frame = null;
        awaitingTerminator = false;
        continue;
      }
      if (frame === null) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) return;
        const header = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        const parts = header.split(' ');
        if (parts.length !== 3) {
          failure = new Error(`git cat-file could not read blob: ${header}`);
          return;
        }
        const [oid, type, sizeText] = parts as [string, string, string];
        const size = Number.parseInt(sizeText, 10);
        if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
          failure = new Error(`git cat-file returned ${type} ${sizeText} for ${oid}`);
          return;
        }
        frame = { oid, size, hash: createHash('sha256') };
        continue;
      }
      if (frame.size === 0) {
        awaitingTerminator = true;
        continue;
      }
      if (pending.length === 0) return;
      const take = Math.min(frame.size, pending.length);
      frame.hash.update(pending.subarray(0, take));
      pending = pending.subarray(take);
      frame = { oid: frame.oid, size: frame.size - take, hash: frame.hash };
      if (frame.size === 0) awaitingTerminator = true;
    }
  };

  try {
    child.stdin.end(`${blobOids.join('\n')}\n`);
    for await (const chunk of child.stdout) consume(chunk as Buffer);
    const code = await closed;
    if (failure !== null) throw failure;
    if (code !== 0) throw new Error(`git cat-file --batch exited ${code}: ${stderr.trim()}`);
    if (frame !== null || awaitingTerminator) throw new Error('git cat-file --batch ended mid-frame');
    return digests;
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}
