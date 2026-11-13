# Workflow Gate Engine

Design proposal for #142. Status: proposed, not implemented.

The repository already enforces gates, each with its own receipt store:

| Gate | Implementation | Receipt |
|---|---|---|
| local verification | `scripts/local-verify.mjs` | `.unified-mpc/local-verify/<head12>-<id>.json` |
| exact-head review | `scripts/review-gate.mjs` | `.unified-mpc/reviews/receipts/<head12>-<pr>.json` |
| merge (CLI) | `scripts/guarded-merge.mjs` | `.unified-mpc/local-verify/merges/<head40>-<pr>.json` |
| merge (runtime) | `GuardedMergeService` + `evaluateMergeEvidence` | SQLite, via `docs/GUARDED_MERGE.md` |

They are adapters over one idea: *a phase may proceed only when durable evidence
for the exact current input exists.* The CLI path already shares part of it by
import — `guarded-merge.mjs` reuses `evaluateReviewEvidence` and
`selectVerificationReceipt` from `review-gate.mjs` — while the runtime path has
its own receipt model and predicates. This document proposes the deep module
that idea belongs in, and a migration that changes no behaviour on the way.

The runtime merge gate is not a fourth gate and not future work: it is the
runtime adapter over the same policy. The engine must be the single owner of
"is this head verified and reviewed", and both the CLI script and
`GuardedMergeService` must delegate to it rather than keep separate evaluators.
That is a real migration, not a drop-in: the runtime receipt carries repository,
pull request, head, optional base, verification mode, a gate list and a review
outcome, so step 4 has to convert or re-record it.

---

## 1. Module and seam

One module, one interface:

```ts
type Phase =
  | 'intake' | 'discover' | 'prepare' | 'mutate'
  | 'verify' | 'review' | 'integrate' | 'close';

/** Caller-supplied identity. The caller never supplies evidence. */
interface GateSubject {
  repository: string;
  headSha: string;
  branch?: string;
  pr?: number;
  workspaceId?: string;
  goalId?: string;
}

interface GateRequest {
  workflow: { id: string; version: number };
  phase: Phase;
  subject: GateSubject;
}

interface GateDecision {
  allowed: boolean;
  phase: Phase;
  blockers: readonly Blocker[];   // names the missing, stale or foreign evidence
  receiptId: string | null;       // present only when allowed
}

interface WorkflowGate {
  evaluate(request: GateRequest): Promise<GateDecision>;
  receipts(subject: GateSubject): Promise<readonly GateReceipt[]>;
}
```

`evaluate` is the whole external seam. It owns the phase order, which evidence
each phase requires, exact-input matching, staleness, and dependency ordering.
Callers ask one question: *may this phase proceed for this exact subject?*

The engine resolves the rest of the subject itself. It is constructed with the
sources it reads, so a caller cannot hand it evidence and cannot skip a source.
The sources return the same decisions the scripts make today, not a single
"latest" value that would lose them:

```ts
interface GateSources {
  verification: {
    select(subject: GateSubject): Promise<{ receipt?: VerificationReceipt; blockers: readonly Blocker[] }>;
  };
  review: {
    evaluate(subject: GateSubject): Promise<{ receipt?: ReviewReceipt; blockers: readonly Blocker[] }>;
  };
  diff: {
    fingerprint(subject: GateSubject): Promise<string>;
    changedPaths(subject: GateSubject): Promise<readonly string[]>;
  };
  skill: { identity(): Promise<{ id: string; version: number; sha256: string }> };
  pullRequest: { read(repository: string, pr: number): Promise<PullRequestState | null> };
  workspace: { cleanup(subject: GateSubject): Promise<CleanupEvaluation> };
  now(): string;
}
```

Two of those sources are deliberately shaped like the existing code:

- `verification.select` mirrors `selectVerificationReceipt`: it scans every
  receipt for the head newest-first and prefers the newest one that passes
  `verificationGateBlockers` — profile `merge`, `mergeReady === true`,
  `dirty === false`, the current `PROFILE_VERSION`, a matching
  `diffFingerprint` — so an older accepted run still beats a newer targeted one.
  Returning a decision plus blockers is what lets the engine explain a refusal
  instead of guessing.
- `review.evaluate` mirrors `evaluateReviewEvidence`: one receipt per head, and
  a corrupt receipt file blocks rather than being ignored.

`ResolvedSubject` — the caller's identity plus `baseSha`, `diffFingerprint`,
changed paths and pull-request state — is what the engine records in a receipt.
`baseSha` comes from the pull-request source, so a subject without a PR has no
base and the base-sensitive gates simply do not apply.
`changedPaths` is not one rule for every phase. For the head-scoped gates
(`verify` through `close`) it comes from the diff and is never supplied by the
caller. `mutate` is the exception, and describing it as diff-derived would be
wrong in a way that breaks it: the write has not happened yet, so a diff names
the files the caller has already edited and never the pending one. Its path set
is the tool call's own — `codeMutationPaths(toolName, input)` — which is exactly
what the preparation receipts must cover. The caller may name the path it is
about to write; it may not assert that the path was prepared, because the
preparation source stays injected.

