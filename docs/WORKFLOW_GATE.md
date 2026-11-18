# Workflow Gate Engine

Design and implementation record for #142. Status: partially implemented.
The shared rule, the phase vocabulary, the `close` decision (3a), the runtime
merge subject check (4a) and the `mutate` phase (5a, 5b-1…5b-3) have shipped;
`gate check --phase <phase>` does not exist yet, and the `close` phases still
read no head, base or merge evidence (see the status sections in section 5).

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
| `mutate` | `prepare_code_change` / pre-edit context for each changed path, workspace scope current | partially: the decision ships in #837 as an opt-in workspace mode (`require_preparation` refuses instead of auto-preparing); the default still auto-prepares, restores are a subject since 5b-1, and since 5b-3 every mutation the extractor table cannot turn into a path — except the delegated effects named in §5b, and a mutation that resolves no `workspaceId`, for which there is no profile to read a posture from — is admitted-and-recorded or refused by policy, as is a restore whose store cannot resolve the id it was given (see §4) |
| `verify` | a `mergeReady` receipt whose `headSha` + `diffFingerprint` match, from the `merge` profile on a clean tree | yes |
| `review` | a clean review receipt whose `headSha` + capsule `diffFingerprint` match, and a `verify` receipt for the head | yes |
| `integrate` | `verify` + `review` allowed, PR open/non-draft, base unchanged, no retracted closing keyword | yes, in two receipt models; the draft and closing-keyword checks are CLI-only today |
| `close` | cleanup disposition `retention_candidate`, worktree removal `clean`, no completion blocker; merge evidence and a known base are the routing inputs a later step adds | partially: #828 ships the decision over the three close inputs and a decision receipt; it reads no head, base or merge evidence yet, and the durable-reference source it needs now exists as the #170 journal (see "Status after step 3a") |

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
  `scripts/prune-evidence.mjs` and its tests. Prune plans
  `.unified-mpc/local-verify`, `.unified-mpc/reviews` and `.unified-mpc/gates`;
  the verification store skips filenames that do not match its receipt pattern,
  while the review and close-gate stores read every `.json` file and refuse the
  whole plan when one is unreadable. A new kind dropped into any of those
  directories would be silently unpruned or would break pruning.

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
   in `codeMutationPaths`, since step 5b-1 the restore tools whose paths a store
   names, and since step 5b-3 every non-`read` mutation that is not in
   `DELEGATED_EFFECT_TOOLS`. That last half is the complement of a short list, so
   the seam covers a mutation as soon as the registry declares it and its
   spelling cannot take it out of coverage. It returns
   allow when no `workspaceId` is resolved. Step 5a made the rest opt-in: in
   `require_preparation` mode the seam refuses instead of bootstrapping the
   harness and auto-preparing each path, and the default `auto_prepare` keeps the
    old behaviour for every workspace that does not opt in. What is left is the
   delegated effect — a gateway call, a host UI action, a command the workspace
   configured, durable control-plane and provider state — which stays with the
   mutation policy rather
   than becoming a second gate that would refuse reads. Two of those are local and
   can write the workspace — the configured command, and a synthetic input event —
   so `refuse` contains neither; §5b states that cost. It is still not a second
   CLI gate that an MCP edit bypasses.

MCP exposure is a thin adapter over the same interface: one tool, one phase, one
decision. It must not re-derive policy, and it must not become a second
evaluator next to `GuardedMergeService`.

---

## 5. Migration

Each step ships alone and leaves the repository working.

