# Unified #210 slice — Goal admission follows the repository's base branch

Issue: soulzerox/Unified-MPC-Server#210 (§1 per-repository trust boundary,
§4 Goal Workspace admission gate, §7 retain active Goal bases)
Origin: nonblocking finding 1 from the PR #656 exact-head review.

## Why this slice now

Goal creation and the admission pin disagree about which branch is the base:

~~~text
GoalWorkspaceService.create (baseRevision omitted)
  -> fetch refs/heads/main                    <- hardcoded
  -> baseRef = origin/main
runtime admission pin
  -> refs/remotes/origin/main                 <- hardcoded
merge reconciliation
  -> canonicalRefForBranch(policy.defaultBranch)  <- policy wins
~~~

For a repository whose merge policy sets `defaultBranch: trunk`, a reconciled
merge advances `refs/remotes/origin/trunk`, but Goal admission reads and pins
`refs/remotes/origin/main`. The pin is a no-op: either the ref is missing
(`skipped/no_canonical_ref`) or it points at another commit
(`skipped/commit_not_live`). Admission never pins in that repository, so the
`#210` reuse contract is silently disabled there.

The same code treats `master` as "main": a repository whose project branch is
`master` still fetches `refs/heads/main`, which does not exist.

## What lands

### 1. Admission resolves the base branch from the merge policy

`apps/cli/src/runtime/canonical-git-source.ts` gains
`resolveGoalBaseBranch(worktreePath, currentBranch, policyFor, sourceFor?)`:

- reads `origin` and maps it to a GitHub `owner/repo` with the existing
  `githubRepositoryFromRemote` (an unknown or local remote cannot have a
  merge policy);
- returns the policy's `defaultBranch` when a policy exists;
- otherwise keeps the current checkout's `main`/`master` branch, and falls
  back to `main` for a feature branch.

The runtime resolves it from the **parent** workspace before creating the
Goal, because the Goal worktree does not exist yet. `refs/heads/main` is no
longer hardcoded in the runtime path.

### 2. The application service uses the resolved branch

`GoalWorkspaceCreateRequest` gains `baseBranch?: string` (default `main`), and
`create` uses it for the fresh remote fetch and for `baseRef`:

~~~text
refreshRemoteRef(origin, refs/heads/<baseBranch>)
baseRef = origin/<baseBranch>
~~~

The runtime omits `baseRevision` only when the parent checkout is already on
that branch; otherwise it keeps pinning the exact parent HEAD as before.

### 3. The pin names the same branch

`GoalCanonicalAdmissionPort.pinBaseAtCommit` input gains `baseBranch`, and the
runtime adapter pins `canonicalRefForBranch(input.baseBranch)` instead of the
literal `main`. The application passes the branch it resolved the moving base
from, so the canonical ref a merge advances is exactly the ref admission reads.

### 4. The admission recheck refreshes the same branch

`GoalWorkspaceTruthReader.readAdmission` matched only `<remote>/main` and
refreshed `refs/heads/main`. It now parses the branch from the recorded
`<remote>/<branch>` base and refreshes that branch. Without this, the new
`baseRef: origin/master|trunk` made admission report `unknown` and `run_goal`
failed closed with `WORKSPACE_ADMISSION_STALE` even though the pin succeeded.

## Explicit non-goals

- No new user-facing branch setting. The merge policy's `defaultBranch` is the
  existing operator decision; a repository without a policy keeps the
  `main`/`master` behaviour.
- No non-GitHub policy mapping. `githubRepositoryFromRemote` is the same
  identity the merge reconciliation path requires; a local-only remote has no
  reconciler to advance a canonical ref.
- No change to feature-branch bases: they still pin the exact parent HEAD, and
  the canonical ref is a skip unless that commit is the live default-branch
  commit.

## Verification

1. Red-first application tests: `baseBranch: trunk` fetches
   `refs/heads/trunk`, records `baseRef: origin/trunk`, and passes `trunk` to
   the admission port; the default keeps `main`.
2. Red-first helper tests: a policy returns its `defaultBranch`; no policy
   keeps `master` on a `master` checkout and falls back to `main` on a feature
   branch; a checkout without `origin` falls back without a policy lookup.
3. Runtime end-to-end: a `master` parent with no policy fetches, pins, and
   admits against `refs/remotes/origin/master`, not `main`.
4. Targeted `@unified-mpc/application` and `@unified-mpc/cli` suites, then
   full `verify:local` on the exact head before the review capsule.
