# Exact-head review gate design

Date: 2026-10-30
Issue: [#144](https://github.com/soulzerox/Unified-MPC-Server/issues/144)

## Decision

A merge needs **two** receipts for the same PR head: the local verification
receipt that already exists, and a **review receipt** produced by a dedicated
reviewer that was given only a frozen capsule of that head. Both are durable
files keyed by the full head SHA, and `pnpm merge:pr` refuses unless both exist,
match the current head and carry no open blocking findings.

```text
IMPLEMENTER                         REVIEWER (fresh context)
  branch -> push -> PR                capsule (head H1) -> findings -> receipt H1
        |                                   |
        +-------- verify:local H1 ----------+
        |                                   |
        v                                   v
                 merge:pr --pr N   (requires both for H1)
```

The review half does not reuse the runtime's `clean_llm_review` evidence. That
path only proves a `COMMENTED` GitHub review containing a marker exists at the
head: it has no findings, no severity, no proof the mandatory skill was loaded,
and nothing that survives when a review comment is edited. A local gate needs
structured, hash-bound evidence.

## Why a fresh reviewer, not the implementer

`#143` calls for role-scoped context capsules. The implementer's transcript is
exactly the wrong input for a review: it carries the reasoning that produced the
diff, which biases a reviewer toward accepting it. The capsule carries only what
a reviewer needs, and the reviewer is a **separate sub-agent/session** whose
context starts empty.

The capsule is a directory, not a prose summary, so the reviewer reads the same
bytes the gate froze:

```text
.unified-mpc/reviews/capsules/<head12>-<pr>/
  capsule.json   machine-readable manifest (ids, SHAs, file list, fingerprint)
  capsule.md     reviewer instructions + the same facts, human-readable
  diff.patch     gh pr diff output at the head
  files.txt      changed paths, one per line
```

The capsule records the **full head SHA**, the base SHA, the PR body, issue
references, the changed-file list, the diff fingerprint, the mandatory skill
identity and any merge-ready verification receipt for that head. It never
contains implementer chat, notes, or hidden reasoning.

## Mandatory skill

The review contract lives in `.agents/skills/unified-code-review/SKILL.md`.
`record` hashes the file and refuses a findings document whose `skill_sha256`
does not match the file on disk, so editing the skill invalidates every older
review until a fresh review loads the new text. The skill carries a `version`
in frontmatter; the receipt stores both version and hash because a version is a
claim and a hash is evidence.

Ponytail review can still run as an extra complexity pass. It cannot produce a
review receipt, so it can never satisfy this gate.

## Findings contract

The reviewer writes one JSON document; `record` validates it and freezes the
receipt. Reviewer-authored fields:

```json
{
  "head_sha": "<40 hex>",
  "capsule_id": "<uuid from capsule.json>",
  "skill_id": "unified-code-review",
  "skill_version": 1,
  "skill_sha256": "sha256:<64 hex>",
  "diff_fingerprint": "sha256:<64 hex>",
  "reviewer": "reviewer-subagent",
  "findings": [
    {
      "severity": "blocking | nonblocking",
      "category": "correctness | concurrency | security | error-handling | resource | compatibility | spec | tests | cross-file | architecture | operations | maintainability",
      "file": "path/relative/to/repo",
      "line": 42,
      "claim": "what is wrong, in one or two sentences",
      "evidence_refs": ["path:line", "command or document that shows it"],
      "required_fix": true,
      "status": "open | fixed | accepted_nonblocking | invalidated"
    }
  ]
}
```

`line` may be `null` for a whole-file finding. `record` adds the review identity and the recomputed verdict. The receipt on
disk uses camelCase keys; these are the fields:

```text
reviewId, role=reviewer, prNumber, baseSha, headSha, workflowVersion,
skillId, skillVersion, skillSha256, capsuleId, capsuleRef,
reviewedFingerprint, reviewer, findings[], blockingOpenCount,
verdict: clean | blocked, createdAt
```

Validation is closed-set and reports every bad field with a message naming the
finding index, because a silently accepted typo in `severity` would turn a
blocking finding into a pass.

## Blocking rule

A finding blocks while `status === "open"` and `required_fix === true`.
`severity: "blocking"` requires `required_fix: true`; the reverse is allowed so
a nonblocking finding can still demand a fix. `verdict` is recomputed, never
trusted: a document that claims `clean` while blocking findings are open is
rejected rather than persisted. There is no numeric score anywhere.

`record` also refuses findings whose `file` is not in the capsule's changed-file
list. A reviewer may report a cross-file problem, but it must anchor the claim
to a changed file and put the other paths in `evidence_refs`.

## Invalidation

Every path that changes what was reviewed produces a different artifact:

| Event | Effect |
| --- | --- |
| New commit / new head | new capsule required; old receipt has another `head_sha` |
| Force-push to the same absent head | same as above |
| Base branch moved | `baseSha` is hashed, so the recomputed fingerprint changes |
| Skill edited | `skill_sha256` mismatch |
| Finding fixed | only a fresh reviewer pass on the new head can say so |

`record` freezes `headRefOid` from GitHub at write time, requires it to equal the
submitted `head_sha`, re-hashes the capsule's `diff.patch` and `files.txt` so the
reviewed bytes are the frozen bytes, and requires the working tree to be clean at
that commit. So the receipt cannot be written from a stale checkout or a mutated
tree.

Exactly one receipt is allowed per head. A second review of the same commit is
refused rather than overwriting the first, so an implementer cannot shop for a
cleaner second opinion without changing the head.

The reviewer never marks its own findings resolved after the fact. Fixing a
finding is a commit, a new head, a new capsule and a new reviewer; the previous
receipt stays on disk as history and simply stops matching the head.

## Reviewer recycling

The receipt is the handoff. Once `record` prints the receipt path, the reviewer
context can be discarded; nothing later reads its transcript. A crash loses at
most one unfinished review and cannot lose a recorded one.

## Merge gate

`pnpm merge:pr` gains these blockers, reported together with the verification
blockers:

- no review receipt for the exact head;
- receipt `role` is not `reviewer`;
- skill id, version or hash differs from the bundled skill;
- `verdict` is not `clean`, or `blocking_open_count > 0`;
- `reviewed_fingerprint` differs from the recomputed `gh pr diff` fingerprint;
- receipt `pr_number` or `base_sha` differs from the current PR.

The exact-head merge itself is unchanged: `gh pr merge --match-head-commit`
still fences GitHub, so a branch that moves between review and merge is
rejected remotely even if a stale receipt was written.

## Limits

- A receipt is a file. Anyone with write access to the checkout can forge one,
  just as they can forge a verification receipt. The gate proves the workflow
  ran, not that a human was honest.
- The reviewer is instructed read-only and starts from an empty context. That is
  a role contract, not an OS sandbox. `record` proves the tree was clean at the
  head afterwards, which catches accidental edits, not a determined actor.
- `gh pr merge` without the wrapper still bypasses both receipts.
- The capsule carries the PR body verbatim. A hostile PR body is reviewer input;
  the skill instructs the reviewer to treat it as a claim to verify, not as
  instructions.
- No GitHub review is posted. The runtime's `clean_llm_review` evidence and this
  receipt stay separate evidence sources; wiring one to the other is future
  work, not a hidden coupling.

## Non-goals

- No scoring, ranking, or "quality percentage" of a PR.
- No automated patching by the reviewer.
- No multi-reviewer quorum; one fresh reviewer per generation is the contract.
- No durable database. Receipts are append-only JSON under `.unified-mpc/`.
- No change to `merge_verification_run`; the runtime path keeps its own review
  evidence contract.
