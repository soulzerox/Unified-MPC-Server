# Guarded Pull-Request Merge

`guarded_pr_merge` is the only first-party path that merges a pull request. It
refuses to merge unless the host can prove, from durable local state, that the
exact current head was verified. The GitHub-side provider then repeats the head
check so a branch that moved after verification is rejected by GitHub itself.

The caller names the pull request it wants merged; it does not get to say what
that pull request is. Before any receipt is read, the runtime asks GitHub for the
current head, base branch and base commit and refuses when the caller's subject
disagrees. A receipt can only authorize the pull request the provider holds.

---

## 1. Evidence Chain

```text
merge_verification_run      clean registered workspace at the exact PR head
        |                   + required local gates and GitHub checks
        v
durable verification receipt (SQLite, keyed by repository + PR + head SHA)
        |
        v
guarded_pr_merge ────────── reads the PR again: current head, base branch
        |                   and base commit. A stale caller subject is
        |                   refused before the receipt is read.
        v
provider merge              exact expected head SHA sent with the request
        |
        v
GitHub                      rejects the merge if the head moved
```

The evidence evaluation lives inside `GuardedMergeService`; it is not a registry
approval that Trusted Full Bypass can skip. Missing, stale, rejected or
mismatched evidence keeps the result `blocked` before any provider call. A
subject that cannot be confirmed is a different answer: the result is
`inspect_required` with `subject_unavailable` or `subject_mismatch`, because the
caller has to re-read the pull request rather than collect more evidence.

An identical repeat request — same head, base, verification mode and review
evidence — returns the persisted receipt with its original `receiptRef` instead of
re-running the gates, provided the current policy still accepts it. Any difference
(a new review, a moved base, a stricter policy) forces a fresh run, so reuse never
inherits evidence the caller did not ask to verify.

---

## 2. Provider Paths

`guarded_merge_provider_server_v1` selects the merge executor.

| Value | Executor | Requirements |
|---|---|---|
| unset, blank, or `builtin` | Built-in GitHub merge API through the authenticated `gh` CLI | `gh` on `PATH`, authenticated with write access to the repository |
| a registered child MCP server name | That child server's `merge_pull_request` tool | The server must be registered, connected and expose `merge_pull_request` |

The built-in path is the default. It removes the former requirement for an
out-of-repo MCP shim: Unified-MPC itself performs the exact-head merge. The
`builtin` name is reserved and always selects this path; a child server cannot
shadow it.

### Built-in dispatch

The provider runs one bounded call:

```sh
gh api --method PUT \
  -H 'Accept: application/vnd.github+json' \
  repos/<owner>/<repo>/pulls/<number>/merge \
  -f merge_method=<policy mergeMethod> \
  -f sha=<verified-head-sha>
```

`GH_PROMPT_DISABLED=1` prevents an unauthenticated CLI from waiting for input.
The response body must contain `merged: true`; a 200 response with
`merged: false` is treated as a failed dispatch, never as success.

The method comes from the repository policy, `mergeMethod`. The built-in path
sends it as `merge_method=<method>` and the child dispatch sends the same value
as `merge_method`. Absent means `merge`, so an existing policy keeps the
behaviour it had before the field existed.

Only two methods are accepted, and that is the honest set:

| `mergeMethod` | What the observer proves |
| --- | --- |
| `merge` (default) | the merge commit has two parents: the base and the pull request head |
| `squash` | the merge commit has one parent (the base) and its subject ends with `(#<pull request>)` |

`rebase` is refused by the policy parser instead of accepted and then always
breaching: a rebased pull request leaves single-parent commits carrying their
original messages, so the observer could not separate it from a squash whose
message lost the trailer. A squash merge whose message was hand-edited to drop
`(#N)` also stays unproven — that is a fail-closed gap, not a silent pass.

The runtime therefore works on a squash-only branch such as this repository's
(§8): set `mergeMethod: "squash"` in `repository_merge_policies_v1` and the
dispatch, the `guarded_pr_merge` call and the reconciliation expectation all
follow the same value.

