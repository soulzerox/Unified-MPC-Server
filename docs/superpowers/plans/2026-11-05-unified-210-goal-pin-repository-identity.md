# Unified #210 slice — Goal pin repository identity

Issue: soulzerox/Unified-MPC-Server#210 (§1 per-repository trust boundary,
§4 Goal Workspace admission gate, §7 retain active Goal bases)
Origin: nonblocking finding 4 from the PR #656 exact-head review.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The Goal admission pin compares only commit shas against one store-wide
`refs/remotes/origin/<branch>`:

~~~text
Goal worktree (repository A)
  -> pinGoalBaseAtCommit(canonicalRef, commitSha)
  -> canonical ref manifest belongs to repository B   <- never checked
~~~

Canonical refs are bound to one repository through the manifest's
`repositoryId` (`canonical-merge-advance.ts:207-217,279-284`), and every
workspace in one data path shares `<dataPath>/canonical`. Two repositories can
share a commit sha (forks, mirrors, cherry-picks), so a Goal from repository A
can currently pin repository B's live manifest. That contradicts §1's
per-repository trust boundary and roots GC at the wrong repository's manifest.

## What lands

### 1. `pinGoalBaseAtCommit` checks the live manifest's repository id

`packages/workspace/src/goal-admission.ts` gains an optional fourth argument:

~~~ts
{
  manifests: CanonicalManifestStore;
  expectedRepositoryIds: readonly string[];
}
~~~

The guard runs only after the strict ref read and the exact commit match:

- the live ref's manifest is read and its `repositoryId` must be one of the
  expected ids; otherwise the outcome is `skipped/repository_mismatch` and no
  overlay is created;
- a live ref whose manifest row is missing is `failed`, not a skip: pinning it
  would create an overlay that roots GC at a manifest that does not exist;
- without the guard the previous behaviour is unchanged, so library callers
  that have no repository identity keep working.

### 2. The admission port carries the created worktree

`GoalCanonicalAdmissionPort.pinBaseAtCommit` input gains `worktreePath`, and
`GoalWorkspaceService.create` passes the worktree it just created. The runtime
resolves repository ids from the Goal worktree itself, not from the parent, so
the identity is the one the new workspace actually belongs to.

### 3. Runtime resolves both accepted repository ids

`apps/cli/src/runtime/canonical-git-source.ts` gains
`resolveGoalRepositoryIds(worktreePath, sourceFor?)`:

- reads `origin` through `createCanonicalGitSource`;
- returns `[repositoryIdForRemoteUrl(remote), legacyRepositoryIdForRemoteUrl(remote)]`,
  because a ref or manifest written by the released operator command is bound
  to the pre-normalization id for the same remote;
- returns `null` when `origin` is absent.

`apps/cli/src/runtime/stdio-mcp-runtime.ts` then:

- constructs `CanonicalManifestStore(<dataPath>/canonical, { strictReads: true })`;
- resolves the ids from the Goal worktree;
- an unknown remote is `skipped/repository_unknown` (Goals must keep being
  admitted in repositories without a remote);
- otherwise passes the guard into `pinGoalBaseAtCommit`.

The helper lives in `canonical-git-source.ts` rather than a new module because
that file already owns the “read `origin` from one checkout” seam and is
covered by the code index; a second wrapper module would only re-export it.

## Explicit non-goals

- No non-main policy ref (finding 1). Goal creation fetches `origin/main`
  unconditionally, so changing only the pin ref would not make admission read
  what a non-main merge policy advances; the Goal base-branch policy is a
  separate product decision.
- No per-repository canonical root. The guard makes a shared root safe for
  admission; splitting the root is a storage-layout decision.
- No overlay consumer, maintenance scheduling, or Thai-RAG semantic contract.
- No change to snapshot Goals: they have no commit and never pin.

## Verification

1. Red-first `goal-admission` tests: foreign repository manifest is
   `skipped/repository_mismatch` with no overlay; a missing manifest is
   `failed` with no overlay; current and legacy ids both pin; no guard keeps
   the old behaviour.
2. Red-first `GoalWorkspaceService.create` test: the port receives the created
   worktree path.
3. Red-first `canonical-git-source` tests: a GitHub remote returns both ids
   (distinct), and a missing `origin` returns `null` without throwing.
4. Runtime end-to-end: the existing pin test stores a real manifest with the
   Goal worktree's repository id; a second test binds the ref to another
   repository and asserts no overlay is created.
5. Targeted `@unified-mpc/workspace`, `@unified-mpc/application` and
   `@unified-mpc/cli` suites, then full `verify:local` on the exact head
   before the review capsule.
