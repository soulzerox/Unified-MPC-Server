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
runtime adapter over the same rule. That rule — evidence must exist, and it must
name this exact pull request, head and base, with a review that is not a
rejection — has one owner, the conformance corpus in
`apps/cli/src/workflow-gate-conformance.test.ts`, and both evaluators are
adapters it holds to it. Both receipts also record a repository, but only the
runtime evaluator compares it — the CLI merge gate never looks at the field,
although the backlog summary does — so that clause is recorded as runtime-only
rather than folded into the shared set or quietly dropped. They are not copies of one
function: the runtime receipt carries a verification mode, a gate list and a
review outcome, while the CLI receipt carries a profile version, a clean-tree
diff fingerprint and a findings document. Forcing those into one shape would
fabricate fields one side does not have, which is why step 4 repoints the runtime
at the shared rule instead of converting its receipts. Repointing it also settles
what "this exact subject" means on each side: the CLI reads the pull request from
GitHub, and since step 4a so does the runtime, instead of trusting the identity
the caller sent.

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
suites build-aware, or move them after `build`. **That step is dropped, not
deferred.** Both routes were measured and rejected: neither pays for itself,
because the two evaluators do not duplicate one decision (open question 4). The
shared rule is pinned by a conformance corpus instead, so the core stays plain
ESM under `scripts/` and no caller needs it from TypeScript. See "Status after
step 2" in section 5.

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
| `mutate` | `prepare_code_change` / pre-edit context for each changed path, workspace scope current | partially: the decision ships in #837 as an opt-in workspace mode (`require_preparation` refuses instead of auto-preparing); the default still auto-prepares, restores are a subject since 5b-1, and opaque mutations are step 5b-2 (see §4) |
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
   `--match-head-commit`. The runtime keeps its own receipt reader, its SQLite
   receipts and its `MergeEvidenceBlocker` vocabulary; what step 4a added is the
   subject: both sides now resolve the pull request from the provider instead of
   trusting the caller's description of it, and both refuse a subject that moved.
   The conformance corpus is what keeps the shared rule in one place.
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
     `UpgradeRuntimeService`, and it stays private: it is the destructive path's
     own answer, and the close gate must not reach into the class for it. Both
     paths derive their blockers from the same classifier, so there is one
     removal decision and not a second copy of it. The tool's preview is
     ownership-scoped before it returns, so a session that does not own the
     worktree gets `PERMISSION_DENIED` rather than a preview. The close gate
     therefore uses `createGoalWorktreeRemovalPreviewPort`, a read-only
     client-scoped composition of the same classifier (open question 5): it
     reports the same derivation without granting deletion, while the
     destructive path keeps its stricter session check.
   - goal completion's `goalCompletionWorktreeBlockers` returns entries for
     `dirty`, `unmerged_changes` and `probe_failed`; `unintegrated_head` is
     deliberately not blocking because the merge flow squash-merges. It is
     already enforced: `GoalContinuationService.goalCompletionWorktreeBlocker`
     refuses completion on it, client-scoped.

   The close gate composes those three; it does not redefine them. Goal
   completion already blocks `unmerged_changes` in a goal worktree, but a
   repository branch outside a goal worktree has no equivalent check.
3. **Mutation** — `ToolRegistry.validateHarnessMutation` is the seam. It is
   still narrower than "every edit fails closed": it covers the file-tool set
   in `codeMutationPaths` plus, since step 5b-1, the restore tools whose paths a
   store names (`shell`, `git` and `process_start` remain uncovered), and it
   returns allow when no `workspaceId` is resolved. Step 5a made the rest
   opt-in: in `require_preparation` mode the seam refuses instead of
   bootstrapping the harness and auto-preparing each path, and the default
   `auto_prepare` keeps the old behaviour for every workspace that does not opt
   in. The remaining coverage — opaque and unscoped mutations — is step 5b-2,
   and it must not become a second CLI gate that an MCP edit bypasses.

MCP exposure is a thin adapter over the same interface: one tool, one phase, one
decision. It must not re-derive policy, and it must not become a second
evaluator next to `GuardedMergeService`.