One owner, including on the way back in: `merge_reconcile` takes its expected
method from the same policy field. A request may restate that value, but a
declaration that disagrees is refused with `PERMISSION_DENIED` before any
observation or evidence write. Accepting it would let a caller record
`RECONCILED` for a merge the policy says is wrong, which makes the verdict
depend on who asked.

### Child MCP dispatch

Before calling a child provider, Unified-MPC describes the live server and
requires `merge_pull_request` to be present. The call carries the current
descriptor and catalog fingerprints, so a changed provider contract fails
closed instead of silently executing a different mutation.

There is **no automatic fallback** between paths. If the configured provider is
missing, drifted or fails, the service returns `inspect_required` with
`reason: merge_dispatch_error`; `guarded_pr_merge` surfaces that as a `CONFLICT`
error with sanitized detail and no credentials.

---

## 3. Failure Behavior

| Condition | Tool result |
|---|---|
| No authoritative merge policy for the repository | `PERMISSION_DENIED` |
| Pull request closed, merged, or unreadable | `CONFLICT` (`subject_unavailable`) |
| Caller subject no longer matches the pull request | `CONFLICT` (`subject_mismatch`) |
| Receipt missing, stale, rejected, or for another head | `PERMISSION_DENIED` (blocked by evidence) |
| Built-in CLI missing, unauthenticated, or network failure | `CONFLICT` (`merge_dispatch_error`) |
| GitHub refuses the merge (head moved, not mergeable, protected branch) | `CONFLICT` (`merge_dispatch_error`) |
| Child provider missing the tool or drifted | `CONFLICT` (`merge_dispatch_error`) |
| Merge accepted | success with `status: dispatched` and the exact subject |

A dispatch failure reports that the remote outcome may be unknown; callers must
inspect PR state instead of retrying blindly.

---

## 4. Why the Head SHA Travels Twice

The durable receipt proves what the host verified. The `sha` field on the merge
request proves what GitHub is merging. Both must match the same commit:

- If the receipt is for another head, `GuardedMergeService` blocks locally.
- If the branch moves after verification, GitHub rejects the stale `sha`.
- A concurrent push can therefore never inherit an older verification.

The same provider read is what makes the base branch check honest. The policy
names a default branch, and the evaluator compares the caller's `baseBranch`
against it — but a comparison against a caller's claim only proves the caller can
read the policy. A caller that names `main` for a pull request GitHub says targets
`release` is refused with `subject_mismatch` before the policy check can be
satisfied by the claim.

The base commit is settled the same way. `baseSha` is optional on a merge
subject and `evaluateMergeEvidence` only compares a base both sides carry, so an
omitted base used to skip the receipt's base check entirely. The service now
evaluates the receipt against the subject the provider confirmed — not the
object the caller sent — so a receipt written for another base is refused with
`receipt_base_stale` whether or not the caller named one. A pull request that was
retargeted and then re-verified gets a fresh receipt for the new base, because
the receipt reuse path matches on `baseSha` before it reuses anything.

The read is a snapshot, and the provider merge carries the expected head but no
base. A pull request retargeted between this read and the merge call is therefore
refused by the next call's preflight, not by this one: what this gate guarantees
is that the decision was made against the base GitHub reported at read time,
never against a claim.

---

## 5. Operational Notes

- The built-in provider stores no token. It reuses the host's `gh` credential
  helper exactly like the read-only GitHub observation and reconciliation paths.
- The legacy `~/.local/share/github-merge-provider/server.js` shim is no longer
  needed when the setting is unset or `builtin`. A host that still points the
  setting at a child server keeps working unchanged.
- `merge_reconcile` uses the same authenticated GitHub API reader to observe the
  merged result and persist reconciliation evidence.
- A merge made by `merge:pr` writes no runtime verification receipt, so the
  automatic reconciliation records it as
  `POLICY_BREACH / verification_receipt_missing`. That is the two stores not
  being connected yet, not a bad merge: the shell evidence is
  `.unified-mpc/local-verify/`, the runtime reads its own receipt store.