Two adapters justify the seam:

- **live** — the current `.unified-mpc/` layout plus `gh`/GitHub for PR state;
- **in-memory** — test doubles, and the shape a SQLite-backed source would take.

### Where the module lives

The gate suites run before `build` in the merge profile (`test:merge-gate` is
step 4, `build` is step 5) precisely because they import the scripts directly
and need no workspace output; `dist/` is gitignored, so a clean checkout has
none. Phase 1 therefore keeps the shared core as plain ESM under `scripts/`,
importable without a build. Step 2 of the migration moves it into a workspace
package and makes the gate suites build-aware or moves them after `build`; the
document does not pretend that is free.

### Why not one module per gate

Because the phases share the exact-input rule and the blocker vocabulary, and
because the interesting failures are cross-phase: a review receipt for a head
that verification never saw, or a merge whose base moved. Splitting per gate
puts that logic in every caller. The deletion test says the same: delete the
engine and the cross-phase rules reappear in three scripts.

---

## 2. Phase model

The repository enforces three links today: verification before review
(`verificationGateBlockers`), review before merge (`evaluateReviewEvidence`),
and the merge itself. The wider sequence below is the proposed model; the table
says which rows are enforced today and which are not.

```text
INTAKE -> DISCOVER -> PREPARE -> MUTATE -> VERIFY -> REVIEW -> INTEGRATE -> CLOSE
```

`review` requires a `verify` receipt for the same head. That is not a new rule:
`scripts/review-gate.mjs` already refuses to freeze a capsule or record a review
without one, because a review of an unverified head is spent on a head that
cannot land. The engine encodes that dependency; a profile may add requirements,
never remove one the repository pins.

Required evidence per gate, all keyed by the resolved subject:

| Phase | Evidence | Enforced today |
|---|---|---|
| `intake` / `discover` / `prepare` | none defined yet | no |
| `mutate` | `prepare_code_change` / pre-edit context for each changed path, workspace scope current | partially: coding mutations only, and it auto-prepares (see §4) |
| `verify` | a `mergeReady` receipt whose `headSha` + `diffFingerprint` match, from the `merge` profile on a clean tree | yes |
| `review` | a clean review receipt whose `headSha` + capsule `diffFingerprint` match, and a `verify` receipt for the head | yes |
| `integrate` | `verify` + `review` allowed, PR open/non-draft, base unchanged, no retracted closing keyword | yes, in two receipt models; the draft and closing-keyword checks are CLI-only today |
| `close` | merge evidence for the head, base revision known, cleanup disposition `retention_candidate` | partially (cleanup evaluation and `goalCompletionWorktreeBlockers` exist; the workflow gate does not) |

Workflows are versioned data, not code: a profile names the phases and gates it
requires. The engine owns the semantics.

---

## 3. Receipts

A gate receipt is bounded and self-describing. It records what was checked, not
a transcript:

```ts
interface GateReceipt {
  id: string;                 // uuid, stable for the run
  gateId: string;             // 'verify' | 'review' | ...
  gateVersion: number;
  workflow: { id: string; version: number };
  subject: ResolvedSubject;   // headSha, baseSha, diffFingerprint, pr state
  verdict: 'allowed' | 'blocked';
  blockers: readonly Blocker[];
  inputs: readonly { name: string; digest: string }[];  // exact evidence consumed
  createdAt: string;
}
```

Rules the implementation enforces, per gate rather than uniformly:

- a receipt is valid only for the exact subject it names. A moved head or a new
  diff fingerprint invalidates every gate; a changed base invalidates `review`,
  `integrate` and `close`, because a review receipt records the `baseSha` it was
  reviewed against and its fingerprint hashes that base. Verification receipts
  record no base, so a base change does not touch `verify`;
- `verify` is a run log: many receipts per subject, append-only, and the gate
  selects one by the predicate above. A re-run after a failed or targeted run is
  normal;
- `review` is one per subject, and a corrupt receipt file blocks. A second
  opinion needs a new head, which is the existing contract and why a re-frozen
  capsule is refused;
- `integrate` and `close` record one receipt per action, so a merge or a cleanup
  can be audited after the fact;
- a blocked evaluation is recorded too, so "why was this refused" is answerable;
- a new receipt kind needs its own store, and the same step must extend
  `scripts/prune-evidence.mjs` and its tests. Prune plans only
  `.unified-mpc/local-verify` and `.unified-mpc/reviews`; the verification store
  skips filenames that do not match its receipt pattern, while the review store
  reads every `.json` file and refuses the whole plan when one is unreadable. A
  new kind dropped into either directory would be silently unpruned or would
  break pruning.

---

## 4. Enforcement points

The engine is only useful if something refuses. The existing refusals already
live at three seams; the engine extends them instead of adding a parallel gate:

1. **Merge** — the CLI `merge:pr` script and the runtime `GuardedMergeService`.
   Both delegate to `evaluate({phase:'integrate'})`; the CLI keeps
   `--match-head-commit`. Behaviour must not change, and the runtime side needs
   the receipt conversion described above.
