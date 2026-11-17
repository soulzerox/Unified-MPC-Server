import { createHash } from 'node:crypto';
import { appError, err, ok, type InvocationAuthorization, type Result, type WorkspaceEvidenceFreshness } from '@unified-mpc/domain';
import type { McpToolContext } from './tools/tool-types.js';

const DEFAULT_VERIFY_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 250;
const LOG_TAIL_LINES = 80;

interface VerificationCacheEntry {
  readonly cacheKey: string;
  /**
   * The repository and worktree the cached result belongs to. A result from
   * another checkout can never be reused, which is a different answer from a
   * result that is merely out of date.
   */
  readonly evidenceIdentity: string;
  readonly value: Record<string, unknown>;
  readonly bytes: number;
}

export interface IncrementalVerifierCacheStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly bytesSaved: number;
}

export interface IncrementalVerifierOptions {
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** Shared across per-request MCP server factories so unchanged diffs hit cache. */
export class IncrementalVerifier {
  private readonly cache = new Map<string, VerificationCacheEntry>();
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private bytesSaved = 0;

  public constructor(options: IncrementalVerifierOptions = {}) {
    this.maxWaitMs = positiveFinite(options.maxWaitMs, DEFAULT_VERIFY_WAIT_MS);
    this.pollMs = positiveFinite(options.pollMs, DEFAULT_POLL_MS);
    this.now = options.now ?? Date.now;
  }

  public async verify(context: McpToolContext, workspaceId: string, signal: AbortSignal, userConfirmed = false, authorization?: InvocationAuthorization): Promise<Result<Record<string, unknown>>> {
    const git = context.services.git;
    const processService = context.services.process;
    if (git === undefined || processService === undefined) {
      return err(appError('INTERNAL_ERROR', 'Incremental verification services are unavailable', true));
    }

    const fingerprint = await buildDiffFingerprint(context, workspaceId, signal);
    if (!fingerprint.ok) return fingerprint;
    const cached = this.cache.get(workspaceId);
    if (cached?.cacheKey === fingerprint.value.cacheKey) {
      this.hits += 1;
      this.bytesSaved += cached.bytes;
      return ok({
        cache: 'hit',
        reuse: 'fresh',
        cache_key: cached.cacheKey,
        changed_files: fingerprint.value.changedFiles,
        ...cached.value,
      });
    }
    // `fresh` is the hit above; everything else is why the previous result was not
    // reused, in the domain's freshness vocabulary.
    //
    // This surface answers "may I reuse this result?", which is not the question
    // `classifyWorkspaceSourceEvidence` answers ("does this evidence still describe
    // this observation?"). For the same drift the two differ on purpose: that
    // classifier reports every identity change as `stale` because evidence only ever
    // describes one observation, while a cached result from another checkout is
    // `not_reusable` — it can never apply here, no matter how the source moves.
    const reuse: WorkspaceEvidenceFreshness = cached === undefined
      ? 'unknown'
      : cached.evidenceIdentity === fingerprint.value.evidenceIdentity ? 'stale' : 'not_reusable';
    this.misses += 1;

    if (signal.aborted) return cancelledVerification();
    const started = await processService.startProjectCommand(context.actor, workspaceId, 'typecheck', signal, userConfirmed, undefined, authorization);
    if (!started.ok) return started;
    let process = started.value;
    const deadline = this.now() + this.maxWaitMs;
    while (process.state === 'starting' || process.state === 'running' || process.state === 'termination_unverified') {
      if (signal.aborted) return cancelledVerification();
      if (this.now() >= deadline) {
        return err(appError(
          'PROCESS_TIMEOUT',
          'Incremental typecheck is still running after 5 minutes. For longer verification, launch it as a durable background shell task and record the task_id in the tracker.',
          true,
        ));
      }
      await delay(this.pollMs, signal);
      if (signal.aborted) return cancelledVerification();
      const status = await processService.status(context.actor, workspaceId, process.processId);
      if (!status.ok) return status;
      process = status.value;
    }

    const logs = await processService.logs(context.actor, workspaceId, process.processId, { tailLines: LOG_TAIL_LINES });
    if (!logs.ok) return logs;
    const passed = process.state === 'exited' && process.exitCode === 0;
    const verification = {
      passed,
      process_id: process.processId,
      state: process.state,
      command: { executable: process.executable, args: [...process.args], cwd: process.cwd },
      ...(process.exitCode === undefined ? {} : { exit_code: process.exitCode }),
      ...(process.error === undefined ? {} : { error: process.error }),
      logs: logs.value.entries,
      logs_truncated: logs.value.truncated,
      verified_at: new Date(this.now()).toISOString(),
    } satisfies Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(verification), 'utf8');
    this.cache.set(workspaceId, {
      cacheKey: fingerprint.value.cacheKey,
      evidenceIdentity: fingerprint.value.evidenceIdentity,
      value: verification,
      bytes,
    });
    return ok({
      cache: 'miss',
      reuse,
      cache_key: fingerprint.value.cacheKey,
      changed_files: fingerprint.value.changedFiles,
      ...verification,
    });
  }