- Exact-head verification accepts a GitHub SSH host alias (for example
  `git@github.com-work:owner/repo.git`) only when `ssh -G <alias>` resolves the
  hostname to `github.com`. An alias that resolves elsewhere, an HTTPS remote on
  another host, or an SSH resolution failure fails closed as a repository
  mismatch instead of trusting the remote URL text.

### Canonical advancement after a merge

A policy may name the local checkout the runtime reads after it reconciles a
merge:

```json
{
  "repository": "owner/repo",
  "defaultBranch": "main",
  "verificationMode": "local_exact_head",
  "requiredGates": [{ "name": "test", "source": "local_command" }],
  "reviewPolicy": { "required": true, "acceptedOutcomes": ["clean_llm_review"] },
  "checkoutPath": "/srv/checkouts/repo"
}
```

`checkoutPath` is the only field this section adds; the other fields are
required by the policy parser, and an entry missing one invalidates the whole
policy list rather than only itself.

`checkoutPath` must be absolute. A relative value is refused by the parser
because it would resolve against whatever directory the daemon started in, so
the same policy could read two different repositories.

One canonical ref holds one repository: refs are keyed by Git ref path
(`refs/remotes/origin/main`) and carry no repository id, so the binding is per
ref. A second policy whose checkout is a different repository advancing the
*same* branch therefore refuses with `bound to <repository id>` instead of
replacing the first ref and unrooting its manifest from GC. A policy with a
different `defaultBranch` targets a different ref and is admitted — the guard
is per ref, not per store root. The advance repeats the check against the state
it actually reads, so a second repository that binds the ref while this checkout
is fetching is refused too, not just the one that was already bound.

The repository id is derived from the checkout's remote URL. GitHub's SSH,
`ssh://` and HTTPS spellings of one repository hash to one id, so a checkout
that changes spelling does not become a second trust boundary. A ref written by
the released `index revision advance` is bound to the pre-normalization
derivation for the same remote; the next advance adopts that id and re-binds the
ref to the normalized one instead of refusing the store forever. An SSH host
alias that resolves to github.com is not normalized, because resolving it needs
`ssh -G` side effects; such a checkout passes `--repository-id` explicitly.

When a merge reconciles as `reconciled` and the observation carries its merge
commit, the poller runs the advancement gate once for that repository:

1. refuse unless the checkout's `origin` resolves to a github.com repository
   equal to the policy's `repository` — a shared or mistyped `checkoutPath`
   must not fetch another repository's branch and bind the ref to it;
2. `git fetch` the exact branch into `refs/remotes/origin/<defaultBranch>`;
3. refuse unless the fetched ref contains the merge commit as an ancestor — a
   lagging clone must not move the canonical ref backwards;
4. run `advanceRevisionFromGit`, which classifies the delta against the active
   manifest, persists the new manifest, CAS-promotes the ref and registers
   artifacts. The advance is pinned to the commit step 3 approved: the gate
   resolves the ref again, so a fetch that lands in between refuses instead of
   promoting a commit nothing checked. The CAS compares the pre-hash state with
   the ref as it is on disk at promote time, so two pollers advancing the same
   branch cannot both win. That baseline read is strict: an existing ref file
   that cannot be parsed is reported as a refusal, never read as "never
   promoted" and overwritten by the first-ever branch.

The newest merge is chosen by `mergedAt`, not by feed order: a comment or label
moves a pull request later in the `updatedAt` feed without merging anything.

The outcome is reported in the poll summary as `canonicalAdvance`:

| Value | Meaning |
|---|---|
| `advanced` | the ref moved to the fetched branch head, which contains the merged commit; the report carries the manifest id |
| `noop` | the ref already pointed at an equivalent manifest |
| `refused` | reason included — including a policy with no `checkoutPath`; the merge still reconciled, nothing was advanced |
| `skipped / no_merge` | no merge reconciled in this pass |
| `skipped / not_wired` | the runtime has no canonical root |
| `skipped / inspect_required` | a merge needed inspection, so the pass advanced nothing |

