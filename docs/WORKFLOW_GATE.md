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
import — `guarded-merge.mjs` and `review-gate.mjs` both bind the predicates in
`scripts/workflow-gate-core.mjs` — while the runtime path has its own receipt
model and predicates. This document proposes the deep module that idea belongs
in, and a migration that changes no behaviour on the way.

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
importable without a build.

The original plan had step 2 move it into a workspace package and make the gate
suites build-aware, or move them after `build`. That step is **deferred, not
dropped**: no phase-3 caller needs the core from TypeScript, but phase 4 does,
because `GuardedMergeService` lives in `packages/application` and must delegate
to the same evaluator instead of keeping its own. See "Status after step 1" in
section 5 for the two routes and their cost.

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
| `close` | cleanup disposition `retention_candidate`, worktree removal `clean`, no completion blocker; merge evidence and a known base are the routing inputs a later step adds | partially: #828 ships the decision over the three close inputs and a decision receipt; it reads no head, base or merge evidence yet (see "Status after step 3a") |

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
   The CLI already delegates to the shared `evaluateMergeEligibility` and keeps
   `--match-head-commit`; `GuardedMergeService` still holds its own receipt
   reader, which is step 4. Neither side may change behaviour, and the runtime
   side needs the receipt conversion described above.
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
     `UpgradeRuntimeService`, and it stays private: its own dry run already
     returns the same verdict without mutating anything — it reads the ownership
     ledger and runs read-only Git probes, and the test that proves it
     (`upgrade-runtime-worktree-safety.test.ts`, "reports the classification in a
     dry run without touching git or the ledger") asserts an empty removal-side
     Git call list, not an absence of reads. The close gate therefore asks
     the tool for a preview rather than reaching into the class, so there is one
     removal decision and not a second copy of it. The preview is ownership-scoped
     before it returns, so a session that does not own the worktree gets
     `PERMISSION_DENIED` rather than a preview: the close gate must ask as the
     owning session, or this tool needs a read-only viewer that reports the same
     verdict without the ownership check.
   - goal completion's `goalCompletionWorktreeBlockers` returns entries for
     `dirty`, `unmerged_changes` and `probe_failed`; `unintegrated_head` is
     deliberately not blocking because the merge flow squash-merges. It is
     already enforced: `GoalContinuationService.goalCompletionWorktreeBlocker`
     refuses completion on it, client-scoped.

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
| 1 ✅ | Promote the shared CLI policy (`evaluateReviewEvidence`, `selectVerificationReceipt`, merge-readiness) into build-free ESM under `scripts/`; `merge:pr` delegates | shipped in #820, #821, #824 |
| 2 ⏸ | Make the shared core importable from TypeScript: a build-free ESM package, or an injected evaluator at the composition root | **deferred**: not needed by step 3, required by step 4; see "Status" below |
| 3a ✅ | Add the `close` phase as a pure decision (`evaluateCloseGate`), its receipt reader/writer, `parseGateArgs` and `runCloseGate` over injected ports | shipped in #828: every refusal path, the fingerprint binding and the receipt round-trip are tested; the command has no production caller yet |
| 3b ⏸ | Wire `gate check --phase close`, the receipt store under `.unified-mpc/gates` and the matching `prune-evidence` update and test | **blocked** on a removal preview that can classify a worktree the asking session does not own (open question 5) and on `goalDurableReferenceStates` (#170); then: a goal worktree with `unmerged_changes` is refused, a merged head is allowed, `retention_pending` is refused, the new receipt kind is pruned by policy |
| 4 | Convert runtime merge evidence to the shared model, repoint `GuardedMergeService`, wire `verify`/`review` through `receipts()` | runtime gate tests pass unchanged; existing runtime receipts are converted, not silently invalidated; the CLI receipt format is unchanged |
| 5 | Extend `validateHarnessMutation` with the `mutate` phase behind a profile flag | opt-in only; default profile unchanged; all mutation tools covered, and a missing preparation refuses instead of auto-preparing |

Step 1 is deliberately a refactor with no user-visible change. It is the step
that pays for the rest, and the one that must not invent new policy.

### Status after step 1

Step 1 is shipped and the core is already independent of the profile runner:

```
scripts/workflow-gate-core.mjs     imports only check-issue-closing-keywords.mjs
  createGatePolicy({ profileVersion, fingerprintFor })
    ├─ evaluateMergeEligibility
    ├─ selectVerificationReceipt
    └─ verificationGateBlockers
        ↑                                    ↑
scripts/guarded-merge.mjs          scripts/review-gate.mjs
```

Both CLIs bind this checkout's profile; a runtime caller supplies its own. The
binding is tested rather than assumed: `scripts/workflow-gate-core.test.mjs`
builds the policy for a foreign profile version and a foreign fingerprint rule
and asserts the verdict moves, because every other suite only ever exercises the
real profile's values.

That is why step 2 no longer gates step 3. The `close` gate's three inputs are
application state, and all three are reachable from `apps/cli` today:

| Question | Reached through | Caveat |
|---|---|---|
| may this worktree be removed? | the `git_worktree_remove` **dry run**, which returns the same safety verdict and performs no mutation (it reads the ownership ledger and runs read-only Git probes) | the preview is ownership-scoped *before* the dry-run return, so a session that does not own the worktree gets `PERMISSION_DENIED` instead of a preview: it must ask as the owning session, or the tool needs an explicit read-only viewer |
| may this goal complete? | the exported `goalCompletionWorktreeBlockers` over `GoalWorktreeReconciliationPort.classify` with `ownershipScope: 'client'`, the port `apps/cli` already builds | already enforced at completion; nothing to add. Client scope compares the entry owner to the asking client id, so an MCP-spawned (`cli-mcp-stdio`) row is same-client here — only the preview above mismatches |
| is this workspace cleanup-eligible? | `WorkspaceService.evaluateGoalWorkspaceCleanup`, already called from `apps/cli/src/commands/web.ts` | `retention_pending` is a waiting state, not a blocker |

So step 3 lands in `apps/cli`, next to the other commands. It does not need the
core, because it does not re-derive any policy — it reports three existing
decisions. Step 3a ships the decision and the receipt; step 3b ships the command,
and is blocked on the two prerequisites recorded below.

### Status after step 3a

#828 landed the decision without its caller:

- `apps/cli/src/commands/gate.ts` — `evaluateCloseGate` (verdict, blockers,
  fingerprint), the receipt reader/writer, `parseGateArgs`,
  `formatCloseGateVerdict` and `closeGateExitCode`.
- `apps/cli/src/commands/gate-command.ts` — `runCloseGate` over three injected
  ports: cleanup, removal preview and completion.

Each refusal keeps its owner, and `retention_candidate` + `clean` + no completion
row is still the only passing combination. A port that fails aborts instead of
being folded into a verdict, and a goal with no cleanup row in scope refuses as
`cleanup_unclassified`. The receipt binds the verdict to a fingerprint of the
rows the decision used, and the reader narrows the verdict and every blocker
instead of casting, so a foreign file is refused rather than formatted.

Step 3b is blocked on two things, and neither is a guess:

1. a removal preview that can classify a worktree the asking session does not own
   (open question 5 below), and
2. `goalDurableReferenceStates`, without which
   `evaluateGoalWorkspaceCleanup` reports `durable_references_unknown` for every
   goal (#170).

Wiring the command before both land would ship a gate that refuses everything —
fail-closed, but not a working feature.

Step 4 is where packaging becomes real. `GuardedMergeService` must delegate to
`evaluateMergeEligibility`, and it lives in `packages/application`, which cannot
import `scripts/`. Two honest routes:

1. **Build-free ESM package** — move the core to a workspace package that exports
   `src/index.mjs` with hand-written `src/index.d.ts`. TypeScript resolves the
   declarations, Node loads the module, and no build step exists to order. Cost:
   the declarations are a hand-maintained mirror of the implementation, and a
   wrong declaration is a silent type lie rather than a compile error.
2. **Injected evaluator at the composition root** — `GuardedMergeService` takes
   the evaluator as a port (it already takes a receipt reader and a dispatch
   port), and a `.mjs` composition root imports the core and passes it in. No
   package and no declarations. Cost: the wiring moves to a file outside both
   worlds, and a caller that forgets to pass it must fail closed rather than fall
   back to a built-in copy.

Route 2 matches `createGatePolicy` and keeps the core unbuilt, which preserves
the pre-`build` gate suites; route 1 is more conventional for this repository.
This is the decision to make before step 4, not before step 3.

---

## 6. Non-goals

- authorization (#134) and human approval (#19) — the engine consumes their
  decisions, it does not make them;
- goal liveness (#82) — a gate may require a live goal, but does not own it;
- CI itself — external check results are inputs, not gates;
- deciding *what* a project should test. A profile names the commands; the
  engine only records that they ran on the exact input.

## 7. Open questions

1. ~~Should step 1 land before any new gate exists, or should the engine start as
   a standalone `close` gate and absorb the merge rules later?~~ **Answered in
   practice.** Step 1 landed first (#820, #821, #824) and found two defects that
   the standalone route would have shipped into a second implementation: the
   merge guard's private copy of the receipt checks was kept in sync with the
   review gate's by hand and had already diverged in what it told the operator,
   and the gate's dependence on the profile runner would have made the package
   step circular. The no-op-diff risk was real but bounded: the differential dry
   run on three heads is what kept it honest.
2. Are workflow profiles configuration (a file under `.unified-mpc/`) or code
   (a typed constant)? Configuration makes per-project specialization cheap but
   needs validation; code keeps the semantics pinned. `createGatePolicy` makes
   this cheaper to answer later: the profile is now an input, so a file-backed
   profile is a different *caller*, not a rewrite.
3. Does `GuardedMergeService` keep its SQLite receipts as a cache in front of
   the shared evaluator, or read the engine's receipts directly? The first keeps
   runtime latency predictable; the second keeps one source of truth.
4. **How does the core reach `packages/application`?** A build-free ESM package
   with hand-written declarations, or an evaluator injected at a `.mjs`
   composition root. This is the decision step 4 needs and step 3 does not; see
   "Status after step 1". It is listed here rather than settled because both
   routes are honest and the choice depends on whether the repository wants to
   own hand-maintained type declarations at all.
5. **Does the close gate ask as the owning session, or does
   `git_worktree_remove` grow a read-only viewer?** The preview's ownership check
   makes that preview unreachable from a session that did not create the
   worktree, which is the common case when a goal is closed after a handoff.
