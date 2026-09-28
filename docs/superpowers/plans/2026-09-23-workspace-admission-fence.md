# Workspace Admission Fence Implementation Plan

> **For agentic workers:** Follow this plan task-by-task with inline execution and review checkpoints. Each task uses a red/green cycle before production changes.

**Goal:** Complete [issue #161](https://github.com/soulzerox/Unified-MPC-Server/issues/161) by enforcing durable, exact-state workspace admission at bootstrap and every guarded mutation, with safe drift classification and checkpoint-first rebase.

**Architecture:** Extend the existing Goal Workspace, runtime control-plane, Git service/adapter, mutation-fence, and projection seams. Persist a bounded admission receipt whose generation binds runtime provenance, exact workspace state, resolved goal-owned base, dirty fingerprint, and lease generation. Classify mismatches before action; only an exclusive, clean, private, checkpointed branch may use guarded rebase.

**Tech Stack:** TypeScript, SQLite migrations/repositories, Vitest, existing GitAdapter/GitService, GoalRuntimeControlPlaneService, MCP ToolRegistry, existing runtime build provenance.

## Global Constraints

- Runtime build identity comes from artifact provenance, never the mutable workspace checkout.
- Keep expected workspace HEAD distinct from base SHA; never use shared `FETCH_HEAD` as an admission authority.
- Enforce admission both at bootstrap/resume and at the mutation boundary; fail closed on unknown required state.
- Do not silently stash dirty work, rewrite shared/published branches, or move pinned bases.
- A runtime-only generation change never rebases source; conflict/rewrite/unrelated history preserves the old state and requires recovery.
- Keep receipts bounded and content-free; do not hash the whole repository on every tool call.
- Do not install dependencies, rebase dirty worktrees, force-push, or restart the serving process as part of build verification.
- Run expensive checks serially and verify each exact head before recording evidence.

---

## File map

- Create `packages/domain/src/workspace-admission.ts` and its test; export through `packages/domain/src/index.ts`. Own receipt types, drift taxonomy, and pure classification only.
- Create `packages/storage/src/migrations/workspace-admission-migration.ts`; extend `packages/storage/src/database.ts`; extend `packages/storage/src/workspace-repository.ts` and its integration tests for durable receipt/CAS operations.
- Extend `packages/git/src/git-adapter.ts` and `git-adapter.test.ts` for bounded immutable observations, explicit-ref refresh, and safe rebase primitives; expose them through `packages/application/src/git-service.ts` with unit tests.
- Extend `packages/application/src/goal-workspace-truth-reader.ts`, `goal-workspace-service.ts`, and their tests for Git/non-Git observations and admission lifecycle.
- Extend `packages/application/src/goal-runtime-control-plane-service.ts` and tests for bootstrap/resume projection of bounded runtime/workspace/base/admission truth.
- Extend `packages/application/src/goal-mutation-fence-service.ts`, `packages/mcp-server/src/tool-registry.ts`, `packages/mcp-server/src/tools/tool-types.ts`, and mutation-fence/registry tests for exact admission-generation CAS before effects.
- Extend `apps/cli/src/build-provenance.ts`, `apps/cli/src/bin/mcp-http.ts`, `apps/cli/src/runtime/stdio-mcp-runtime.ts`, and relevant tests to inject immutable runtime/deployment/schema identity from the artifact/runtime host.
- Integrate bounded state with the existing context and UI projection seams: `packages/mcp-server/src/context-engine.ts`, `packages/mcp-server/src/tools/context-tools.ts`, `apps/web/src/web-server.ts`, and WebUI tests. Consume #142/#143/#144 owner contracts; do not duplicate their gate, capsule, or review systems.

## Task 1: Domain receipt and drift classification

**Files:**
- Create: `packages/domain/src/workspace-admission.ts`
- Create: `packages/domain/src/workspace-admission.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- `WorkspaceAdmissionReceipt` records opaque receipt/workspace/goal IDs, repository and worktree identity, branch, expected and observed HEAD, configured base ref and resolved SHA, merge base, remote goal SHA, dirty fingerprint/state, checkpoint/revision, lease generation, runtime generation/build/schema identity, admission generation, and invalidation metadata.
- `classifyWorkspaceAdmission(expected, observed)` returns only one of `ADMITTED`, `EXPECTED_PROGRESS`, `WORKSPACE_STATE_CHANGED`, `BASE_STALE`, `REMOTE_GOAL_BRANCH_DRIFT`, `RUNTIME_GENERATION_CHANGED`, or `RECOVERY_REQUIRED`; never selects a rebase by itself.

- [x] Test that equal expected HEAD, dirty fingerprint, base SHA, lease and runtime admit, while a newer expected owner checkpoint is progress.
- [x] Test separately that dirty/HEAD changes, base advance, remote branch movement, runtime-only changes, and unrelated history classify to the required distinct outcomes.
- [x] Run: `corepack pnpm --filter @unified-mpc/domain exec vitest run src/workspace-admission.test.ts`; expected: new tests fail on missing classifier.
- [x] Implement the pure bounded classifier and exports; rerun the same command and `corepack pnpm --filter @unified-mpc/domain typecheck`; expected: pass.
- [ ] Commit: `feat(domain): model workspace admission state`.

## Task 2: Durable receipt and compare-and-swap persistence

**Files:**
- Create: `packages/storage/src/migrations/workspace-admission-migration.ts`
- Modify: `packages/storage/src/database.ts`
- Modify: `packages/storage/src/workspace-repository.ts`
- Modify: `packages/storage/src/workspace-repository.integration.test.ts`

**Interfaces:**
- Repository operations create/read/invalidate receipts and advance an admission generation only when the stored expected generation and write-lease generation still match.
- Receipt data contains identities/fingerprints only, never source text.

- [x] Add integration tests proving receipts survive database close/reopen, stale generations cannot win CAS, and a wrong lease generation is rejected.
- [x] Run: `corepack pnpm --filter @unified-mpc/storage exec vitest run src/workspace-repository.integration.test.ts`; expected: receipt API is missing.
- [x] Add one idempotent schema migration and minimal repository SQL for read/create/CAS/invalidate; do not duplicate the workspace registry.
- [x] Rerun focused integration test and storage typecheck; expected: pass, including old-database migration.
- [ ] Commit: `feat(storage): persist workspace admission receipts`.

## Task 3: Bounded Git identity, fingerprint, and explicit-ref freshness

**Files:**
- Modify: `packages/git/src/git-adapter.ts`
- Modify: `packages/git/src/git-adapter.test.ts`
- Modify: `packages/git/src/git-adapter.integration.test.ts`
- Modify: `packages/application/src/git-service.ts`
- Modify: `packages/application/src/git-service.test.ts`

**Interfaces:**
- Add a typed read-only snapshot for repository/worktree identity, HEAD, branch, status, index/staged identity, bounded tracked/untracked-source fingerprint, configured base SHA, and merge base.
- Add a controlled refresh that fetches an exact configured ref into an explicit ref without writing or reading global `FETCH_HEAD`; do not change a goal's configured base.
- Keep rebase as a separate guarded operation; generic user Git invocation must not bypass the admission policy.

- [x] Test a multi-worktree repository where refreshing workspace A cannot change workspace B's resolved base even when both share a Git common dir.
- [x] Test fingerprints change for staged, tracked-dirty, and untracked source edits but ignore configured generated/cache/vendor paths.
- [x] Test missing remote, force-pushed/unrelated history, unsupported paths, and Git timeout return typed fail-closed outcomes.
- [x] Run the focused Git adapter/service tests; expected: new APIs are missing.
- [x] Implement with existing GitRunner and standard crypto/filesystem APIs only; rerun focused tests and Git package typecheck; expected: pass.
- [ ] Commit: `feat(git): observe workspace admission state safely`.

## Task 4: Bootstrap admission and artifact runtime identity

**Files:**
- Modify: `apps/cli/src/build-provenance.ts`
- Modify: `apps/cli/src/build-provenance.test.ts`
- Modify: `apps/cli/src/bin/mcp-http.ts`
- Modify: `apps/cli/src/runtime/stdio-mcp-runtime.ts`
- Modify: `packages/application/src/goal-workspace-truth-reader.ts` and test
- Modify: `packages/application/src/goal-workspace-service.ts` and test
- Modify: `packages/application/src/goal-runtime-control-plane-service.ts` and test

- [x] Test bootstrap returns artifact build/deployment/schema identity with bounded HEAD/base/dirty/lease/admission status; a missing required provenance fails closed.
- [x] Test runtime-only generation change refreshes runtime-scoped admission but does not change workspace HEAD/base or invoke Git rebase.
- [x] Test Git and non-Git Goal Workspaces resolve through their existing lifecycle paths and do not treat expected workspace HEAD as equal to base SHA.
- [x] Run focused application and CLI tests; expected: admission projection is absent.
- [x] Inject loaded artifact provenance and persist/project the refreshed receipt using the existing Goal control-plane/repository; rerun tests and package typechecks.
- [ ] Commit: `feat(application): admit goal workspaces on bootstrap`.

## Task 5: Mutation-boundary admission generation/CAS

**Files:**
- Modify: `packages/application/src/goal-mutation-fence-service.ts` and test
- Modify: `packages/mcp-server/src/tool-registry.ts` and test
- Modify: `packages/mcp-server/src/tools/tool-types.ts`
- Reuse #142 exact-input receipt contract; do not implement a parallel workflow gate.

- [x] Add a TOCTOU test: bootstrap a receipt, change HEAD or dirty fingerprint before a write, call a real registry write handler, and assert a structured `WORKSPACE_ADMISSION_STALE`/classified error occurs before the underlying write executes.
- [x] Add positive tests proving matching admission plus current goal lease reaches the existing mutation handler, and mismatched admission/lease fails closed.
- [x] Run focused mutation-fence and ToolRegistry tests; expected: stale proof is not enforced.
- [x] Bind the admission generation to the existing per-goal mutation fence and compare the durable receipt generation atomically in the admission transaction immediately before side effects; preserve Full Bypass behavior only for ordinary policy gates, never durable ownership/admission.
- [x] Rerun focused tests and MCP-server typecheck; expected: pass.
- [ ] Commit: `feat(mcp): fence mutations with workspace admission`.

## Task 6: Guarded base drift remediation and recovery

- [x] Test default worktree creation uses a directly refreshed `origin/refs/heads/main` SHA and records that exact commit; an explicitly supplied `baseRevision` remains a pinned-base override.
- [x] Store the moving-base policy separately from its frozen creation SHA and refresh it directly into a workspace-private ref before admission observation.

**Files:**
- Modify: `packages/application/src/goal-workspace-service.ts` and tests
- Modify: `packages/application/src/git-service.ts` and tests
- Modify: `packages/storage/src/workspace-repository.ts` and integration tests
- Modify: `packages/domain/src/workspace-admission.ts` and tests

- [ ] Test that clean + exclusive lease + private unpublished branch + valid checkpoint + frozen newer base permits the guarded rebase path.
- [ ] Test dirty, shared/published, pinned, remote-moved, rewritten/unrelated, stale lease, and checkpoint failure each prevents rebase without stashing or rewriting refs.
- [ ] Test a conflict leaves the pre-rebase checkpoint/head recoverable and returns `RECOVERY_REQUIRED` with exact old/new head/base and conflicted paths.
- [ ] Run focused application/Git/storage tests; expected: no guarded remediation exists.
- [ ] Implement checkpoint-first, exact-SHA rebase and truthful rebase receipt; do not force-push or semantically resolve conflicts.
- [ ] Rerun tests and typechecks for touched packages; expected: pass.
- [ ] Commit: `feat(workspace): guard stale-base rebase and recovery`.

## Task 7: Invalidate stale evidence and project admission to agents/UI

**Files:**
- Modify: `packages/application/src/goal-runtime-control-plane-service.ts` and tests
- Modify: `packages/storage/src/goal-runtime-event-repository.ts` and relevant tests
- Modify: `packages/mcp-server/src/context-engine.ts` and tests
- Modify: `packages/mcp-server/src/tools/context-tools.ts` and tests
- Modify: `apps/web/src/web-server.ts` and tests
- Modify: `apps/web/src/ui/client-script.ts` only if the current projection lacks visible bounded states

- [ ] Test source generation change invalidates only exact-head test/build/review/index/impact/PR/diff evidence; matching evidence stays valid.
- [ ] Test primary and delegated context receives the same bounded admission status without secrets or file contents.
- [ ] Test UI/runtime projection distinguishes admitted, base-stale, workspace-changed, and recovery-required without exposing tokens/fingerprints beyond safe summaries.
- [ ] Run focused context, runtime projection, and WebUI tests; expected: admission state is not projected.
- [ ] Reuse existing projection and #143 capsule contracts; implement precise invalidation and bounded UI/context fields only.
- [ ] Rerun focused tests/typechecks and commit: `feat(runtime): project workspace admission and invalidate stale evidence`.

## Task 8: Full acceptance regression, verification, and PR readiness

**Files:**
- Add integration tests only where the focused suites cannot exercise restart/cross-process/common-dir behavior.
- Update the issue-linked architecture/tool docs for final public contracts.

- [ ] Add restart/reconnect and delegated-agent regressions; add a true shared-common-dir concurrent worktree test and mutation TOCTOU test.
- [ ] Map every #161 acceptance checkbox to at least one named test or runtime evidence; verify pinned/history, non-Git, runtime-only, dirty, published, conflict, evidence invalidation, and fail-closed network cases.
- [ ] Run serialized focused package tests, then repository typecheck, lint, and build from the exact feature head; do not install packages.
- [ ] Inspect `git diff --check`, exact HEAD, branch/main ancestry, and dirty state; fix any failures before review.
- [ ] Run exact-head standards/spec review and address all findings.
- [ ] Open PR targeting `main`, wait for the exact required GitHub Actions run to finish, inspect failed job logs if any, and crosslink #161 and #82. Do not merge until required CI is green.
- [ ] Commit remaining acceptance/docs changes; only claim #161 complete after current GitHub issue/PR state and all acceptance evidence are verified.

---

## Execution choice

Proceed inline in this task: the user has asked us to continue the existing goal, and subagent dispatch was not requested. Use bounded checkpoints between independently verifiable tasks. Do not rebuild until #161 acceptance/CI is complete; then rebuild from the exact latest main-based feature state and verify the produced artifact/runtime identity before resuming #11/#82.