A refused advance is never silent and never a failed reconciliation: the two
records are separate, so an operator can see that a merge landed while the
canonical ref did not follow it. The HTTP runtime logs one line per refusal
(`Unified-MPC canonical advance refused repository=… reason=…`) for every pass,
including scheduled ones. Without `checkoutPath` the gate stays operator-driven
through `unified-mpc index revision advance`; that path applies the same strict
baseline, so a corrupt ref refuses instead of being replaced.

Artifact registration is metadata over a ref that has already moved: a refused
registration is reported in `canonicalAdvance.artifacts` and logged
(`… registered no artifacts repository=… reason=…`), and never rewrites the
advance as a refusal — the ref did move, and saying otherwise would hide it.


---

## 6. Repository-Level Companion (`pnpm merge:pr`)

`guarded_pr_merge` is the MCP path for runtimes that own merge policy. A shell
session that merges from a checkout uses the repository companion instead:

```sh
corepack pnpm@10.15.0 verify:local          # writes a mergeReady receipt for HEAD
corepack pnpm@10.15.0 review:pr capsule --pr 534
corepack pnpm@10.15.0 review:pr record  --pr 534 --findings <file>
corepack pnpm@10.15.0 merge:pr --pr 534     # refuses unless both receipts match
```

`scripts/guarded-merge.mjs` applies the same two-head idea without a policy
store:

1. resolve the open PR and freeze `headRefOid`;
2. find a verification receipt for that exact SHA with `profile: "merge"`,
   `dirty: false`, `mergeReady: true`, a current `profileVersion`, and a
   `diffFingerprint` recomputed from the head. The head is immutable, so any
   receipt that satisfies all of this authorizes it: a later weaker run on the
   same commit (`verify:targeted`, or a run from a dirty tree) cannot revoke an
   earlier merge-ready receipt. When no receipt qualifies, the newest one is
   reported so its blockers explain the refusal;
3. find a review receipt for that exact SHA with `role: "reviewer"`, the
   current bundled skill hash, `verdict: "clean"`, no open blocking finding, and
   a `reviewedFingerprint` recomputed from `gh pr diff`;
4. refuse on a draft, wrong base, non-`CLEAN` merge state, or a PR body that
   retracts a closing keyword;
5. merge with `gh pr merge --match-head-commit <sha>`, so a branch that moved
   after verification is rejected by GitHub;
6. record `{ headSha, prNumber, verificationId, reviewId, mergeCommit,
   mergedAt }` under `.unified-mpc/local-verify/merges/`.

`--dry-run` performs every check in steps 1-4 and reports all blockers without merging. The
receipts are the single source of truth for this path: it never merges a head
that was not verified and reviewed on this host. A bare `gh pr merge` bypasses
it, so the guard is only as strong as the workflow that uses it.

---

## 7. Exact-Head Review Gate (`pnpm review:pr`)

`scripts/review-gate.mjs` implements the review half of #144. It never reviews
anything itself: it freezes the reviewer's input, validates the reviewer's
findings, and turns a clean generation into a receipt the merge guard accepts.

```text
verify:local       merge-ready receipt for the exact head
        |
        v
capsule --pr N     freeze head/base/diff + skill + verification into
                   .unified-mpc/reviews/capsules/<head12>-<N>/
        |
        v
fresh reviewer     separate context, read-only, capsule + repo at that head
        |
        v
record --findings  validate identity, skill hash, file anchors, severities,
                   recompute the verdict, write
                   .unified-mpc/reviews/receipts/<head12>-<N>.json
```

`capsule` refuses a head with no merge-ready verification receipt, and reports
every reason the receipt it found cannot gate a review (another head, not
merge-ready, produced from a dirty tree, wrong profile, an older profile version,
or a fingerprint from another tree). The merge guard requires that receipt
anyway, so a review that runs first spends a reviewer on a head that cannot land.
`record` applies the same predicate, because a capsule frozen before this check
existed is still on disk and still recordable, and `status` reports the same
blockers, so no two commands give different answers. Selection prefers the newest
receipt that satisfies the whole predicate over a newer weaker one on the same
commit, for the same immutable-head reason as the merge guard.

The receipt name is one per head and `record` creates it with a hard link, so
two concurrent recorders cannot both write: the filesystem refuses the second
create and that recorder gets the uniqueness refusal instead of a second receipt.