  public stats(): IncrementalVerifierCacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      bytesSaved: this.bytesSaved,
    };
  }

  public invalidate(workspaceId?: string): number {
    if (workspaceId === undefined) {
      const removed = this.cache.size;
      this.cache.clear();
      this.hits = 0;
      this.misses = 0;
      this.bytesSaved = 0;
      return removed;
    }
    return this.cache.delete(workspaceId) ? 1 : 0;
  }
}

async function buildDiffFingerprint(
  context: McpToolContext,
  workspaceId: string,
  signal: AbortSignal,
): Promise<Result<{ readonly cacheKey: string; readonly evidenceIdentity: string; readonly changedFiles: readonly string[] }>> {
  const git = context.services.git;
  if (git === undefined) return err(appError('INTERNAL_ERROR', 'Git service is unavailable', true));
  const before = await git.observeWorkspace(context.actor, workspaceId, {}, signal);
  if (!before.ok) return before;
  const unstaged = await git.diff(context.actor, workspaceId, { maxBytes: 2 * 1024 * 1024 }, signal);
  if (!unstaged.ok) return unstaged;
  const staged = await git.diff(context.actor, workspaceId, { staged: true, maxBytes: 2 * 1024 * 1024 }, signal);
  if (!staged.ok) return staged;
  const after = await git.observeWorkspace(context.actor, workspaceId, {}, signal);
  if (!after.ok) return after;
  // The fence compares the same set the key decides on, so a branch rename that
  // races the fingerprinting cannot abort a verification it could not invalidate.
  if (sourceKey(before.value) !== sourceKey(after.value)) {
    return err(appError('CONFLICT', 'Workspace source changed during incremental verification fingerprinting', true));
  }
  const changedFiles = after.value.statusEntries.map((entry) => entry.path).sort();
  const hash = createHash('sha256')
    .update(sourceKey(after.value))
    .update('\0')
    .update(JSON.stringify(after.value.statusEntries))
    .update('\0')
    .update(unstaged.value.patch)
    .update('\0')
    .update(staged.value.patch)
    .digest('hex');
  return ok({
    cacheKey: hash,
    evidenceIdentity: `${after.value.repositoryIdentity}\0${after.value.worktreeIdentity}`,
    changedFiles,
  });
}

/**
 * The fields that decide whether a cached typecheck result still describes the
 * source: the repository and worktree it belongs to, the head it was taken at and
 * both dirty fingerprints.
 *
 * The branch name is deliberately absent. A rename or a detached checkout at an
 * identical head with identical patches is the same source, and re-running the
 * typecheck for it would be wasted work — so the mid-read fence and the cache key
 * both ignore it.
 */
function sourceKey(source: {
  readonly repositoryIdentity: string;
  readonly worktreeIdentity: string;
  readonly head: string;
  readonly dirtyFingerprint: string;
  readonly stagedFingerprint: string;
}): string {
  return JSON.stringify([
    source.repositoryIdentity,
    source.worktreeIdentity,
    source.head,
    source.dirtyFingerprint,
    source.stagedFingerprint,
  ]);
}

function cancelledVerification(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Incremental verification was cancelled', true));
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
