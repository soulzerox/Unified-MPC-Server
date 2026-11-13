# Workflow Gate Engine

Design proposal for #142. Status: proposed, not implemented.

The repository already enforces gates, each with its own receipt store:

| Gate | Implementation | Receipt |
|---|---|---|
| local verification | `scripts/local-verify.mjs` | `.unified-mpc/local-verify/<head12>-<id>.json` |
| exact-head review | `scripts/review-gate.mjs` | `.unified-mpc/reviews/receipts/<head12>-<pr>.json` |
| merge (CLI) | `scripts/guarded-merge.mjs` | `.unified-mpc/local-verify/merges/<head40>-<pr>.json` |
| merge (runtime) | `GuardedMergeService` + `evaluateMergeEvidence` | SQLite, via `docs/GUARDED_MERGE.md` |

They work, but they are adapters over one idea: *a phase may proceed only when
durable evidence for the exact current input exists.* The CLI path already
shares part of it by import — `guarded-merge.mjs` reuses `evaluateReviewEvidence`
and `selectVerificationReceipt` from `review-gate.mjs` — while the runtime path
re-implements the same policy in TypeScript. This document proposes the deep
module that idea belongs in, and a migration that changes no behaviour on the
way.

The runtime merge gate is not a fourth gate and not future work: it is the
runtime adapter over the same policy. The engine must be the single owner of
"is this head verified and reviewed", and both the CLI script and
`GuardedMergeService` must delegate to it rather than keep separate evaluators.
Step 3 below is where the runtime adapter is repointed.

Because both a Node script and the TypeScript runtime must import it, the module
ships as a workspace package with a built entry point; the scripts consume the
built output the same way the runtime does. Keeping it as script-to-script
imports would leave the runtime unable to share it, which is the duplication
this design exists to remove.

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
  paths?: readonly string[];      // 'mutate' only
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
Callers — the CLI scripts today, the runtime service and MCP tools later — ask
one question: *may this phase proceed for this exact subject?*

The engine resolves the rest of the subject itself. It is constructed with the
sources it reads, so a caller cannot hand it evidence and cannot skip a source:

```ts
interface GateSources {
  verification: { latest(subject: GateSubject): Promise<VerificationReceipt | null> };
  review:       { latest(subject: GateSubject): Promise<ReviewReceipt | null> };
  pullRequest:  { read(repository: string, pr: number): Promise<PullRequestState | null> };
  workspace:    { cleanup(subject: GateSubject): Promise<CleanupEvidence> };
  now(): string;
}
```

`ResolvedSubject` — the caller's identity plus `baseSha`, `diffFingerprint` and
the pull-request state — is what the engine records in a receipt. That is the
difference between a subject that can own the evidence and one that cannot: the
`integrate` gate needs the PR's base and draft state, `review` needs the capsule
fingerprint, and `mutate` needs the touched paths, and all of those are resolved
through a source rather than trusted from the caller.

Two adapters justify the seam:

- **live** — the current `.unified-mpc/` layout plus `gh`/GitHub for PR state;
- **in-memory** — test doubles, and the shape a SQLite-backed source would take.

### Why not one module per gate

Because the phases share the exact-input rule and the blocker vocabulary, and
because the interesting failures are cross-phase: a review receipt for a head
that verification never saw, or a merge whose base moved. Splitting per gate
puts that logic in every caller. The deletion test says the same: delete the
engine and the cross-phase rules reappear in three scripts.

---

## 2. Phase model

The order is linear, and it is the order the repository already enforces:

```text
INTAKE -> DISCOVER -> PREPARE -> MUTATE -> VERIFY -> REVIEW -> INTEGRATE -> CLOSE
```

`review` requires a `verify` receipt for the same head. That is not a new rule:
`scripts/review-gate.mjs` already refuses to freeze a capsule or record a review
without one (`verificationGateBlockers`, the "#142 before_review gate"), because
a review of an unverified head is spent on a head that cannot land. The engine
encodes that dependency; a profile may add requirements, never remove one the
repository pins.