| Step | Change | Acceptance |
|---|---|---|
| 1 ✅ | Promote the shared CLI policy (`evaluateReviewEvidence`, `selectVerificationReceipt`, merge-readiness) into build-free ESM under `scripts/`; `merge:pr` delegates | shipped in #820, #821, #824 |
| 1a ✅ | Give every gate receipt a workflow identity: one versioned definition (`scripts/workflow-definition.mjs`) that the verify and review receipts name, and a merge guard that refuses a receipt produced under another definition | shipped here: the definition owns `WORKFLOW_ID`, `WORKFLOW_VERSION`, the gated phases and their gate ids, plus a `sha256` fingerprint over that meaning which an append-only test table records per version. `buildReceipt` (`scripts/local-verify.mjs`) and the review receipt (`scripts/review-gate.mjs`) carry `workflow: workflowStamp(phase)`, and `verificationGateBlockers`/`evaluateReviewEvidence` in `scripts/workflow-gate-core.mjs` refuse a block with the wrong id, version, phase, gate or fingerprint — including a receipt that carries no block at all, because it was written before the definition existed and vouched for a step set this gate does not apply. `apps/cli/src/workflow-gate-conformance.test.ts` supplies the real stamp, so both evaluators stay in agreement. The close gate receipt (`apps/cli/src/commands/gate.ts`) still carries its own literal `version: 1`: it is written by compiled TypeScript, which cannot import `scripts/` without a build dependency the close gate does not have, so it joins this definition when open question 2 decides whether a profile is data or code |
| 2 ✅ | Make the shared rule enforceable across both worlds: not by packaging the core (both routes rejected, see open question 4) but by a conformance corpus that runs the CLI evaluator and the runtime evaluator over one scenario table | shipped in #833: `apps/cli/src/workflow-gate-conformance.test.ts` — one passing row, eight shared-rule rows, one row for the runtime-only repository clause, and each refusal must name the rule it broke |
| 3a ✅ | Add the `close` phase as a pure decision (`evaluateCloseGate`), its receipt reader/writer, `parseGateArgs` and `runCloseGate` over injected ports | shipped in #828: every refusal path, the fingerprint binding and the receipt round-trip are tested; the command has no production caller yet |
| 3b ✅ | Wire `gate check --phase close`, the receipt store under `.unified-mpc/gates` and the matching `prune-evidence` update and test | shipped with #170's deferred-closure follow-up (#848): `apps/cli/src/index.ts` routes `gate check` through `parseGateArgs`/`runCloseGate` with the three real ports — `evaluateGoalWorkspaceCleanup` over the #170 journal projection, `createGoalWorktreeRemovalPreviewPort` (client-scoped) and `goalCompletionWorktreeBlockers` — and writes the receipt to `<workspace>/.unified-mpc/gates` unless `--dry-run`; `scripts/prune-evidence.mjs` plans that store as a third one (newest `--keep` receipts survive, an unreadable receipt refuses the whole run) with six tests; a refusal exits `1` and still records its receipt. Bundled with #848 on purpose: wiring the gate before the closure fix would point it at a projection that called live work `clear` |
| 3c ✅ | Close a deferred call from the authority that owns its handle, so the projection can stop pinning once the work really ended | shipped as the #170 freshness step: `workspace_journal_events` gains `closure_code`/`closed_at` (migration `047`), `closeDeferredCalls` writes them for deferred kinds only, and a runtime closes only the calls it opened itself, at the first later completion in that workspace, by asking each call's own handle whether its work ended — a `project_*` launcher returns while its process still runs, so the release lands on a later request of the same runtime, never on another host's view (`apps/cli/src/runtime/deferred-journal-closure.ts`, kinds `process_start`, `shell`, `wsl_exec`, the `project_*` launchers, `task_create`, `merge_verification_run`, `verify_incremental`, `benchmark_run`, `run_affected_tests`, `codex_run`, `agent_swarm_run`, `delegate` and `parallel_delegate`). A process kind closes under `no_live_process` once the runtime that created the handle lists nothing live; a durable task kind closes under `no_live_task` once the shell backend that wrote the task directory reports a terminal state; a queued verification closes under `no_live_verification` once the status port reports its attempt terminal, a `codex_run` closes under `no_live_codex` once the `CodexService` that launched it reports the task's managed process terminal (a codex process lives in the codex adapter's own process manager and is invisible to the CLI listing, so its id is recorded under provider `codex`, never `process`; the service is in-memory, so a restarted host answers `PROCESS_NOT_FOUND` and the pin stays), a started agent swarm closes under `no_live_swarm` once the `AgentSwarmService` that started it reports the swarm terminal (`agent_swarm_run start`, `delegate` and `parallel_delegate` record it under provider `swarm`; the read sub-actions record nothing, since they name a swarm the call did not start), and a verification that already produced its receipt settles its own call under `verification_settled` (nothing was queued, so no probe could answer for it). A `git_worktree_spawn` call has no closure *route* by design: its row is a durable reference, and the `present` it reports is the `durable_references_present` blocker that stops goal-workspace cleanup from discarding a worktree that still holds work, so no `CLOSURE_ROUTES` entry and no `no_live_worktree` code exist and the worktree lifecycle authorities answer the removal question instead. Its *preview* is the exception and closes under `worktree_preview_settled`, because a preview creates nothing and leaves nothing for those authorities to answer; a real `dryRun: false` spawn keeps its pin even when it failed. A call with no recorded handle is judged by the process listing only when its kind is one that listing can speak for, so a durable task, a queued verification, a `codex_run` or an agent swarm can never be called gone by a process answer |
| 3d ✅ | Make the close receipt revision-scoped: one fingerprint, one receipt, and a store that refuses evidence it cannot trust | shipped for #142 criterion 3 (the receipt half): `findCloseGateReceiptForVerdict` (`apps/cli/src/commands/gate.ts`) reads the store by fingerprint, so `gate check --phase close` reuses the receipt an earlier run wrote for exactly these inputs — a restarted host reports `receipt <path> (unchanged: these inputs already have this receipt)` instead of writing a second receipt that claims the same revision — and refuses a file it cannot read as a receipt, because the answer is only useful if the surviving evidence is trustworthy. Verdicts are compared in canonical form, because the fingerprint is already order-free: a caller listing the same worktrees in another order, or an older receipt that sorted its blockers differently, still describes this revision and is reused. A readable receipt cannot hold two decisions for one fingerprint (the reader keeps `allowed` consistent with `blockers`), so the contradiction branch only fires on a receipt that describes a different decision for these inputs — a forged or hand-edited file — and it refuses rather than picking a winner |
| 4a ✅ | Repoint `GuardedMergeService` at the shared rule: the subject it evaluates is now read from the provider, so a receipt can only authorize the pull request GitHub holds, and the gate acts on that decision | shipped in #834: `subject_mismatch`/`subject_unavailable` refuse before the receipt is read; the corpus gains an enforcement suite that fails if a blocked decision ever dispatches; the runtime keeps its `MergeEvidenceBlocker` vocabulary and the CLI receipt format is unchanged |
| 4b ⏸ | Wire `verify`/`review` through the engine's `receipts()` rather than each path reading its own store | blocked on the engine's receipt store existing in code; the runtime keeps its SQLite receipts until then (open question 3), and this step does not convert them |
| 4c ✅ | Evaluate the receipt against the subject the provider confirmed, so an omitted caller `baseSha` can no longer skip the receipt's base check | shipped in #836: a receipt written for another base is refused with `receipt_base_stale` whether or not the caller named a base; the runtime's receipt reuse already matches on `baseSha`, so a retargeted pull request gets a fresh receipt instead of a permanent refusal |
| 5a ✅ | Extend `validateHarnessMutation` with the `mutate` phase behind a workspace profile flag: `require_preparation` refuses rather than auto-preparing | shipped in #837: `mutate-gate.ts` owns the pure decision, the opt-in is `{ "workflowGate": { "mutate": "require_preparation" } }` in `.unified-mpc/project-profile.json`, an inactive or stale harness and every unprepared path are named refusals, and the default `auto_prepare` is unchanged |
| 5a.1 ✅ | Harden what 5a claims: one artifact classifier shared with the ponytail vocabulary, the preparation claimed at authorization rather than after the write, and the refusal `details` pinned by tests | shipped in #838: a backslash path can no longer be a ponytail mutation and an invisible harness mutation at once, two concurrent writes to one path land once, and a dropped or renamed `{ phase, reason }` fails the suite |
| 5b-1 ✅ | Give the phase a subject instead of a request: `mutation-subject.ts` resolves a request named path, a store named path (`restore_deleted_file`, `restore_recovery_item`, `restore_checkpoint`) and a command into one value the gate decides from | shipped in #840 and closed out here: a restore in the opt-in mode is refused until the prepared target it overwrites still has content, and spends that preparation when it lands; a store-named path with no content to bind to (the delete-recovery case) is not demanded, because `prepare_code_change` cannot bind an absent target; the checkpoint subject is read by id, so an old checkpoint is still named; an id the store cannot resolve, and every command-shaped mutation, stay opaque and keep the default behaviour; the default mode is unchanged, including that it does not auto-prepare a restore and does not even read the store |
| 5b-2 ✅ | Give the phase an answer for what it cannot gate: command-shaped mutations (`shell`, `wsl_exec`, `git`, `process_start`) reach the seam, and an opaque subject is either admitted with a durable record or refused by the workspace's policy | shipped in #844: `workflowGate.mutateOpaque` (`allow` \| `refuse`, default `allow`) is a setting *of* the opt-in phase, so it is inert while `mutate` is `auto_prepare`; `allow` admits the mutation and writes `admitted <tool> with an opaque <reason> subject` to the call's audit detail, `refuse` answers CONFLICT with `reason: 'opaque_mutation'` and the subject's kind, and a command classified `read` (a task `status`, a `dry_run`, a read-only git subcommand) never reaches the phase at all. A mutation with no resolved `workspaceId` is still allowed, and a workspace that does not opt in is unchanged |
| 5b-3 ✅ | Decide the residual the phase still cannot see: the path-less families 5b-2 excluded (`git_publish`, `office`, `docx_merge`, `scheduler`, `self_heal_apply`, `agent_swarm_run`, `process_stop`, `mcp_call`, `codex_run`, `computer_use`). A mutation with no resolved `workspaceId` was listed in the same residue; without a workspace there is no profile, so the phase allows it by policy rather than deciding it from a posture | shipped in #846: the four-tool list is gone, and so is the union of "tools that mutate" sets it was replaced with — five reviews each found one more declaration outside the union (a scheduled task, a recording, a background shell task, a goal rebase, a merge). The reach is now the complement of `DELEGATED_EFFECT_TOOLS`: every non-`read` mutation the extractor table cannot turn into a path is decided, including `publish_approve`, `codex_stop`, the git worktree tools, `scheduler`, `audio`, `screen_record`, `task_create`, `task_cancel`, `delegate`, `parallel_delegate`, `delegate_cancel`, `guarded_pr_merge` and `rebase_goal_workspace`; what stays delegated is the gateway (`mcp_call`, `web_fetch`, `dom_cdp`), the desktop tools and the file dialog, the commands the workspace configured, the lifecycle of a goal that already exists with its scheduled continuation, runtime selection and registration state, a preview whose contract admits no write, and the native provider's own memory and code index, each with a stated reason. `run_goal` is decided, because starting a goal creates its Goal Workspace, so `refuse` cannot create a worktree by another name; a strict workspace therefore cannot start or resume a goal, and relaxing `mutateOpaque` is the way through. A mutation with no resolved `workspaceId` is still allowed: without a workspace there is no profile, so the phase allows it by policy, and that half of the original residue is a limit rather than something this step decided |