### Status

`status` answers what the guard would decide right now for one pull request,
without writing anything:

```sh
$ corepack pnpm@10.15.0 review:pr status --pr 534
review-gate owner/repo#534 head 1a2b3c4d5e6f base 7f8e9d0c1b2a
  capsule: 5d2e1f0a-9b8c-4d3e-8f7a-6b5c4d3e2f10
  skill: unified-code-review v1 sha256:e48ff9b24971a…
  verification: 8f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f mergeReady=true
  receipt: 9c8b7a65-4d3e-2f1a-0b9c-8d7e6f5a4b3c verdict=clean blockingOpen=0
review-ready: yes
```

It prints `capsule: missing` when the head was never frozen, lists every blocker
that keeps the verdict at `no`, and exits `1` in that case. It evaluates the same
skill identity, diff fingerprint and review receipt the merge guard evaluates, so
`review-ready: yes` is the gate's own verdict rather than a summary of the files
on disk. The capsule line only reports which frozen capsule exists for that head;
the merge guard itself never reads it. When a capsule is frozen but no receipt
exists, the blocker names `record` instead of `capsule`, because a second freeze
for the same head is refused.

### Capsule

`capsule.json` holds the full head SHA, base SHA, PR title/body, issue refs,
changed files, `diffFingerprint` (over `gh pr diff`), the merge-ready
verification receipt for that head, and the bundled skill identity. `capsule.md`
is the reviewer's instruction sheet; `diff.patch` is the exact diff and
`files.txt` the changed paths. Nothing from the implementer's session is
included: a reviewer that sees the implementer's reasoning is not independent.

### Findings

A finding is `severity`, `category`, `file`, `line`, `claim`, `evidence_refs`,
`required_fix`, `status`. Categories and severities are closed sets, the file
must be in the PR's changed files, and `line` may be `null` for a whole-file
finding. `fixed` and `invalidated` are refused at record time: only a later
review generation can supersede an earlier one, so an implementer cannot mark
its own findings resolved.

`verdict` is recomputed from the findings, never trusted from the file. A
finding blocks while `status === "open"` and `required_fix === true`.

### Invalidation

| Change | Effect |
| --- | --- |
| New commit / force-push | different `headSha`; old receipt stops matching |
| Base branch moved | `baseSha` is part of the fingerprint, so the receipt stops matching |
| `SKILL.md` edited | `skillSha256` mismatch |
| Tree dirty or HEAD moved at freeze/record time | refused |
| Second receipt for the same head | refused; review evidence is unique per head |
| New capsule for a head that already has a receipt | refused with `a new capsule needs a new head`; the capsule is what that receipt stands on, so replacing it would orphan the reviewed evidence |
| New capsule for a head whose capsule exists but has no receipt | refused; the frozen capsule is the reviewer's input, and overwriting it would make their findings unrecordable |

A fix therefore starts a new review generation. The previous receipt stays on
disk as history; it is never edited.

### Backlog

Receipts accumulate, so `review:pr backlog` answers the only question history
raises: does any of it still block something?

```bash
$ corepack pnpm@10.15.0 review:pr backlog
review backlog — owner/repo
  receipts 174 (corrupt 0)
  open findings 184, blocking open 4
  blocking now 0 · superseded head 0 · merged/closed 4 · unknown PR 0
nothing blocks an open PR right now
```

It reads every receipt, resolves PR state and current head in one `gh pr list`,
and applies the same predicate as the merge guard (`status === "open"` and
`required_fix === true`). A finding counts as **blocking now** only when its
receipt's head is still the PR's head; a newer head makes it **superseded** and a
merged or closed PR makes it **history**. The exit code is `1` when a finding
blocks now, a receipt is unreadable, or a receipt with a blocking finding names a
PR the listing did not return — the merge guard's fail-closed posture, so a
routine cannot pass on evidence this run could not read. `--json` prints the same
summary with every row.