Required evidence per gate, all keyed by the resolved subject:

| Phase | Evidence | Exists today |
|---|---|---|
| `mutate` | pre-edit context for each path in `subject.paths`, workspace scope current | partially (native Thai-RAG) |
| `verify` | a `mergeReady` receipt whose `headSha` + `diffFingerprint` match | yes |
| `review` | a clean review receipt whose `headSha` + capsule `diffFingerprint` match, and a `verify` receipt for the head | yes |
| `integrate` | `verify` + `review` allowed, PR open/non-draft, base unchanged, no retracted closing keyword | yes, in two places |
| `close` | merge record for the head, base revision known, `WorkspaceService.evaluateGoalWorkspaceCleanup` clean | partially (the cleanup evaluation exists; the gate does not) |

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

- a receipt is valid only for the exact subject it names — a moved head, a new
  diff fingerprint or a changed base invalidates it;
- `verify` is a run log: many receipts per subject, append-only, and the gate
  selects one by head and fingerprint exactly as `selectVerificationReceipt`
  does today. A re-run after a failed or targeted run is normal;
- `review` is one per subject. A second opinion needs a new head, which is the
  existing contract and why a re-frozen capsule is refused;
- `integrate` and `close` record one receipt per action, so a merge or a cleanup
  can be audited after the fact;
- a blocked evaluation is recorded too, so "why was this refused" is answerable;
- receipts extend the existing stores — no third root — and
  `scripts/prune-evidence.mjs` is extended in the same step that adds a new
  receipt kind, so retention never silently skips a directory.

---

## 4. Enforcement points

The engine is only useful if something refuses. Three CLI enforcement points, in
order of value:

1. **`merge:pr`** — delegates to `evaluate({phase:'integrate'})` and keeps
   `--match-head-commit`. Behaviour must not change; the script's tests are the
   contract.
2. **close/cleanup** — refuses to delete a branch or worktree whose head has no
   merge record, whose work is not reachable from the base, or whose goal
   workspace cleanup is not clean. This is the gate that would have caught a
   discarded-but-unmerged branch, and it consumes
   `WorkspaceService.evaluateGoalWorkspaceCleanup` instead of re-deriving its
   `goal_runtime_not_idle` / `goal_integration_not_integrated` /
   `goal_workspace_not_clean` / `active_writer_lease` /
   `durable_references_*` blockers.
3. **`mutate`** — refuses an edit whose path has no current pre-edit evidence.
   Highest friction, so it ships last and behind a profile.

Base revision for `close` comes from the merge record, which stores the base
branch, plus the resolved base SHA the engine records at merge time; a base that
moved afterwards is a blocker, not a silent pass.

MCP exposure is a thin adapter over the same interface: one tool, one phase, one
decision. It must not re-derive policy, and it must not become a second
evaluator next to `GuardedMergeService`.

---

## 5. Migration

Each step ships alone and leaves the repository working.

| Step | Change | Acceptance |
|---|---|---|
| 1 | Promote the shared CLI policy (`evaluateReviewEvidence`, `selectVerificationReceipt`, merge-readiness) into a workspace package; `merge:pr` delegates | `guarded-merge.test.mjs` and `local-verify.test.mjs` pass unchanged; `merge:pr --dry-run` gives identical verdicts on three known heads |
| 2 | Add `gate:check --phase <p>` CLI + the `close` gate | a branch with unmerged commits is refused; a merged head is allowed |
| 3 | Repoint `GuardedMergeService` at the same evaluator and wire `verify`/`review` through `receipts()` | no new receipt format; existing receipts are readable as-is; the runtime gate's own tests pass unchanged |
| 4 | Add the `mutate` gate behind a profile flag | opt-in only; default profile unchanged |

Step 1 is deliberately a refactor with no user-visible change. It is the step
that pays for the rest, and the one that must not invent new policy.

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
3. Does `GuardedMergeService` keep its SQLite receipt store as a cache in front
   of the shared evaluator, or does it read the engine's receipts directly? The
   first keeps runtime latency predictable; the second keeps one source of
   truth.
