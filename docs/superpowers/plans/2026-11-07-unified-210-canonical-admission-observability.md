# Unified #210 slice — observable canonical admission

Issue: soulzerox/Unified-MPC-Server#210 (§11 observability, §4 admission)
Follow-up: nonblocking finding from the PR #659 review, recorded in the
2026-11-05 #210 status comment.

## Why this slice now

Goal creation pins the canonical overlay base through
`GoalWorkspaceService.pinCanonicalBase`, which returns a
`GoalCanonicalAdmissionOutcome` on the create result. The runtime adapter logs
only `status: 'failed'`, the `run_goal` orchestration path returns just
`{ workspaceId }`, and the MCP caller never sees the outcome. A detected
cross-repository collision (`skipped/repository_mismatch`) or an unidentifiable
checkout (`skipped/repository_unknown`) therefore leaves no operator-visible
trace anywhere.

That gap matters before drift reporting claims to explain a missed pin: the
store can refuse a pin correctly and still look exactly like a clean admission.

## What lands

### 1. Carry the outcome on the port

`GoalRunWorkspacePort.resolveRunWorkspace` returns an optional
`canonicalAdmission?: GoalCanonicalAdmissionOutcome` (the application type), so
a caller can tell a pinned, skipped and failed admission apart. The field is
omitted when the call reused an existing Goal Workspace, because no pin ran.

### 2. Surface it on the `run_goal` response

`packages/mcp-server/src/tools/goal-tools.ts` forwards the outcome on every
`run_goal` return path, including the `admission_required` path that preserves a
newly acquired lease. A caller that sees a skipped admission can act on the
reason instead of assuming the base was pinned.

### 3. Log the reasons that prove a real anomaly

`apps/cli/src/runtime/stdio-mcp-runtime.ts` keeps logging `failed`, and now also
logs the two anomaly skips (`repository_unknown`, `repository_mismatch`) with
their detail. Ordinary skips (`no_canonical_ref`, `commit_not_live`) stay quiet:
they are the expected answer for a store without canonical data or a feature
base.

## Explicit non-goals

- No new persistence: the outcome is a response/log projection, not a durable
  Goal field. A later §11 drift-reporting slice owns the durable record.
- No change to `admitRunWorkspace`, rebase, or admission-receipt behaviour.
- No new MCP tool or input schema.

## Verification

1. Unit: the routing test returns `canonicalAdmission` through `run_goal`, and
   the admission-required path preserves it alongside the lease.
2. Runtime: the no-origin Goal test asserts
   `{ status: 'skipped', reason: 'repository_unknown' }` on the resolved
   workspace, proving the outcome survives the real service.
3. Typecheck and lint on the touched packages; `verify:local` on the exact head.
