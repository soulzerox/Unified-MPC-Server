/**
 * Issue #80 slice 1 — read-only classification of ledger-owned worktrees.
 *
 * The reconciler never mutates anything: it answers one question per worktree —
 * can this worktree's lifecycle owner safely clean it up, or must it be kept?
 * Deletion itself stays a separate, gated surface (phase-44).
 */

export type GoalWorktreeBlocker =
  | 'externally_owned'
  | 'active_lease'
  | 'path_missing'
  | 'dirty'
  | 'unmerged_changes'
  | 'unintegrated_head'
  | 'probe_failed';

/** Canonical emission order; classifiers append freely and the entry sorts. */
export const GOAL_WORKTREE_BLOCKER_ORDER: readonly GoalWorktreeBlocker[] = [
  'externally_owned',
  'active_lease',
  'path_missing',
  'dirty',
  'unmerged_changes',
  'unintegrated_head',
  'probe_failed',
];

export type GoalWorktreeDisposition = 'safe_to_clean' | 'keep';

export interface GoalWorktreeDescriptor {
  /** Absolute worktree path as recorded in the ownership ledger. */
  readonly worktreePath: string;
  /** Branch/ref the ledger says the worktree was created from. */
  readonly ref: string;
  /** Client id that created/owns the worktree. */
  readonly owner: string;
  /** Owning client session, when the ledger pins one. */
  readonly ownerSessionId?: string;
}

export interface GoalWorktreeStatusProbe {
  /** Changed/untracked entries in `git status --porcelain`. */
  readonly dirtyEntries: number;
  /** Unmerged (conflicted) index entries. */
  readonly unmergedEntries: number;
}

/** Read-only git primitives required to classify one worktree. */
export interface GoalWorktreeGitPort {
  /** Whether the worktree path still exists on disk. */
  exists(worktreePath: string): Promise<boolean>;
  /** Porcelain status counts for the worktree (throws on git failure). */
  status(worktreePath: string): Promise<GoalWorktreeStatusProbe>;
  /** HEAD sha of the worktree repository, or null when unresolvable. */
  headSha(worktreePath: string): Promise<string | null>;
  /** Whether the worktree HEAD is contained by the integration base. */
  isAncestor(input: GoalWorktreeAncestryProbeInput): Promise<'yes' | 'no' | 'unknown'>;
}

export interface GoalWorktreeAncestryProbeInput {
  readonly worktreePath: string;
  readonly ref: string;
  readonly base: string;
}

export interface GoalWorktreeReconcilerActor {
  readonly clientId: string;
  readonly sessionId?: string;
}

export interface GoalWorktreeClassificationOptions {
  /** Worktree paths currently claimed by a live goal lease. */
  readonly activeLeaseWorktreePaths?: ReadonlySet<string>;
  /** Integration ref that proves a head was merged (default `origin/main`). */
  readonly integrationBase?: string;
}

export interface GoalWorktreeClassificationEntry {
  readonly worktreePath: string;
  readonly ref: string;
  readonly owner: string;
  readonly disposition: GoalWorktreeDisposition;
  readonly blockers: readonly GoalWorktreeBlocker[];
  readonly blockerDetails: readonly string[];
}

export interface GoalWorktreeClassificationReport {
  readonly integrationBase: string;
  readonly entries: readonly GoalWorktreeClassificationEntry[];
  readonly safeToCleanCount: number;
  readonly keepCount: number;
}