2. **Cleanup** — three checks that are easy to conflate:

   - `WorkspaceService.evaluateGoalWorkspaceCleanup` returns a
     `WorkspaceCleanupDisposition` (`blocked` | `retention_pending` |
     `retention_candidate`) plus its blockers. This is the only source of a
     disposition, and the close gate requires `retention_candidate`:
     `retention_pending` has no blockers but must not authorize deletion before
     the grace elapses.
   - the MCP `git_worktree_remove` tool's `worktreeCleanupSafety` returns
     `clean` | `blocked` | `unavailable` from `goalWorktreeRemovalBlockers` and
     refuses an unverifiable classification. It is a private method of
     `UpgradeRuntime`, so step 3 has to export it through the package before the
     CLI can share it.
   - goal completion's `goalCompletionWorktreeBlockers` returns entries for
     `dirty`, `unmerged_changes` and `probe_failed`; `unintegrated_head` is
     deliberately not blocking because the merge flow squash-merges.

   The close gate composes those three; it does not redefine them. Goal
   completion already blocks `unmerged_changes` in a goal worktree, but a
   repository branch outside a goal worktree has no equivalent check.
3. **Mutation** — `ToolRegistry.validateHarnessMutation` is the seam, but it is
   narrower than "every edit fails closed": it runs only when
   `isCodingMutation` is true, covers the fixed file-tool set in
   `codeMutationPaths` (so `shell`, `git` and `restore_deleted_file` are not
   covered), returns allow when no `workspaceId` is resolved, and auto-bootstraps
   the harness and auto-prepares each path instead of refusing. The `mutate`
   phase would tighten it — all mutation tools, refuse rather than auto-prepare —
   and must not add a second CLI gate that an MCP edit bypasses.

MCP exposure is a thin adapter over the same interface: one tool, one phase, one
decision. It must not re-derive policy, and it must not become a second
evaluator next to `GuardedMergeService`.

---

## 5. Migration

Each step ships alone and leaves the repository working.

| Step | Change | Acceptance |
|---|---|---|
| 1 | Promote the shared CLI policy (`evaluateReviewEvidence`, `selectVerificationReceipt`, merge-readiness) into build-free ESM under `scripts/`; `merge:pr` delegates | `guarded-merge.test.mjs` and `local-verify.test.mjs` pass unchanged on a clean checkout; `merge:pr --dry-run` gives identical verdicts on three known heads |
| 2 | Move the shared core into a workspace package and reorder `test:merge-gate` after `build` (or make the gate suites build-aware) | the gate suites still pass on a clean checkout; no script imports built output before it exists |
| 3 | Add `gate:check --phase <p>` CLI + the `close` gate over `evaluateGoalWorkspaceCleanup`, the worktree removal check and `goalCompletionWorktreeBlockers`, with its receipt store and the matching `prune-evidence` update and test. The removal check is `UpgradeRuntime.worktreeCleanupSafety` today, so it must be exported through the package step 2 created rather than copied | a goal worktree with `unmerged_changes` is refused; a merged head is allowed; `retention_pending` is refused; the new receipt kind is pruned by policy; the CLI reaches all three checks without importing a package's `dist/` before `build` |
| 4 | Convert runtime merge evidence to the shared model, repoint `GuardedMergeService`, wire `verify`/`review` through `receipts()` | runtime gate tests pass unchanged; existing runtime receipts are converted, not silently invalidated; the CLI receipt format is unchanged |
| 5 | Extend `validateHarnessMutation` with the `mutate` phase behind a profile flag | opt-in only; default profile unchanged; all mutation tools covered, and a missing preparation refuses instead of auto-preparing |

Step 1 is deliberately a refactor with no user-visible change. It is the step
that pays for the rest, and the one that must not invent new policy. Step 2 is
the prerequisite for steps 3 and 5: the cleanup and mutation seams live in
TypeScript packages that resolve to `dist/`, so a `scripts/`-level caller cannot
reach them on a clean checkout, and `packages/mcp-server` includes only
`src/**/*.ts` and cannot import `scripts/`. Packaging first is why step 3 can
call `evaluateGoalWorkspaceCleanup` instead of re-implementing it, and why
step 5 can extend `validateHarnessMutation` instead of adding a parallel gate.

---

## 6. Non-goals

- authorization (#134) and human approval (#19) — the engine consumes their
  decisions, it does not make them;
- goal liveness (#82) — a gate may require a live goal, but does not own it;
- CI itself — external check results are inputs, not gates;
- deciding *what* a project should test. A profile names the commands; the
  engine only records that they ran on the exact input.

## 7. Open questions

1. Should step 1 land before any new gate exists, or should the engine start as
   a standalone `close` gate and absorb the merge rules later? The first option
   risks a large no-op diff; the second leaves two implementations of
   exact-input matching for a while.
2. Are workflow profiles configuration (a file under `.unified-mpc/`) or code
   (a typed constant)? Configuration makes per-project specialization cheap but
   needs validation; code keeps the semantics pinned.
3. Does `GuardedMergeService` keep its SQLite receipts as a cache in front of
   the shared evaluator, or read the engine's receipts directly? The first keeps
   runtime latency predictable; the second keeps one source of truth.