Step 1 is deliberately a refactor with no user-visible change. It is the step
that pays for the rest, and the one that must not invent new policy.

### Status after step 1

Step 1 is shipped and the core is already independent of the profile runner:

```
scripts/workflow-gate-core.mjs     imports check-issue-closing-keywords.mjs, workflow-definition.mjs
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

The definition those gates are decided under is one module:
`scripts/workflow-definition.mjs` owns `WORKFLOW_ID`, `WORKFLOW_VERSION`, the
phase list and the gate that decides each phase, and exports
`workflowStamp(phase)` and `workflowStampBlockers(stamp, phase)`.
`scripts/local-verify.mjs` and `scripts/review-gate.mjs` write the stamp into
their receipts. The close receipt still does not: `apps/cli/src/commands/gate.ts`
is compiled TypeScript, and the published `apps/cli` package does not ship
repo-root `scripts/`, so a `import()` of the definition would resolve to a path
the installed CLI does not have. It keeps its own literal `version: 1` until
open question 2 decides whether a profile is data or code.
`scripts/guarded-merge.mjs` refuses a verification or review receipt whose block
names none or another definition.
The fingerprint is recorded per version in
`scripts/workflow-definition.test.mjs`, so editing a phase or gate without a
version bump fails before any receipt can be believed.

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

Step 3b's last prerequisite — the durable-reference source — ships as the #170
workspace journal:

1. `goalDurableReferenceStates` answers `clear`/`present` from
   `workspace_journal_events`. A goal is `present` while one of its live
   (non-archived) workspaces owns a `started` row with no matching `completed`
   row, and `clear` otherwise,
   so an operation that never reported an outcome keeps its worktree. A
   handle-returning operation — every kind in
   `DEFERRED_CLOSURE_OPERATION_KINDS`, which is also unioned into the runtime
   journal allowlist so the two cannot drift — is `present` even after its own
   call returns: that call ends the request, not the work, and closing it from a
   durable task/process record is a later #170 step — reporting it `clear` would
   classify a workspace with a running process as a retention candidate. That
   later step now exists for the kinds whose handle is a managed process, for
   durable shell tasks, for a queued merge verification, for a local codex task and
   for a started agent swarm: `closeDeferredCalls`
   records a `closure_code` once the runtime that created the handle can prove
   none is live (`no_live_process`), once the shell backend reports the task
   terminal (`no_live_task`), once the verification status port reports the
   attempt behind `merge_verification_run` terminal (`no_live_verification`; a
   `running` attempt whose heartbeat expired counts as terminal, because the
   receipt — not the attempt — is what authorizes a merge), once the `CodexService`
   that launched a `codex_run` task reports its managed process terminal
   (`no_live_codex`; that service is in-memory, so a host that restarted answers
   `PROCESS_NOT_FOUND` and the pin stays), or once the `AgentSwarmService` that
   started a swarm reports it terminal (`no_live_swarm`; a host that restarted mid-swarm
   downgrades it to `termination_unverified`, which never becomes terminal, so the pin
   stays), and a closed call stops
   pinning while keeping its row. A verification that reached its verdict inside
   the call settles itself under `verification_settled`: nothing was queued, so no
   probe could ever answer for it. An `agent_swarm_run` read (`status`/`result`/
   `cancel`/`list`) settles itself under `swarm_read_settled`: it starts nothing, and
   the snapshot it answers for names a swarm this call did not start, so no handle
   may be recorded and no probe can answer for it either. That holds for a read that
   failed as well, since a read that failed still started nothing, and for a read the
   runtime refused before its handler ran: settlement runs on every exit path, so a
   validation failure, a hard block or an approval denial still settles the rules its
   input answers for. A rule that needs the response — a verification settles only
   when it reported a completed attempt — stays untouched by a refusal, because a
   refusal produced no verdict and settling it would claim a gate ran that never did.
   A `start`,
   `delegate` or `parallel_delegate` that failed records nothing and keeps its pin:
   a cancelled start may have launched a swarm this host can no longer name. A
   `task_create` that answered without a task id settles itself under
   `task_create_settled`: the capability service was unavailable, so no durable task
   exists for the call and nothing could ever answer for it. An errored create keeps
   its pin, because the launch path can fail after the worker was forked and still
   answer `INTERNAL_ERROR`, and the error envelope cannot be told apart from a
   failure that reserved nothing. A codex process lives in the codex adapter's own
   process manager and a swarm in its own runtime, so neither is ever in the CLI
   listing: their ids are recorded under provider `codex` and `swarm`, never
   `process`, which could only read them all as gone. A `git_worktree_spawn` call
   deliberately has no closure *route*: its row is a durable reference, not work in
   flight, so no runtime probe may claim the worktree is gone.
   `goalDurableReferenceStates` reports the goal `present` while that row carries no
   `closure_code` — its `completed` row ends the request, not the pin — and that
   `present` is the `durable_references_present` blocker
   `evaluateGoalWorkspaceCleanup` raises, which is what stops goal-workspace cleanup
   from discarding a worktree that still holds work. Closing the row from this
   runtime would report the goal `clear`, and the close gate would lose one of the
   blockers it refuses on, leaving a later `git_worktree_remove` free to delete the only
   handle to that work. So the pin is the answer rather than a gap. The ledger's
   provider union does list `worktree`, but there is deliberately no
   `CLOSURE_ROUTES` entry for the kind and no `no_live_worktree` code: the worktree
   lifecycle authorities (`GoalWorktreeReconciliationPort`,
   `goal-worktree-ledger`) answer the removal question directly, and the journal is
   not the place to duplicate it. That covers a spawn that created a worktree. A
   `git_worktree_spawn` *preview* is the exception, and it settles itself from its
   input under `worktree_preview_settled`: the tool defaults to a preview, which
   creates nothing, so its row pins a goal over a worktree that was never made and the
   lifecycle authorities have nothing to answer about. The preview settles whether it
   answered or failed, because the input already said nothing would be created. A call
   that really spawned (`dryRun: false`) keeps its pin even when it failed: it may have
   created the worktree and then errored, so reading the error as "nothing was created"
   would release a pin over work that exists.
   Retention collapses older *open* calls of a kind whose open row is interchangeable
   in-flight work, so a launcher costs one row per kind instead of growing with every
   launch, and collects a closed call like any other evidence. A kind whose *newer* open
   row can end itself is never collapsed (`DURABLE_REFERENCE_OPERATION_KINDS`:
   `git_worktree_spawn`, `agent_swarm_run`, `merge_verification_run`, `task_create`): collapsing would
   let that newer row evict an older open row that no later call represents, and then
   close itself, leaving the kind with nothing open while the work it stood for still
   runs. The exemption is name-level, so it is broader than the hazard — an
   `agent_swarm_run start` row and a real `dryRun: false` spawn cannot settle themselves;
   their kinds are listed because they can also produce a row that does. What that costs:
   an exempt kind's open row is out of reach of every other retention pass, so a reference
   with no closure route does keep its rows for the life of the workspace and counts
   against `maxEventsPerWorkspace` until closed calls bring that excess down — a closed
   call of any kind is collected, the exempt kind's own settled preview among them — and a
   released pin over live work is worse than rows a rare event appends. `run_goal` stays
   out of the pinning set entirely: the goal runtime already tracks goal liveness.
   `apps/cli` passes that map into `reconcileLifecycle` and
   `evaluateGoalWorkspaceCleanup`, and `gate check --phase close` reads it through
   the ports below, so a live journal no longer reports
   `durable_references_unknown` and the close gate no longer decides blind.

The write side is the runtime's own append beside the audit log
(`apps/cli/src/runtime/stdio-mcp-runtime.ts`), and its only free text is the
500-character `summary`. That column is redacted in the store before the bound is
judged (`SqliteWorkspaceJournalRepository.append`), with the same `Redactor` the
audit log uses: bearer tokens, `*_TOKEN`/`_SECRET`/`_PASSWORD`/`_API_KEY`
assignments and provider key prefixes are rewritten to `[REDACTED]`. A journal
row outlives the request that wrote it and is replayed to sessions that were
never present, so a credential in a summary would be re-published by every later
resume. The runtime append itself passes no summary at all today.

A durable task started under a rolling goal records the goal and the generation
it was started under. The registry puts `CAPABILITY_GOAL_CORRELATION_METADATA_KEY`
(`unified-mpc.goalCorrelation.v1`, `{ goalId, executionGeneration }` taken from
the lease proof) beside `unified-mpc.taskOwner.v1` on a `shell`/`wsl_exec`
request; the shell backend folds it into the owner, and the task metadata keeps
it as `owner_goal_id`/`owner_execution_generation`, so the snapshots a resumed
session reads say which generation the work belongs to instead of comparing it
with whatever generation is current by then. A task started outside a goal
records neither field. Ownership matching is unchanged — workspace first, then
client/session when neither side has one — because that is identity, not
staleness.

The journal is the discovery index, not the identity of durable work. A durable
shell task's metadata is written to its task directory when the task is reserved
or launched, before any telemetry exists, and ownership matching reads the
workspace first, so a session that never saw the call id still lists a task
another session started in the same workspace and reads its state and result by
id. That route needs the workspace id in the call: `task_list`, `task_status`,
`task_result` and `task_cancel` (or `shell` with the same operation) forward it
as the requester's owner metadata, so a workspace-scoped caller reaches the task
with no journal row at all. The MCP `tasks/list` protocol has no workspace
parameter and the request scope carries none, so it only sees tasks owned by the
same client/session; a workspace-owned task is invisible there and must be read
through those tools. A failed journal append therefore loses the resume row, not
the task: the append is best-effort by contract and only writes to stderr, while
the task directory is the authority. A requester whose owner names another
workspace does not match the stored owner, so the store answers as if the task
did not exist; the workspace id is a caller-supplied scope, not a credential,
and this path makes no stronger claim than that.

Staleness is a separate question, and #170 answers it on both sides. A mutation
is already refused unless the proof the fence admitted is the *current*
generation (`GoalMutationFenceService.begin` validates the lease generation
against the durable fence), so an old generation cannot change goal state. It
must not be able to pretend its work is current either, which is what the journal
columns `goal_id`/`execution_generation` are for: the completion's journal row
carries the same admitted correlation the task metadata does, and the resume
projection compares a call's newest correlated row with the generation the fence
reports now. A call admitted under an older generation of the same goal is
projected as `superseded: true` and is not open, so `workspace_resume`,
`workspace_bootstrap` and `session_handoff` report it as an execution that ended
rather than as work to wait on or rerun. Two deliberate limits: a row with no
correlation stays unjudged (`superseded: false`, its own generation absent) rather
than assumed stale, and a fence that cannot answer leaves the whole window
unjudged, because a resume must still be readable and guessing staleness could
retire work that is still running.

`workspace_resume` is the journal's read side for a caller that asks directly
(`packages/application/src/workspace-resume-snapshot.ts`, wired in the stdio
runtime over the same `SqliteWorkspaceJournalRepository` the host appends to):
one call answers "what ran here since the cursor I hold" for a session that was
not present — a new session, a reconnect, a handoff. It is bounded
(`WORKSPACE_RESUME_DEFAULT_LIMIT` 20, `WORKSPACE_RESUME_MAX_LIMIT` 100, both
below the store's own `MAX_LIST_LIMIT` 200 so the reader can ask for one row more
than the bound and prove `truncated` rather than infer it from a clamped reply),
cursor-based (`afterSequence` in, `cursor` out, oldest first so the caller can
replay in order; `window: newest` starts at the current end instead and reports
`olderCursor` to page back with `beforeSequence`), and read-only. `openReferences` answers which calls in that
window may still be running, using the store's own pin rule rather than the
window's rows: a plain call ends at its `completed` row, which may sit past the
cursor, while a handle-returning call stays open past its own `completed` row
until a freshness probe writes `closure_code`. That rule is
`SqliteWorkspaceJournalRepository.openCallIds` — the same predicate
`goalDurableReferenceStates` pins with, asked for the window's call ids — so a
resumed session cannot read finished work as running. A runtime without a journal
still advertises the tool, and a call to it is refused with `INTERNAL_ERROR`
rather than answered with an empty event list, which would read as "nothing
happened here".

`workspace_bootstrap` carries the same snapshot as `resume`, read through the
same reader at its default cap, so the session-start call is a read side too and
a caller that does not know to ask does not have to. Three states, and they stay
distinct: the snapshot when the journal is wired (an empty journal is an empty
snapshot, which is an answer), the field absent when the runtime has no journal
(no claim), and `null` when the journal could not be read — a journal failure is
recorded as a diagnostic and never fails the bootstrap, because the harness was
already marked bootstrapped by the time the journal is read. The window is the
newest rows, because a session that just attached needs the rows describing
current work rather than the first rows a busy workspace ever wrote, so
`truncated: true` means older rows exist and `olderCursor` is the
`beforeSequence` that reads them; `openReferences` counts only the calls in that
window.

`session_handoff` is a read side too, through the same projection rather than a
second derivation: it includes the window as `workspace_journal`, with the same
three states as bootstrap, and its recovery prompt states the journal verdict
(absent, unreadable, empty, or a window with open calls) so durable task state
comes from the journal instead of the chat. Because a newest window is bounded,
each rendered row carries its own `recordedAt` so a reader can tell a
just-finished call from one written before it, and the prompt names
`olderCursor` when older rows exist rather than implying the window is all. A snapshot the reader could not have
produced — one naming another workspace — is refused as `CONFLICT` rather than
handed to the next session. A read that fails still produces a handoff, but not
silently: the throwing path goes through `sanitizeException` and the refusal
path reports `WorkspaceHandoffJournalUnavailable`, both through the same
diagnostic sink `workspace_bootstrap` uses, so a broken journal is visible to
whoever operates the host.

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
`workspaceWorkflowGate`, `evaluateMutateGate` and `describeMutateBlockers` (and,
since 5b-2, `parseOpaqueMutatePolicy`, `evaluateOpaqueMutateGate`,
`describeOpaqueMutateRefusal` and `describeOpaqueMutateAdmission`) are pure, so
the decision is tested without a workspace, a clock or a file read. The opt-in is
a workspace profile field:

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
shell          command: 'rm src/app.ts' ── opaque ─────────► recorded, or refused (5b-2)
```