function sortByBlockerOrder(blockers: readonly GoalWorktreeBlocker[]): GoalWorktreeBlocker[] {
  return [...blockers].sort(
    (left, right) => GOAL_WORKTREE_BLOCKER_ORDER.indexOf(left) - GOAL_WORKTREE_BLOCKER_ORDER.indexOf(right),
  );
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GoalWorktreeReconciliationService {
  private readonly git: GoalWorktreeGitPort;
  private readonly defaultIntegrationBase = 'origin/main';

  public constructor(options: { readonly git: GoalWorktreeGitPort }) {
    this.git = options.git;
  }

  /**
   * Classify every provided ledger entry. Never throws per entry: any probe
   * failure degrades that entry to `keep` with the `probe_failed` blocker
   * (fail-closed — unprovable means keep), while the remaining entries are
   * still classified.
   */
  public async classify(
    entries: readonly GoalWorktreeDescriptor[],
    options: GoalWorktreeClassificationOptions & { readonly actor: GoalWorktreeReconcilerActor },
  ): Promise<GoalWorktreeClassificationReport> {
    const integrationBase = options.integrationBase ?? this.defaultIntegrationBase;
    const classified = await Promise.all(entries.map(async (entry) => {
      return this.classifyEntry(entry, options.actor, options.activeLeaseWorktreePaths, integrationBase);
    }));
    return {
      integrationBase,
      entries: classified,
      safeToCleanCount: classified.filter((row) => row.disposition === 'safe_to_clean').length,
      keepCount: classified.filter((row) => row.disposition === 'keep').length,
    };
  }

  private async classifyEntry(
    entry: GoalWorktreeDescriptor,
    actor: GoalWorktreeReconcilerActor,
    activeLeaseWorktreePaths: ReadonlySet<string> | undefined,
    integrationBase: string,
  ): Promise<GoalWorktreeClassificationEntry> {
    const blockers = new Set<GoalWorktreeBlocker>();
    const blockerDetails: string[] = [];

    if (entry.owner !== actor.clientId) {
      blockers.add('externally_owned');
    } else if (entry.ownerSessionId !== undefined && entry.ownerSessionId !== actor.sessionId) {
      blockers.add('externally_owned');
    }

    if (activeLeaseWorktreePaths?.has(entry.worktreePath) === true) {
      blockers.add('active_lease');
    }

    let pathPresent: boolean;
    try {
      pathPresent = await this.git.exists(entry.worktreePath);
    } catch (error: unknown) {
      blockers.add('probe_failed');
      blockerDetails.push(`existence probe failed: ${detailOf(error)}`);
      return this.report(entry, blockers, blockerDetails);
    }
    if (!pathPresent) {
      blockers.add('path_missing');
      return this.report(entry, blockers, blockerDetails);
    }

    try {
      const status = await this.git.status(entry.worktreePath);
      if (status.dirtyEntries > 0) blockers.add('dirty');
      if (status.unmergedEntries > 0) blockers.add('unmerged_changes');
    } catch (error: unknown) {
      blockers.add('probe_failed');
      blockerDetails.push(`status probe failed: ${detailOf(error)}`);
      return this.report(entry, blockers, blockerDetails);
    }

    try {
      const head = await this.git.headSha(entry.worktreePath);
      if (head === null) {
        blockers.add('probe_failed');
        blockerDetails.push('HEAD sha unresolvable');
        return this.report(entry, blockers, blockerDetails);
      }
      const ancestry = await this.git.isAncestor({ worktreePath: entry.worktreePath, ref: entry.ref, base: integrationBase });
      if (ancestry === 'no') {
        blockers.add('unintegrated_head');
      } else if (ancestry === 'unknown') {
        blockers.add('probe_failed');
        blockerDetails.push('integration ancestry probe failed');
        return this.report(entry, blockers, blockerDetails);
      }
    } catch (error: unknown) {
      blockers.add('probe_failed');
      blockerDetails.push(`integration probe failed: ${detailOf(error)}`);
      return this.report(entry, blockers, blockerDetails);
    }

    return this.report(entry, blockers, blockerDetails);
  }

  private report(
    entry: GoalWorktreeDescriptor,
    blockers: ReadonlySet<GoalWorktreeBlocker>,
    blockerDetails: readonly string[],
  ): GoalWorktreeClassificationEntry {
    const ordered = sortByBlockerOrder([...blockers]);
    return {
      worktreePath: entry.worktreePath,
      ref: entry.ref,
      owner: entry.owner,
      disposition: ordered.length === 0 ? 'safe_to_clean' : 'keep',
      blockers: ordered,
      blockerDetails,
    };
  }
}