---

## 5. Migration

Each step ships alone and leaves the repository working.

| Step | Change | Acceptance |
|---|---|---|
| 1 ✅ | Promote the shared CLI policy (`evaluateReviewEvidence`, `selectVerificationReceipt`, merge-readiness) into build-free ESM under `scripts/`; `merge:pr` delegates | shipped in #820, #821, #824 |
| 2 ✅ | Make the shared rule enforceable across both worlds: not by packaging the core (both routes rejected, see open question 4) but by a conformance corpus that runs the CLI evaluator and the runtime evaluator over one scenario table | shipped in #833: `apps/cli/src/workflow-gate-conformance.test.ts` — one passing row, eight shared-rule rows, one row for the runtime-only repository clause, and each refusal must name the rule it broke |
| 3a ✅ | Add the `close` phase as a pure decision (`evaluateCloseGate`), its receipt reader/writer, `parseGateArgs` and `runCloseGate` over injected ports | shipped in #828: every refusal path, the fingerprint binding and the receipt round-trip are tested; the command has no production caller yet |
| 3b ⏸ | Wire `gate check --phase close`, the receipt store under `.unified-mpc/gates` and the matching `prune-evidence` update and test | removal preview ✅ (`createGoalWorktreeRemovalPreviewPort`, client-scoped); **blocked** only on `goalDurableReferenceStates` (#170); then: a goal worktree with `unmerged_changes` is refused, a merged head is allowed, `retention_pending` is refused, the new receipt kind is pruned by policy |
| 4a ✅ | Repoint `GuardedMergeService` at the shared rule: the subject it evaluates is now read from the provider, so a receipt can only authorize the pull request GitHub holds, and the gate acts on that decision | shipped in #834: `subject_mismatch`/`subject_unavailable` refuse before the receipt is read; the corpus gains an enforcement suite that fails if a blocked decision ever dispatches; the runtime keeps its `MergeEvidenceBlocker` vocabulary and the CLI receipt format is unchanged |
| 4b ⏸ | Wire `verify`/`review` through the engine's `receipts()` rather than each path reading its own store | blocked on the engine's receipt store existing in code; the runtime keeps its SQLite receipts until then (open question 3), and this step does not convert them |
| 4c ✅ | Evaluate the receipt against the subject the provider confirmed, so an omitted caller `baseSha` can no longer skip the receipt's base check | shipped in #836: a receipt written for another base is refused with `receipt_base_stale` whether or not the caller named a base; the runtime's receipt reuse already matches on `baseSha`, so a retargeted pull request gets a fresh receipt instead of a permanent refusal |
| 5a ✅ | Extend `validateHarnessMutation` with the `mutate` phase behind a workspace profile flag: `require_preparation` refuses rather than auto-preparing | shipped in #837: `mutate-gate.ts` owns the pure decision, the opt-in is `{ "workflowGate": { "mutate": "require_preparation" } }` in `.unified-mpc/project-profile.json`, an inactive or stale harness and every unprepared path are named refusals, and the default `auto_prepare` is unchanged |
| 5a.1 ✅ | Harden what 5a claims: one artifact classifier shared with the ponytail vocabulary, the preparation claimed at authorization rather than after the write, and the refusal `details` pinned by tests | shipped in #838: a backslash path can no longer be a ponytail mutation and an invisible harness mutation at once, two concurrent writes to one path land once, and a dropped or renamed `{ phase, reason }` fails the suite |
| 5b-1 ✅ | Give the phase a subject instead of a request: `mutation-subject.ts` resolves a request named path, a store named path (`restore_deleted_file`, `restore_recovery_item`, `restore_checkpoint`) and a command into one value the gate decides from | shipped in this PR: a restore in the opt-in mode is refused until the prepared target it overwrites still has content, and spends that preparation when it lands; a store-named path with no content to bind to (the delete-recovery case) is not demanded, because `prepare_code_change` cannot prepare an absent target; an id the store cannot resolve, and every command-shaped mutation, stay opaque and keep the default behaviour; the default mode is unchanged, including that it does not auto-prepare a restore and does not even read the store |
| 5b-2 ⏸ | Cover what is left: `shell`, `git`, `process_start` and any mutation with no resolved workspace | blocked on the evidence shape: those mutations name no development artifact path even indirectly, so a per-path preparation cannot bind to them; the phase has to decide whether a workspace-scoped preparation or command classification is the subject, and a token check would be worse than the gap |

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
| may this worktree be removed? | `createGoalWorktreeRemovalPreviewPort` over `GoalWorktreeReconciliationPort.classify` with `ownershipScope: 'client'`, or the `git_worktree_remove` **dry run** for the owning session | the dry run is ownership-scoped *before* the dry-run return, so a session that does not own the worktree gets `PERMISSION_DENIED` instead of a preview; the client-scoped preview is the read-only viewer for that case (open question 5) |
| may this goal complete? | the exported `goalCompletionWorktreeBlockers` over `GoalWorktreeReconciliationPort.classify` with `ownershipScope: 'client'`, the port `apps/cli` already builds | already enforced at completion; nothing to add. It and the preview both compare the entry owner to the asking client id, so the two agree after a session handoff |
| is this workspace cleanup-eligible? | `WorkspaceService.evaluateGoalWorkspaceCleanup`, already called from `apps/cli/src/commands/web.ts` | `retention_pending` is a waiting state, not a blocker |

So step 3 lands in `apps/cli`, next to the other commands. It does not need the
core, because it does not re-derive any policy — it reports three existing
decisions. Step 3a ships the decision and the receipt; step 3b ships the command,
and is blocked on the remaining prerequisite recorded below.

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

Step 3b is blocked on one remaining prerequisite, and it is not a guess:

1. `goalDurableReferenceStates`, without which `evaluateGoalWorkspaceCleanup`
   reports `durable_references_unknown` for every goal (#170).

The other prerequisite — a removal preview that can classify a worktree the
asking session does not own — is answered by open question 5 and shipped as
`createGoalWorktreeRemovalPreviewPort` in
`packages/application/src/goal-worktree-removal-preview.ts`:

```ts
const previews = createGoalWorktreeRemovalPreviewPort({ reconciliation });
const preview = await previews.preview({ workspaceId, worktreePath, actor });
// { worktreePath, status: 'clean' | 'blocked', blockers, blockerDetails,
//   owner, externallyOwned, activeLease, pathMissing }
```

It reuses the reconciliation port the completion gate already builds, asks with
`ownershipScope: 'client'`, and returns the same `status`/`blockers` shape the
CLI's removal port expects, so a session that did not spawn the worktree can
still preview it after a handoff. It is read-only; deletion keeps going through
`git_worktree_remove`, which keeps its session check and confirmation gate.

`externally_owned` stays a blocker here, unlike in
`goalCompletionWorktreeBlockers`: completion says which work a goal is
responsible for, while this preview says whether one specific path is removable.
Returning `clean` for a path the destructive path would refuse would make the
close receipt claim something that is not true. A path the ownership ledger does
not record is refused as `CONFLICT` instead of being assumed removable.

Wiring the command before #170 lands would ship a gate that refuses every goal —
fail-closed, but not a working feature.

### Status after step 2

Step 2 is shipped as a conformance corpus rather than a package, because the two
merge gates do not duplicate one decision (open question 4):

```text
apps/cli/src/workflow-gate-conformance.test.ts
  SCENARIOS ──┬─ cliVerdict()      → createGatePolicy(...).evaluateMergeEligibility
              └─ runtimeVerdict()  → evaluateMergeEvidence
  assert: same decision, decision is the expected one,
          and each refusal names the rule the row broke
```

Ten rows in two scopes. `shared` rows carry a field in both worlds and must reach
the same decision: the passing row, then exactly one field broken per row —
missing verification, missing review, a rejected review, a foreign head on either
receipt, a foreign base commit, a foreign base branch, a foreign pull request.
`runtime-only` rows exist where
only one evaluator compares the field. Both receipts record a repository; the
runtime refuses a foreign one and `evaluateReviewEvidence` never looks at it, so
the row asserts the runtime's refusal *and* that the CLI still allows the head.
That records the gap instead of hiding it, and fails the day the CLI starts
enforcing the clause — which is when the row must move to the shared table.

Every blocked row also names the refusal it must produce (`receipt_head_stale`
and `/verification receipt was produced for a different head/`, and so on), so a
row cannot be satisfied by an unrelated blocker that fires first. The suite also
pins that the corpus is not vacuous — one passing row, eight distinct shared
refusals with a CLI counterpart each — so an evaluator that refuses everything
cannot satisfy it.

The corpus binds the two profile rules through `createGatePolicy`'s injected
`{ profileVersion, fingerprintFor }` instead of reading this checkout's profile,
which is the seam #821 built for exactly this. It reads no files and runs no
commands. It does import `@unified-mpc/domain`, whose `exports` maps the
`development` condition to its source and `default` to its `dist`. With
`NODE_ENV` unset — the default for `verify:local`, which inherits the ambient
environment — that is the source, so the suite needs no build; under
`NODE_ENV=production` it resolves `dist` and needs one. It runs in `apps/cli`'s
`test:cli` step rather than the pre-build `.mjs` gate step, and adds no workspace
project and no profile step, so neither the merge step set nor `PROFILE_VERSION`
changes.

Nothing else about step 2 changes: `GuardedMergeService` keeps its own receipt
reader and its `MergeEvidenceBlocker` vocabulary.

### Status after step 4a

Step 2 proved the two evaluators agree. Step 4a is the step that makes the
agreement load-bearing, and the thing it had to fix was not the evaluator:

```text
caller ── subject ──► GuardedMergeService ──► evaluateMergeEvidence
                                  │                    │
                                  │                    └─ receipt must name
                                  │                       the *caller's* subject
                                  ▼
                          provider merge (sha = caller's head)
```

`GuardedMergeService` already delegated to `evaluateMergeEvidence` in
`packages/domain`, so it had one owner of its own policy. What it did not have
was an authoritative subject: `repository`, `pullRequest`, `headSha` and
`baseBranch` all came from the caller, so the policy's default-branch check could
be satisfied by a claim. The CLI cannot be fooled that way because it reads
`pr.baseRefName` from GitHub.

The service now takes a `GuardedMergeSubjectSource` and resolves the subject
before it reads the receipt. `apps/cli` implements it with the same
`observeOpenPullRequest` the verification runner uses — one provider read, two
callers — and wires it at the composition root. A disagreement is
`inspect_required` with `subject_mismatch`; an unreadable pull request is
`subject_unavailable`. Neither dispatches, and neither is a
`MergeEvidenceBlocker`: the evidence may be perfect for a subject that is no
longer the one being merged.

The corpus gained a second suite for exactly this. It runs the real
`GuardedMergeService` over the same scenario table with a recording dispatch
port: every blocked row must dispatch nothing, the allowed row must dispatch
once, and a caller subject the provider no longer holds must be refused. Changing
the service to dispatch despite a blocked decision fails that suite — the mutation
was checked by making the block check unreachable.

Step 4b is what remains of the original step: `verify`, `review` and `merge` each
still read their own store, and the engine's `receipts(subject)` has no
implementation to route them through. Converting the runtime's SQLite receipts
into engine receipts is not a refactor that changes no behaviour, so it waits for
the receipt store rather than being faked here (open question 3).

Step 4c closed the hole the 4a review found. `baseSha` is optional on a merge
subject and `evaluateMergeEvidence` only compares a base both sides carry, so a
caller that omitted `baseSha` still skipped `receipt_base_stale` even though the
service held the provider's base. The evaluator now receives the subject the
provider confirmed rather than the object the caller sent: the base is no longer
the caller's to omit, and the dispatched subject is the one that was authorized.
The receipt reuse path matches on `baseSha` before it reuses a receipt, so a
retargeted pull request is re-verified instead of being refused forever.

### Status after step 5a

`ToolRegistry.validateHarnessMutation` is the one seam every MCP code mutation
passes through, and until now it was not a gate. It auto-bootstrapped the harness
and auto-prepared each path inside the same call it authorized:

```text
write_file ──► validateHarnessMutation ──► prepare_code_change ──► allowed
                        │                        ▲
                        └── the evidence is ─────┘
                            manufactured by the
                            call it authorizes
```

Evidence that is created by the call it authorizes can never be missing, so the
seam proved only that preparation *can* run — never that it *did*. Step 5a turns
that into a decision the workspace can opt into.

`packages/mcp-server/src/mutate-gate.ts` owns the phase: `parseMutateMode`,
`workspaceMutateMode`, `evaluateMutateGate` and `describeMutateBlockers` are pure,
so the decision is tested without a workspace, a clock or a file read. The
opt-in is a workspace profile field:

```json
{ "workflowGate": { "mutate": "require_preparation" } }
```

In that mode the registry no longer manufactures evidence. An inactive harness is
`harness_inactive`, a harness whose `AGENTS.md` changed after preparation is
`harness_stale`, and any path the ledger does not currently hold is
`preparation_missing` — named in the refusal, bounded to five paths. The default
is `auto_prepare` and reads exactly like the old behaviour, and everything that is
not the exact opt-in value resolves to that default, so a missing, unreadable or
malformed profile cannot silently tighten the gate.

The decision is tested twice: as a pure matrix over modes, harness states and
path spellings, and through the registry on a workspace that opted in — an
unprepared write is refused with nothing written and no pre-edit call made, a
prepared write lands and spends the preparation, and a harness change after
preparation refuses with `workspace_bootstrap`. A malformed profile still
auto-prepares.

Two consequences of that decision are easy to get wrong, so the registry now
handles them explicitly. First, the preparation is claimed at authorization, not
after the write returns: otherwise two concurrent writes to one path would both
validate against the same ledger row and the second would land on evidence the
first had already spent. Because a write that fails may still have changed the
file, a claim is not refunded — the next attempt must re-prepare. Second,
`isDevelopmentArtifactPath` has exactly one implementation, shared with the
ponytail vocabulary: when the two classifiers could disagree, a path was a
ponytail mutation and an invisible harness mutation at the same time, so one
gate demanded its skill while the other saw nothing to prepare. The two still
answer different questions — ponytail also treats `lsp_rename` as a coding
mutation, which names no file — but they now share the predicate that decides
what counts as an artifact.

Step 5b-1 gave the phase a subject. `mutation-subject.ts` is the seam
`request -> what this mutates`, and it knows three answers: a path the request
spells, a path a store spells for it, and nothing it can name at all.

```text
write_file     path: 'src/app.ts'       ── request named ──► prepare that path
restore_deleted_file  recoveryId: '…'   ── store named ────► prepare the paths it
                                                    overwrites that hold content
shell          command: 'rm src/app.ts' ── opaque ─────────► unchanged (5b-2)
```

The gain is narrow and real: a restore used to escape the opt-in mode because
`codeMutationPaths` could not see through an id. It now resolves through the
recovery store or the checkpoint store, so in `require_preparation` mode a
restore that will write over a file which still has content is refused until
that file is prepared, and it spends that preparation when it lands.

A store can also name a path that has no content at all, and the ordinary
delete-then-restore case is exactly that: file-service refuses to restore a
`deleted` item onto a target that exists, so the path is absent by construction.
That path cannot carry a preparation — `prepare_code_change` binds its receipt to
the current bytes and refuses an absent target with `pre-edit-target-unreadable`
— so demanding one would refuse the flow the recovery trash exists for, forever,
rather than gating it. The subject is therefore reduced to the store-named paths
that can be prepared, and when none of them can, the restore keeps the behaviour
it had before it had a subject. Three further limits are deliberate:

- a store that cannot answer — an unknown id, an unreadable store, a scan window
  older than the checkpoint — resolves to an opaque subject, not to an invented
  path list. That keeps today's behaviour instead of refusing a restore on a
  lookup failure, and it is why the copy is still "path-bearing", not "covered";
- the default mode does not auto-prepare a restore, and it does not even read the
  store: auto-preparing one would read pre-edit context for a path that the
  restore exists because it is missing. That is the one mode where a restore
  answers a question it is never asked, so the lookup is skipped before it runs;
- `shell`, `git` and `process_start` still name no artifact, not even indirectly.
  Binding evidence to them is the remaining design question — a workspace-scoped
  preparation, or classification of the command — and answering it with a token
  check would be the same mistake as auto-preparation with fewer steps. It is
  recorded as `5b-2 ⏸`, not claimed.

Three limits are worth stating plainly rather than discovering later:

- a preparation is spent by the attempt it authorized, not by its success. A
  refused or failed mutation leaves the ledger empty, so a retry needs a fresh
  pre-edit call. That is the fail-closed direction: a partial write makes the old
  baseline stale, and refunding the receipt would authorize the retry on
  evidence nobody re-read;
- the opt-in can be absent without anyone meaning it. A typo, a profile written
  by an older writer, or an unreadable file all resolve to `auto_prepare`. That
  direction is deliberate — a broken profile must not brick every edit — but it
  means the mode is a convention the workspace declares, not a property the host
  can prove;
- `.unified-mpc/project-profile.json` is not a development artifact, so editing
  the file that holds the opt-in is not itself a prepared mutation. The gate
  governs code, not the configuration that turns it on: an operator who can write
  the profile can turn the phase off in the same breath. That is acceptable
  because the opt-in is a workspace setting, not a boundary between the agent and
  the human who set it — and pretending otherwise by gating one config file would
  say nothing about the next one.

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
4. ~~**How does the core reach `packages/application`?** A build-free ESM package
   with hand-written declarations, or an evaluator injected at a `.mjs`
   composition root.~~ **Answered: neither. The shared rule is a conformance
   corpus, not shared code.** Both routes assumed the two evaluators duplicate one
   decision. They do not: the runtime checks a verification mode, a required gate
   list and a review outcome; the CLI checks a profile version, a clean-tree diff
   fingerprint, a findings document and a bundled skill hash. Merging them would
   fabricate fields one side does not have or drop checks the other enforces.
   What they genuinely share is smaller than either route's cost: *evidence must
   exist, and it must name this exact pull request, head and base, with a review
   that is not a rejection*. That rule is now owned by
   `apps/cli/src/workflow-gate-conformance.test.ts`, which runs both real
   evaluators over one scenario table and fails if they disagree. The repository
   clause is recorded as `runtime-only`: both receipts carry the field, but only
   the runtime evaluator compares it — the CLI merge gate has no repository
   input, and `evaluateReviewEvidence` never reads the receipt's copy.

   Rejected route 1 (build-free package with hand-written declarations) because
   the declarations would be a hand-maintained mirror of the implementation, and
   rejected route 2 (evaluator injected at a `.mjs` composition root) because the
   shipped CLI is `dist/index.js` with no `.mjs` asset pipeline, so the injector
   would need a new distribution path before it could exist. Route 1 also carries
   a cost the proposal did not mention: a new workspace project that defines a
   `test` script joins the merge profile's step set, which bumps `PROFILE_VERSION`
   and invalidates every in-flight verification receipt — including other
   sessions' open PRs — for a refactor that changes no behaviour.

5. ~~Does the close gate ask as the owning session, or does
   `git_worktree_remove` grow a read-only viewer?~~ **Answered: the tool does not
   grow a second mode, and the gate does not ask as the owning session.** The
   ownership check makes the dry-run preview unreachable from a session that did
   not create the worktree, which is the common case when a goal is closed after
   a handoff. Adding a viewer mode to the destructive tool would put two
   ownership rules in one place; asking as the owning session is impossible once
   that session is gone. Instead `createGoalWorktreeRemovalPreviewPort` composes
   the existing read-only port with `ownershipScope: 'client'`: the client that
   owns the goal is stable across a session handoff, so the preview follows the
   goal while deletion keeps its stricter session check. It also keeps every
   removal blocker, including `externally_owned`, because a preview that says
   `clean` where the destructive path refuses would make the close receipt lie;
   only the same-client case is relaxed.