The gain is narrow and real: a restore used to escape the opt-in mode because
`codeMutationPaths` could not see through an id. It now resolves through the
recovery store or the checkpoint store, so in `require_preparation` mode a
restore that will write over a file which still has content is refused until
that file is prepared, and it spends that preparation when it lands. The
checkpoint read is by id, not by listing: an old checkpoint still names its
paths instead of falling out of a scan window and reading as opaque.

A store can also name a path that has no content at all, and the ordinary
delete-then-restore case is exactly that: file-service refuses to restore a
`deleted` item onto a target that exists, so the path is absent by construction.
That path cannot carry a preparation — `prepare_code_change` binds its receipt to
the current bytes and refuses an absent target with `pre-edit-target-unreadable`
— so demanding one would refuse the flow the recovery trash exists for, forever,
rather than gating it. The subject is therefore reduced to the store-named paths
that can be prepared, and when none of them can, the restore demands no
preparation. It is still a path-bearing subject, so when the store names at
least one development artifact the phase's harness checks run before the
preparation is asked for: a workspace that opted in and has no active harness is
refused with `harness_inactive` for that restore, which is one refusal more than
it had before it had a subject. A store that names only non-artifacts resolves
to an empty artifact list, and an empty list is allowed early — that is what a
restore of a documentation file does today and what it did before. Under
Trusted Full Bypass the premise is weaker — `prepare_code_change` registers a
path without reading it — so an absent target *can* carry a preparation there;
the reduction does not special-case that mode, because a bypass exists to skip
evidence, not to require it. Three further limits are deliberate:

- a store that cannot answer — an unknown id, a store this deployment does not
  wire, an unreadable store — resolves to an opaque subject, not to an invented
  path list. That keeps today's behaviour instead of refusing a restore on a
  lookup failure, and it is why the copy is still "path-bearing", not "covered";
- the default mode does not auto-prepare a restore, and it does not even read the
  store: auto-preparing one would read pre-edit context for a path that the
  restore exists because it is missing. That is the one mode where a restore
  answers a question it is never asked, so the lookup is skipped before it runs;
- a command names no artifact the phase can parse, and a mutation whose target the
  extractor table does not model — `office`'s `file_path`, `audio`'s and
  `screen_record`'s `output_path` — names one the table cannot turn into a
  subject. The distinction matters: the request may well name its target, it is
  the table that does not answer for the field, so a later step that adds those
  fields moves the family into the path-bearing route instead of contradicting
  this limit. Steps 5b-2 and 5b-3 answer the residue with a decision rather than a
  parser — see below.

### Steps 5b-2 and 5b-3: what the phase does with a subject it cannot see

A command-shaped mutation cannot be turned into a path. Parsing one would be the
same mistake as auto-preparation with fewer steps: `bash -c`, a glob, or
`node -e` satisfies any parser anyone writes, and a classifier that says "this
command mutates `src/app.ts`" is a claim about behavior the gateway cannot
observe. So the phase does not pretend. It gives the residue an explicit
decision, and makes the decision visible:

