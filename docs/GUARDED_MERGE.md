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
