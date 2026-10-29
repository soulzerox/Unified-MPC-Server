# Guarded Pull-Request Merge

`guarded_pr_merge` is the only first-party path that merges a pull request. It
refuses to merge unless the host can prove, from durable local state, that the
exact current head was verified. The GitHub-side provider then repeats the head
check so a branch that moved after verification is rejected by GitHub itself.

---

## 1. Evidence Chain

```text
merge_verification_run      clean registered workspace at the exact PR head
        |                   + required local gates and GitHub checks
        v
durable verification receipt (SQLite, keyed by repository + PR + head SHA)
        |
        v
guarded_pr_merge            host-owned merge policy + receipt evidence
        |                   caller cannot supply policy, gates or verdict
        v
provider merge              exact expected head SHA sent with the request
        |
        v
GitHub                      rejects the merge if the head moved
```

The evidence evaluation lives inside `GuardedMergeService`; it is not a registry
approval that Trusted Full Bypass can skip. Missing, stale, rejected or
mismatched evidence keeps the result `blocked` before any provider call.

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
  -f merge_method=merge \
  -f sha=<verified-head-sha>
```

`GH_PROMPT_DISABLED=1` prevents an unauthenticated CLI from waiting for input.
The response body must contain `merged: true`; a 200 response with
`merged: false` is treated as a failed dispatch, never as success.

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

---

## 5. Operational Notes

- The built-in provider stores no token. It reuses the host's `gh` credential
  helper exactly like the read-only GitHub observation and reconciliation paths.
- The legacy `~/.local/share/github-merge-provider/server.js` shim is no longer
  needed when the setting is unset or `builtin`. A host that still points the
  setting at a child server keeps working unchanged.
- `merge_reconcile` uses the same authenticated GitHub API reader to observe the
  merged result and persist reconciliation evidence.
- Exact-head verification accepts a GitHub SSH host alias (for example
  `git@github.com-work:owner/repo.git`) only when `ssh -G <alias>` resolves the
  hostname to `github.com`. An alias that resolves elsewhere, an HTTPS remote on
  another host, or an SSH resolution failure fails closed as a repository
  mismatch instead of trusting the remote URL text.

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
   `dirty: false`, `mergeReady: true`, and a `diffFingerprint` recomputed from
   the head;
3. find a review receipt for that exact SHA with `role: "reviewer"`, the
   current bundled skill hash, `verdict: "clean"`, no open blocking finding, and
   a `reviewedFingerprint` recomputed from `gh pr diff`;
4. refuse on a draft, wrong base, non-`CLEAN` merge state, or a PR body that
   retracts a closing keyword;
5. merge with `gh pr merge --match-head-commit <sha>`, so a branch that moved
   after verification is rejected by GitHub;
6. record `{ headSha, prNumber, verificationId, reviewId, mergeCommit,
   mergedAt }` under `.unified-mpc/local-verify/merges/`.

`--dry-run` performs steps 1-3 and reports every blocker without merging. The
receipts are the single source of truth for this path: it never merges a head
that was not verified and reviewed on this host. A bare `gh pr merge` bypasses
it, so the guard is only as strong as the workflow that uses it.

---

## 7. Exact-Head Review Gate (`pnpm review:pr`)

`scripts/review-gate.mjs` implements the review half of #144. It never reviews
anything itself: it freezes the reviewer's input, validates the reviewer's
findings, and turns a clean generation into a receipt the merge guard accepts.

```text
capsule --pr N     freeze head/base/diff + skill + verification into
                   .unified-mpc/reviews/capsules/<head12>-<N>/
        |
        v
fresh reviewer     separate context, read-only, capsule + repo at that head
        |
        v
record --findings  validate identity, skill hash, file anchors, severities,
                   recompute the verdict, write
                   .unified-mpc/reviews/receipts/<head12>-<N>-<reviewId>.json
```

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
| Base branch moved | different `gh pr diff`, so the fingerprint changes |
| `SKILL.md` edited | `skillSha256` mismatch |
| Tree dirty at record time | refused |

A fix therefore starts a new review generation. The previous receipt stays on
disk as history; it is never edited.

### What this does not prove

The reviewer is a role contract, not an OS sandbox, and a receipt is a file that
someone with checkout access could forge — exactly like a verification receipt.
`record` proves the tree was clean at the reviewed head afterwards, which
catches accidental edits, not a determined actor. No GitHub review is posted;
the runtime's `clean_llm_review` evidence remains a separate source.