```json
{ "workflowGate": { "mutate": "require_preparation", "mutateOpaque": "refuse" } }
```

As shipped in #844 the phase reached four command-shaped tools. Step 5b-3
replaced that list with a rule. **The phase decides every mutation it cannot turn
into a path, except the effects it delegates.** The reach is the complement of
`DELEGATED_EFFECT_TOOLS`, not a union of "tools that mutate" sets: the registry
declares tools in more than one place, so every union was one declaration short,
and the reviews of this step found a scheduled task, a recording, a background
shell task, a goal rebase and a merge in that gap, one per round.

- a mutation the extractor table cannot turn into a path now reaches the seam
  instead of skipping it. Before step 5b-2 `validateHarnessMutation` was never
  called for them, because `isCodingMutation` is a question about request shape
  and a command has no path shape;
- `mutateOpaque` is a setting *of* the phase. With `mutate: auto_prepare` it is
  never consulted: a workspace that has not opted in keeps its old behaviour and
  gets no audit note, because nothing decided anything. This is one opt-in with
  two answers, not two gates that can be half-on;
- `allow` (the default) admits the mutation and writes one sentence to the call's
  durable audit detail: `mutate: admitted shell with an opaque shape subject and
  no prepared path`. The record rides the call it belongs to, so "did the gate
  cover this?" is answerable from the same audit row as the mutation;
