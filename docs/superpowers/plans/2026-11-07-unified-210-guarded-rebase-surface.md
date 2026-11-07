# Unified #210 slice — guarded rebase as an MCP operation

Issue: soulzerox/Unified-MPC-Server#210 (§2 current-file invariant, §4 Goal
Workspace admission gate, §7 bounded admin operations)
Depends on: #670 (post-rebase canonical re-pin), #669 (automatic admission
pass), the admission-receipt and base-rebase receipts from #161.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The admission projection is honest about the problem and silent about the fix:

~~~text
workspace_bootstrap
  -> admission.status = BASE_STALE
  -> admission.remediation = guarded_rebase     <-- "do this"
  -> ???                                        <-- no operation can do it
~~~

`GoalWorkspaceService.rebaseStaleBase` exists and is tested, but nothing
outside its own tests calls it. Worse, the receipt the method consumes can
never carry its checkpoint proof in the current runtime:

- `admitRunWorkspace` establishes the receipt through
  `GoalRuntimeControlPlaneService.bootstrapWorkspace`, whose initial receipt
  has `checkpointId` only when the workspace row already had one, and never
  sets `checkpointRevision`;
- `GoalWorkspaceService.captureAdmission` is the only writer that records
  `checkpointId` + `checkpointRevision`, and it has no production caller;
- `rebaseStaleBase` refuses a receipt with either field missing
  (`admission_or_checkpoint_missing_or_stale`).

So a caller who follows the projection today would either find no tool at all
or, with a naive tool, get a permanent refusal that looks like a workspace
problem. The `guarded_rebase` remediation is currently a dead end, and the
post-rebase canonical re-pin landed in #670 can never run in production.

## What lands

### 1. `rebase_goal_workspace` MCP tool

`packages/mcp-server/src/tools/goal-tools.ts`, permission `WRITE`,
`destructiveHint: true` (it rewrites the private Goal branch history), strict
schema:

~~~text
workspaceId, goalId, leaseToken, leaseGeneration,
expectedAdmissionGeneration
~~~

`expectedAdmissionGeneration` is the generation the caller observed in
`workspace_bootstrap`/`workspace_info` before the base advanced. It is an
optimistic precondition, not a guess: the runtime refuses when the live
receipt is no longer that generation.

The handler forwards to a new `GoalRunWorkspacePort.rebaseRunWorkspace` and
returns the service outcome flattened with `outcome: 'rebased' |
'recovery_required'`. A refusal is a structured success (`recovery_required`),
because an unsafe rebase is an expected answer, not a transport failure. Only
a stale lease proof is an error (`PERMISSION_DENIED`).

### 2. Runtime proof and just-in-time checkpoint admission

`apps/cli/src/runtime/stdio-mcp-runtime.ts`:

1. validate the exact durable goal lease (hash + constant-time compare,
   active, workspace, generation, owner client/session, unexpired) through the
   same helper now shared with `recoverRunWorkspace`;
2. read the latest durable goal checkpoint; no checkpoint is a
   `recovery_required` answer with `durable_checkpoint_missing`, never a
   fabricated one;
3. synchronize the writer lease from the durable goal (same derivation as
   admission) so `rebaseStaleBase` sees the exact live lease id/generation;
4. when the live receipt is not already bound to that checkpoint at the
   current HEAD, record the checkpoint on the workspace and refresh the
   admission receipt through `captureAdmission` at the observed HEAD. This is
   an admission refresh, not a new safety path: it proves the same clean HEAD,
   lease and checkpoint identity that `rebaseStaleBase` then re-validates;
5. call `rebaseStaleBase` with the *post-refresh* generation and return its
   result unchanged.

Ordering is deliberate: an invalidated receipt, a replayed generation, a
missing checkpoint or a moved HEAD are all refused before any Git history is
touched. A capture conflict is reported as `recovery_required` with
`admission_capture_conflict`; the caller re-reads and retries. A completed
rebase is never downgraded because the canonical re-pin skipped.

### 2a. Admission receipts keep the moving base policy ref

