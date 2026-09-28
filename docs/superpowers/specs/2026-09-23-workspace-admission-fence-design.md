# Workspace Admission Fence design

Date: 2026-09-23
Issue: [#161](https://github.com/soulzerox/Unified-MPC-Server/issues/161)

## Decision

Admission is a durable, workspace-scoped proof that binds the runtime identity, Git state, configured base, and current write-lease generation. Bootstrap/resume creates or refreshes the proof; every guarded mutation validates it again. A mismatch is classified before remediation. A newer runtime alone never changes source, and a stale base never means “rebase automatically.”

## Existing seams

- `apps/cli/src/build-provenance.ts` already loads artifact build version, commit, time, and dirty status.
- `GoalWorkspaceTruthReader` currently reports only coarse clean/dirty/missing Git truth.
- `GoalRuntimeControlPlaneService` persists workspace observations in the Goal runtime projection.
- MCP mutation tools already pass through the tool registry and goal mutation fence; admission belongs at this boundary rather than in prompt text.
- Git operations are centralized through the Git adapter/service.

Extend these seams rather than introducing a parallel workspace or mutation framework.

## Receipt and admission state

Persist a bounded receipt keyed to workspace and admission generation. Record repository/worktree identity, branch, expected workspace HEAD, exact resolved base SHA and configured base-ref policy, remote goal SHA when tracked, merge-base identity, clean/dirty classification and a deterministic fingerprint of tracked/staged/untracked source state, checkpoint/revision, write-lease generation, runtime deployment/build/schema identity, and timestamps/invalidation reason. Never persist file contents or hidden reasoning.

Runtime provenance must come from the loaded build artifact, not from the mutable source checkout. Base ref is goal-owned metadata; pinned/historical goals remain pinned.

## Flow and failure behavior

1. On bootstrap/resume, resolve runtime provenance and bounded workspace state, then compare against the last durable receipt.
2. Refresh remote refs through a Unified-owned Git operation using explicit destinations and no shared `FETCH_HEAD` authority. Freeze the exact resolved SHA used in the decision.
3. Classify expected progress, unexpected workspace change, normal base advance (`BASE_STALE`), remote goal-branch movement, runtime-only change, or rewritten/unrelated history (`RECOVERY_REQUIRED`).
4. Issue an admission generation bound to expected HEAD, dirty fingerprint, resolved base, lease, runtime generation, and workflow version.
5. At every guarded mutation boundary, compare-and-swap that generation against current durable and observed state. Reject stale proofs with a structured result; never rely on the agent to remember a check.
6. A rebase is an explicit remediation, only for a clean, exclusively leased, private goal branch with a durable checkpoint and frozen new base. Dirty work requires an explicit checkpoint/patch strategy first. Shared/published branches are not rewritten. Pinned bases are not advanced. Any conflict preserves the old state and stops for reconciliation.

Rebase or source drift invalidates test/build, review, index, impact, PR-head, and cached-diff receipts whose exact-head rules no longer match. Runtime-only change refreshes admission and runtime-scoped evidence but does not rebase source.

## Projection and delegation

Expose only bounded runtime/workspace/base/ownership/admission status to primary and delegated agent bootstrap contexts and the #82/#74 projections. Reuse the same admission semantics for delegated workspaces. Non-Git workspaces bind the source snapshot/fingerprint and lease/runtime generations without a rebase concept. Avoid repository-wide hashing on each read; cache bounded fingerprints and invalidate them on relevant Git/filesystem mutations.

## Verification

Add tests for: exact admission; expected local progress; unexpected HEAD/dirty change; base advance vs rewrite; runtime-only generation change; lease/admission CAS at mutation time; clean-private guarded rebase/checkpoint; dirty/shared/pinned denial; conflict recovery; evidence invalidation; restart/reconnect and delegated bootstrap; non-Git snapshot admission; and concurrent worktrees sharing a Git common directory proving explicit-ref fetch never trusts another worktree's `FETCH_HEAD`.

## Delivery sequence

Implement in dependency order: receipt/domain and persistence; artifact provenance plus Git observations; bootstrap classification; mutation-boundary CAS; guarded rebase/recovery policy; evidence invalidation and projections; concurrency/TOCTOU/restart regressions. Keep each change TDD and preserve existing user dirty worktrees. Build/rebuild only after #161 acceptance and verification; do not restart the currently serving runtime as a side effect.
