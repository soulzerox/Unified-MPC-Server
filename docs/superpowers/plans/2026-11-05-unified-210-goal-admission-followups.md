# Unified #210 slice — Goal admission follow-ups

Issue: soulzerox/Unified-MPC-Server#210 (§4 Goal Workspace admission gate,
§5 dirty Goal base + overlay, §7 retain active Goal bases)
Origin: nonblocking findings from the PR #656 exact-head review.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

PR #656 wired the Goal admission pin. Its review left four nonblocking
findings; two are mechanical and are closed here:

1. **Overlay release has no lifecycle path.** `GoalOverlayStore.delete` still
   has no production caller, and `GoalWorkspaceService.remove()` archives the
   workspace without releasing the pin. Overlay bases are GC roots
   (`artifact-gc-roots.ts`), so the first caller of `remove()` would retain the
   removed Goal's base manifest and artifacts forever.
2. **A concurrent advance is reported as `failed`.** `pinGoalBaseAtCommit`
   reads the ref strictly, then `attachGoalBasePin` re-reads it. If merge
   reconciliation advances the ref between the two reads, the attach throws and
   the blanket catch reports `failed`, which the runtime logs as an unexpected
   failure — even though the same race one read earlier is a normal
   `skipped/commit_not_live`.

## What lands

### 1. Release the overlay when a Goal Workspace is removed

- `GoalCanonicalAdmissionPort` gains `releaseBase(goalWorkspaceId)`.
- `GoalWorkspaceService.remove()` calls it **after** the registration is
  archived, and never fails removal on a release error: the worktree is gone
  and the registration is archived, so a throw would report a removal that did
  happen as failed (and a retry would not find the Goal). The runtime adapter
  logs a failed release to stderr, like a failed pin.
- Snapshot Goals never had a pin; `remove()` releases unconditionally because
  `GoalOverlayStore.delete` is idempotent (`false` when absent).

### 2. A concurrent ref move is a skip, not a failure

- On any error from `attachGoalBasePin`, `pinGoalBaseAtCommit` re-reads the
  ref strictly once. If it now resolves to a different commit, the outcome is
  `skipped/commit_not_live` with the same detail shape as a first-read move.
  A missing ref at re-read is `skipped/no_canonical_ref`. Only a ref that still
  resolves to the requested commit (or a second read failure) produces
  `failed`, because then the error is a real store/write problem.
- This adds one strict read only on the error path.

## Explicit non-goals

- No repository identity on the admission port (design-bearing: which policy
  applies to a Goal, and whether the canonical root becomes per-repository).
- No non-main policy ref resolution (needs the same Goal → policy mapping).
- No drift reporting in `status`/`resume`: neither method has a production
  caller yet, and whether drift must block a long-running Goal is a product
  decision, not a mechanical follow-up.
- No pre-edit/search overlay consumer, no maintenance scheduling, no Thai-RAG
  semantic contract work.

## Verification

1. Red-first `goal-admission` tests: the ref moving between the strict read and
   the attach is reported as `skipped/commit_not_live`; an unchanged ref plus a
   write error is still `failed`.
2. Red-first `GoalWorkspaceService.remove` tests: the port's `releaseBase` runs
   after archival; a throwing release never fails removal; no port keeps the
   current behaviour.
3. Runtime wiring: the adapter deletes `<dataPath>/canonical/overlays/<id>.json`
   and logs failures without throwing.
4. Targeted `@unified-mpc/workspace`, `@unified-mpc/application` and
   `@unified-mpc/cli` suites, then full `verify:local` on the exact head before
   the review capsule.
