# Workflow Gate Engine

Design proposal for #142. Status: proposed, not implemented.

The repository already enforces three gates, each in its own script with its own
receipt format:

| Gate | Script | Receipt |
|---|---|---|
| local verification | `scripts/local-verify.mjs` | `.unified-mpc/local-verify/<head>-<id>.json` |
| exact-head review | `scripts/review-gate.mjs` | `.unified-mpc/reviews/receipts/<head>-<pr>.json` |
| merge | `scripts/guarded-merge.mjs` | `.unified-mpc/local-verify/merges/<head>-<pr>.json` |

They work, but they are three ad-hoc adapters over one idea: *a phase may
proceed only when durable evidence for the exact current input exists.* This
document proposes the deep module that idea belongs in, and a migration that
changes no behaviour on the way.

---

## 1. Module and seam

One module, one interface:

```ts
type Phase =
  | 'intake' | 'discover' | 'prepare' | 'mutate'
  | 'verify' | 'review' | 'integrate' | 'close';

interface GateRequest {
  workflow: { id: string; version: number };
  phase: Phase;
  subject: {
    repository: string;
    headSha: string;
    branch?: string;
    pr?: number;
    workspaceId?: string;
    goalId?: string;
  };
}

interface GateDecision {
  allowed: boolean;
  phase: Phase;
  blockers: readonly Blocker[];   // names the missing, stale or foreign evidence
  receiptId: string | null;       // present only when allowed
}

interface WorkflowGate {
  evaluate(request: GateRequest): Promise<GateDecision>;
  receipts(subject: GateRequest['subject']): Promise<readonly GateReceipt[]>;
}
```

`evaluate` is the whole external seam. It owns the phase order, which evidence
each phase requires, exact-input matching, staleness, and dependency ordering.
Callers — the three scripts today, MCP tools later — ask one question: *may this
phase proceed for this exact subject?* They never assemble evidence themselves.

Depth comes from what the caller no longer needs to know: that verification is
`mergeReady`-scoped, that a review receipt is bound to a capsule fingerprint,
that a merge record must reference both, that evidence for a superseded head is
inert. That knowledge lives in one implementation instead of three scripts.

Two adapters justify the seam:

- **filesystem** — the current `.unified-mpc/` layout, unchanged;
- **in-memory** — test doubles, and the shape a SQLite store would take later.

### Why not one module per gate

Because the phases share the exact-input rule and the blocker vocabulary, and
because the interesting failures are cross-phase: a review receipt for a head
that verification never saw, or a merge whose base moved. Splitting per gate
puts that logic in every caller. The deletion test says the same: delete the
engine and the cross-phase rules reappear in three scripts.

---

## 2. Phase model

The default workflow is a DAG, not a line: `review` and `verify` are both
required before `integrate`, and either may run first.

```text
INTAKE -> DISCOVER -> PREPARE -> MUTATE -> VERIFY --+
                                     |              +--> INTEGRATE -> CLOSE
                                     +--> REVIEW ---+
```

Required evidence per gate, all keyed by exact subject:

| Phase | Evidence | Exists today |
|---|---|---|
| `mutate` | pre-edit context for each touched path, workspace scope current | partially (native Thai-RAG) |
| `verify` | `mergeReady` receipt whose `headSha` + `diffFingerprint` match | yes |
| `review` | clean review receipt whose `headSha` + capsule `diffFingerprint` match | yes |
| `integrate` | `verify` + `review` allowed, PR open/non-draft, base unchanged, no retracted closing keyword | yes |
| `close` | merge record for the head, base revision known, no unique recoverable work | no |

Workflows are versioned data, not code: a profile names the phases and gates it
requires. The engine owns the semantics; a profile may only add requirements,
never remove the ones the repository pins.

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
  subject: GateRequest['subject'];  // includes headSha + diffFingerprint
  verdict: 'allowed' | 'blocked';
  blockers: readonly Blocker[];
  inputs: readonly { name: string; digest: string }[];  // exact evidence consumed
  createdAt: string;
  expiresAt?: string;         // only where evidence genuinely ages
}
```

Rules the implementation enforces:

- a receipt is valid only for the exact subject it names — a moved head, a new
  diff fingerprint or a changed base invalidates it;
- one subject has at most one receipt per gate per version, so a second opinion
  requires a new input, not a second receipt;
- a blocked evaluation is still recorded, so "why was this refused" is
  answerable after the fact;
- receipts are append-only; cleanup is `scripts/prune-evidence.mjs`, which
  already encodes the retention rules.

---

## 4. Enforcement points

The engine is only useful if something refuses. Three callers, in order of value:

1. **`merge:pr`** — delegates its existing checks to `evaluate({phase:'integrate'})`
   and keeps `--match-head-commit`. Behaviour must not change; the script's
   tests are the contract.
2. **close/cleanup** — refuses to delete a branch or worktree whose head has no
   merge record and whose work is not reachable from the base. This is the
   gate that would have caught a discarded-but-unmerged branch.
3. **`mutate`** — refuses an edit whose path has no current pre-edit evidence.
   Highest friction, so it ships last and behind a profile.

MCP exposure is a thin adapter over the same interface: one tool, one phase, one
decision. It must not re-derive policy.

---

## 5. Migration

Each step ships alone and leaves the repository working.

| Step | Change | Acceptance |
|---|---|---|
| 1 | Extract the merge-readiness rules into the module; `merge:pr` delegates | `guarded-merge.test.mjs` and `local-verify.test.mjs` pass unchanged; `merge:pr --dry-run` gives identical verdicts on three known heads |
| 2 | Add `gate:check --phase <p>` CLI + `close` gate | a branch with unmerged commits is refused; a merged head is allowed |
| 3 | Wire `verify`/`review` receipts through `receipts()` and add profile data | no new receipt format; existing receipts are readable as-is |
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