- `refuse` answers CONFLICT with `details: { phase: 'mutate', reason:
  'opaque_mutation', opaqueReason: 'shape' | 'unresolved' }` and a message that
  names the tool, the missing subject and the ways out: relaxing the setting, and,
  per reason, a form whose request names the file it writes (`shape`) or a subject
  this workspace can resolve (`unresolved`).
  It refuses on the subject, not on a guess about the effect, so it cannot be
  fooled by a spelling;
- a call the mutation policy already classifies `read` — a task `status`, a
  `dry_run`, a read-only git subcommand, an `office` read, a `screen_record`
  status — never reaches the phase. Everything else that mutates does, so `refuse`
  refuses `shell pnpm test`, `git commit`, `git_publish`, `codex_run`,
  `task_create`, `guarded_pr_merge` and a plugin install alike, because the
  gateway cannot prove any of them harmless. It also refuses the `stop` that would
  end a recording, a process, a task or a codex run, because the phase decides by
  tool shape rather than by action: a strict workspace should not start what it
  could not stop. A stop that was already running when the workspace opted in is
  the same trap, and the honest answer is the setting, not the phase — relax
  `mutateOpaque` for the stop. The lifecycle of a goal that already exists and the
  native provider's own store are the exception §5b names, for the reasons given
  there: refusing a goal's completion, or the memory the workflow records, would
  decide state the phase does not own. Starting a goal is not an exception — it
  creates the Goal Workspace, so the phase decides it. That is the cost of a
  shape-based posture, stated rather than discovered: `refuse` is a posture for a
  workspace whose mutations must all be path-bearing, and the state a tool keeps
  about that workspace is not one of them — it is not a filter that lets
  "ordinary" commands through.

Widening the call site has one cost worth stating: a non-`read` call to a tool that
is not delegated now reads the workspace profile before the phase is known to be
off, so a workspace that never opted in pays one file read per mutation — the same
read a coding mutation already pays — and its decision is unchanged. Paying that
read is what makes the phase's answer a property of the workspace rather than of
the tool the caller happened to use.

What the phase does not decide is the whole of `DELEGATED_EFFECT_TOOLS`, and each
group is there for a reason that would not hold for a mutation:

- the project-command tools — `project_dev`, `project_test`, `project_lint`,
  `project_typecheck`, `project_build`, `run_affected_tests`, plus
  `verify_incremental`, which asks the managed process service for the same
  `typecheck` project command `project_typecheck` runs — run a command the
  workspace configured, not an argv the caller chose, so they are not the
  arbitrary-write hole `shell` is. For `run_affected_tests` the command is the
  managed process service's `test` project command, resolved from the workspace
  rather than from the request.
  Refusing them would also block the verification step inside the very workspace
  that opted in. The asymmetry is worth naming: `shell` with a `pnpm test` argv is
  refused, `project_test` is not, because the second cannot be pointed at a
  different command. A configured command can still write, so `refuse` does not
  contain it either;