The refreshed receipt must also be internally consistent with the workspace
base policy, not only clean and checkpoint-bound. `observeWorkspace` echoes its
observation ref as `baseRef`, and `captureAdmission` observes the exact base
commit (`workspace.baseRevision`) to stay on the old base while the stale base
is being remediated. That echoed value is a commit SHA, while the workspace's
base policy is the moving ref (`origin/main`). The domain evidence check in
`decideGuardedBaseRebase` compares the receipt's `baseRef` with the workspace's
`baseRef`, so a naive capture would refuse every rebase with
`base_policy_changed` even though the policy never changed.

`captureAdmission` therefore records `workspace.baseRef ?? snapshot.baseRef` as
the receipt's policy ref while keeping the observed commit in
`resolvedBaseSha`. This matches what `GoalWorkspaceTruthReader` already reports
for moving-base workspaces, so admission recovery and the guarded rebase compare
like for like. The old base commit is still the one observed, admitted and
later required by `rebaseStaleBase`.

### 3. Tool catalog and contract

- `packages/mcp-server/src/tool-registry.test.ts` exact catalog order;
- `packages/mcp-server/src/tool-runtime-fixtures.ts` runtime fixture
  (`goalRunWorkspace.rebaseRunWorkspace`);
- `packages/mcp-server/src/tool-runtime-test-harness.ts` success stub;
- `docs/architecture/MUTATION_SAFETY_MATRIX.md` admission-recovery paragraph
  and covered-tool list;
- generated `docs/architecture/TOOL_CONTRACT.md` (`docs:tools`).

## Invariants this slice keeps

- A stale base never rebases automatically. Admission still only classifies;
  the remediation stays an explicit caller action.
- The tool grants no file, shell or arbitrary Git authority. It can only ask
  the Goal Workspace service to run its already-guarded rebase.
- No lease rotation, no new goal, no merge, no branch publication.
- Published branches, pinned bases, dirty worktrees, rewritten base history,
  a moved remote Goal branch, a prior incomplete rebase and every conflict
  still refuse with the existing `RECOVERY_REQUIRED` reasons.
- A skipped canonical re-pin stays a skip; it never turns a completed rebase
  into a failure.
- `retry_goal_workspace_admission` keeps its meaning. It recovers admission;
  it does not rewrite history.

## Test matrix

Runtime (`apps/cli/src/runtime/stdio-mcp-runtime.test.ts`):

- no durable checkpoint yet -> `RECOVERY_REQUIRED durable_checkpoint_missing`;
- wrong lease token -> `PERMISSION_DENIED`;
- correct lease + wrong expected generation -> `RECOVERY_REQUIRED
  admission_generation_mismatch` with no Git movement;
- after `checkpoint_goal` and an advanced origin base -> `REBASED` with
  `newBaseSha` equal to the advanced commit, the workspace base updated, the
  receipt invalidated, and `canonicalAdmission` a `commit_not_live` skip;
- replaying the same generation -> `RECOVERY_REQUIRED`, never a second rebase.

Tool surface (`packages/mcp-server/src/tools/goal-tools.test.ts`):

- catalog position, `WRITE`/`destructiveHint: true` annotations, strict schema;
- handler forwards the five fields and flattens both outcomes;
- missing service reports the standard `needs_setup` answer.

Service (`packages/application/src/goal-workspace-service.test.ts`):

- a refreshed receipt keeps the moving base policy ref (`origin/main`) while
  resolving the exact observed base commit.

Catalog (`packages/mcp-server/src/tool-registry.test.ts`,
`packages/mcp-server/src/tool-runtime-fixtures.ts`):

- exact advertised order and one runtime fixture per definition.

## Explicit non-goals

- No automatic rebase from `workspace_bootstrap`, `code_index`, `prepare_code_change`
  or any admission retry.
- No new conflict-recovery UX. A conflict keeps the existing
  `recovery_required` receipt and the existing recovery ref; a human decides.
- No change to `checkpoint_goal` semantics or to `GoalContinuationService`.
- No WebUI projection; this is the operator/agent surface only.
- No baseline or artifact changes. The rebase moves Git history and re-pins
  the overlay base only when the canonical ref already advanced.