The receipts directory is held to the same rule: a directory that does not exist
yet is an empty backlog, but one this run cannot read exits `1` instead of
printing `receipts 0` and "nothing blocks". An unreadable receipt is counted as
`corrupt` rather than skipped, and a receipt written before receipts recorded
`repository` still counts instead of vanishing.

### Retention

Both stores are audit evidence, and neither `verify:local` nor `review:pr` ever
collects them: a long-lived checkout grows by roughly a megabyte per verification
run plus a capsule per review, forever. `pnpm evidence:prune` is the opt-in
cleanup.

```sh
GIT_HEAD_SHA=$(git rev-parse HEAD) corepack pnpm@10.15.0 evidence:prune            # dry run
GIT_HEAD_SHA=$(git rev-parse HEAD) corepack pnpm@10.15.0 evidence:prune --apply    # delete
```

It is a dry run unless `--apply` is passed, and it requires `GIT_HEAD_SHA`
because keeping the current head's evidence is the whole point.

Kept, in both stores:

- the current HEAD and every head still named by a branch, tag or worktree tip —
  that is what protects an unmerged but already verified pull request, whose
  receipt is the one `merge:pr` will look up;
- every receipt and review a merge record spent;
- the receipt `latest.json` names;
- the newest `--keep` runs of each kind (default 5);
- any head passed with `--protect <sha>`.

Removed: every other verification receipt with its log directory, every other
capsule with its receipt, and log directories that no receipt references at all.
A verification that was killed leaves one of those, and it is collected only when
it carries no fresh `active.json` heartbeat (`local-verify` refreshes that file
every 15 seconds and records its pid, and that pid is gone), is older than every
run the plan keeps, and no merge record or `latest.json` names it.

Both stores are planned before either one is touched, so a refusal leaves both
intact. `latest.json` and `merges/` are never deleted, a deletion root that is
replaced, created or removed between planning and deleting is refused, the
evidence roots and their `merges/`, `logs/`, `capsules/` and `receipts/`
subdirectories must be real directories, and deletion never follows a symlink. It
refuses rather than guessing when a branch ref, merge record, receipt, capsule or
latest pointer cannot be read.

### What this does not prove

The reviewer is a role contract, not an OS sandbox, and a receipt is a file that
someone with checkout access could forge — exactly like a verification receipt.
`record` proves the tree was clean at the reviewed head afterwards, which
catches accidental edits, not a determined actor. No GitHub review is posted;
the runtime's `clean_llm_review` evidence remains a separate source.


---

## 8. Repository Ruleset

`main` carries the active `main-exact-head-merge` ruleset (id `26172448`):

| Rule | Effect |
| --- | --- |
| `pull_request` | a direct push to `main` is rejected; every change lands through a PR |
| `allowed_merge_methods: ["squash"]` | only squash merges, matching `merge:pr` |
| `non_fast_forward` | a force-push to `main` is rejected |
| `deletion` | `main` cannot be deleted |
| `required_approving_review_count: 0` | GitHub does not demand a human approval |
| no bypass actors | the rules apply to admins too |

No GitHub status check is required, because no verification runs on GitHub. The
ruleset is the outer ring (a PR must exist, the branch cannot be rewritten) and
the receipts from §6 and §7 are the inner one (which exact head was verified and
reviewed).

Zero required GitHub approvals is deliberate. The review evidence for this
repository is the dedicated reviewer receipt from §7, bound to the head and the
bundled skill hash. Asking for a GitHub approval on top would add a second,
weaker signal that a push can still invalidate, and would put a human in every
loop. The ruleset still makes the PR mandatory, which is what #144 asked for.

The ruleset does not replace the local guard: a PR can merge with a stale head
if someone bypasses `merge:pr`, and the ruleset cannot see the receipts. Use
`merge:pr`.

Only the squash method works. `merge:pr` defaults to `--squash`; passing
`--method merge` or `--method rebase` produces a PR GitHub refuses to merge
into `main`, and `gh pr merge` reports that as an error rather than as success.
The runtime follows the policy instead of a constant (§2), so this repository's
`repository_merge_policies_v1` entry carries `"mergeMethod": "squash"`; the
built-in dispatch, the child dispatch and the reconciliation then all expect
the method the ruleset allows.