- gateway-mediated calls and desktop effects — `mcp_call`, `web_fetch`,
  `dom_cdp`, `computer_use`, and the desktop tools (`accessibility`,
  `input_event`, `ui_target_action`, `window`, `clipboard`, `notification`,
  `file_dialog`) — are
  not workspace mutations: they reach a remote system or drive the host UI, and
  their refusal belongs to the mutation policy's approval gate. This is the other
  place `refuse` is not containment, and it is stated rather than implied:
  `mcp_call` can still reach a child tool that writes, and a synthetic
  `input_event` can type into an editor, because the gateway cannot classify
  either effect. The mutation policy's own gate is narrower: it classifies a child
  it can prove read-only — an exact child tool the runtime policy lists in
  `readOnlyTools`, whose live descriptor and catalog fingerprints still match — so
  its approval asks about the unproven calls and not the proven ones. `refuse` does
  not reach either kind: the gateway call is delegated whole, which is why a
  strict workspace still has to read the approval prompt rather than the phase for
  it. `file_dialog` belongs here for the narrower reason that it opens a host
  dialog and returns the chosen path: it writes nothing, so a fail-closed
  classification would be the only thing refusing it;
- the lifecycle of a goal that already exists — `checkpoint_goal`, `finish_goal`,
  `reconcile_goals`, `retry_goal_workspace_admission` — the
  scheduled-continuation lifecycle (`prepare_scheduled_continuation`,
  `claim_scheduled_continuation`, `record_scheduled_continuation_receipt`,
  `expedite_scheduled_continuation`) and the two stops writes state the phase does
  not own: a goal or a continuation can predate the opt-in or be owned by another
  client, and `finish_goal` is part of the goal-completion contract the runtime
  already enforces. Refusing it would leave a strict workspace unable to finish,
  recover or abandon a goal it did not start, and the setting is the answer to the
  pre-opt-in case, exactly as it is for a stop. `run_goal` is not in this group:
  starting a goal creates its Goal Workspace worktree and `goal/<id>` branch, the
  same mutation `git_worktree_spawn` performs, so the phase decides it — `refuse`
  cannot create a workspace by another name. The cost is stated rather than
  discovered: a strict workspace cannot start or resume a goal, and relaxing
  `mutateOpaque` is the way through. The `stop` of a recording, a process, a task
  or a codex run stays in the phase too, because those are the counterpart of a
  mutation the same workspace could start;
- runtime selection and registration state — `workspace_activate`,
  `workspace_deactivate`, `workspace_set_primary`, `workspace_register` — is not
  workspace content: it updates the runtime's active set, or records a
  registration the mutation policy already classifies as a bounded write that
  changes no project files. The phase answers a selection with the *target*
  workspace's profile and a registration with the caller's own, so deciding
  either would make the strict posture refuse the call that turns the posture on:
  an inactive strict workspace can only be mutated once it is active, so it could
  never be activated again, and it could not be deactivated either; a strict
  machine root could not register the project its own posture would then gate;
- the registry's previews — `project_profile_set`, `recipe_run` and
  `benchmark_run` — cannot write through their reachable contracts. The profile
  tool's strict input contract admits `workspaceId` and `profile` only, so the
  handler always answers with the dry-run preview and has no route to `writeFile`;
  `recipe_run` answers with the plan itself, `sideEffectsStarted: false`, even
  when the caller passes `dryRun: false`, so it never runs the recipe it names;
  and `benchmark_run`'s contract admits only `workspaceId`, `name` and
  `iterations`, so the `dryRun` switch above the `processService.start` of the
  script it detected from `package.json` is unreachable. A fail-closed
  classification would be the only thing refusing any of them. Each of the three
  is a preview by contract, not by intent: if a contract admits the switch that
  would start the work — a profile `dryRun`, a recipe run that executes, a
  benchmark `dryRun` — the tool has to leave this list;
- the native provider's durable state — `working_memory_record`,
  `workspace_memory_record`, `rag_remember`, `rag_forget`,
  `rag_resolve_constraint`, `rag_memory_reconcile`, `rag_code_reconcile`,
  `rag_code_index`, `rag_cancel_index`, `rag_adopt_legacy_index` — is the evidence
  the phase reads rather than work it decides. None of them names a path: a memory
  record is written to the provider's store, a constraint closes a turn there, and
  the code index behind `prepare_code_change` is repaired by the same tools. So
  `refuse` would stop a strict workspace from recording the memory the workflow
  mandates and from keeping the evidence its own gate depends on fresh, which is
  the one refusal a path-based posture cannot ask for. `rag_forget` stays an
  opaque, approval-guarded deletion in the mutation policy; the delegation only
  means the phase stops demanding a subject for it.

`git_publish` is in the reach even though it changes a remote: it is a workspace
mutation gated by a local single-use receipt, and the phase decides it by the same
rule. `guarded_pr_merge` and `rebase_goal_workspace` are in the reach for the same
reason, which is why a `refuse` workspace cannot merge or rebase: none of the three
has a path-bearing form, so relaxing `mutateOpaque` is the only way through.

The reach, not a category, is the answer: `isPhaseDecidedMutation` is the
complement of a written-out exception list, and five tests across the two files
hold it — the delegation list itself, the shape of each delegated family, every
name in the delegation list and in the
always-confirm list or the catalog being a tool the registry actually routes, every
mutation the catalog declares, and the registry's own always-confirm list. A new
tool is decided by default, so it cannot leave coverage by being declared somewhere
this step did not read. It also does not gate a mutation that resolves no workspace:
`validateHarnessMutation` still allows it before the profile is read. Both are
stated here rather than discovered later.

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
