# Approved Git Push Path

`git push` is denied by Unified whenever local Git configuration could execute a
non-Git program or expose credentials. That denial is correct and stays: a
repository-local `remote.origin.receivepack`, `credential.helper`, `core.sshCommand`
or `GIT_SSH_COMMAND` must never be able to run because a model asked to publish.

This document defines the supported alternative for issue #297: a host-mediated
publish path that a leased Goal can use after explicit human authorization, with
credentials that never reach the model, the transcript, or a log.

Status: **preflight and receipt store implemented, publish not implemented.**
`git_publish_preflight` (read-only) ships the diagnostics half described in section
6, and migration `042_publish_approvals` ships the durable approval ledger described
in section 5. Nothing writes or consumes an approval yet, and nothing in this
repository can publish; `git push` remains denied for every caller.

---

## 1. Why the current denial is not a bug

```text
git tool  ->  GitService.run  ->  validatePushSafety  ->  denied
                                    |                    reason: push-credential-helper
                                    |                            push-config-override
                                    |                            push-environment-override
                                    v
                              adapter.run never called
```

`validatePushSafety` (`packages/git/src/git-adapter.ts`) refuses before any
transport is constructed, and every refusal now carries `details.reason` plus the
blocking `details.key`/`details.keys` — key names only, never values. The guard is
about *who executes the helper*, not about whether the user is allowed to publish.

That guard is transport-scoped, because Git consults `credential.helper` only for
HTTP(S) remotes:

| resolved push target | helper can run | credential-helper denial |
|---|---|---|
| `https://` / `http://` | yes | reported |
| `ssh://`, scp-like `user@host:path` | no | not reported |
| `git://`, `file://`, local path | no | not reported |
| unresolvable, unsupported, `ext::`, unclassified | unknown | reported (fail closed) |

So a host-wide `credential.helper` configured for `https://github.com` no longer
denies an SSH publish that cannot use it. Nothing is relaxed for HTTP(S): the
denial, the key redaction, and the rest of the executable-config checks are
unchanged there, and the approved path in this document is still the only way to
publish over an authenticated HTTP(S) transport.

Two facts make a model-driven `git push` unsupportable even with approval:

1. The helper runs in the same process tree as the model's command. Approval does
   not change what that helper can read or write.
2. `userConfirmed: true` is asserted by the caller (`GitService.run`), so it can
   never be the authority for a remote write.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Add a dedicated `git_publish` tool. Do not relax `git push`. | The guarded path gets its own approval class, schema and audit row. `git push` keeps failing closed for every caller, including Full Bypass. |
| D2 | The host builds and executes the Git invocation, not the caller. | The caller supplies `workspaceId`, `remote`, `branch` and an expected commit SHA — never argv, config, or environment. |
| D3 | Authority is a durable approval receipt, not a boolean. | Mirrors the `guarded_pr_merge` evidence chain: the caller cannot supply the verdict. |
| D4 | One remote, one branch, one exact SHA per approval. | No force, tags, deletes, `--all`, `--mirror`, or default/protected branches. A moved head invalidates the receipt. |
| D5 | Credentials are injected by the host into the child process only. | Secrets stay out of argv, the model context, tool results, and logs. |
| D6 | `permission_check` stays policy-only; runtime readiness is reported separately. | It is a compatibility shim (`upgrade-catalog.ts`), not a place to grow Git probing. |
| D7 | No fallback. A failed publish never degrades to `shell`, `gh`, or a disabled helper. | The workaround in #297 (human publishes from their own terminal) stays the only manual escape. |

## 3. Flow

```text
model                host (ToolRegistry + GitService)          approval store      git child
  |                              |                                   |                |
  | git_publish{ws,remote,       |                                   |                |
  |   branch,expectedSha}  ----->|                                   |                |
  |                              | 1 goal lease + workspace admission|                |
  |                              | 2 resolve refs, verify SHA        |                |
  |                              | 3 scope check (branch pattern,    |                |
  |                              |   not default, no force)          |                |
  |                              | 4 consume approval receipt ------>|                |
  |                              |   (ws,remote,branch,sha,expiry)   |                |
  |                              | 5 spawn git with sanitized env ------------------->|
  |                              |   credential helper from host     |                |
  |                              | 6 verify remote ref == expectedSha<----------------|
  |                              | 7 write audit receipt             |                |
  |<---- {published, sha, url} --|                                   |                |
```

Steps 1–4 fail closed. A missing, expired, or mismatched receipt returns
`PERMISSION_REQUIRED` with `details.reason: "publish-approval-required"`; it never
prompts from inside the adapter.

## 4. Credential handling

- The child environment is constructed from an allowlist. Ambient `GIT_SSH_COMMAND`,
  `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH` and
  `GIT_CONFIG_*` are dropped, not inherited.
- HTTPS credentials come from the host's authenticated `gh` CLI (already required by
  `guarded_pr_merge`) or the OS keyring. The token is passed to the child through a
  host-owned helper defined with `-c`, so it never appears in argv.
- SSH, if enabled at all, uses a host-owned key path resolved by the host, never
  `core.sshCommand` from repository config.
- No credential, token, URL userinfo, or helper path is written to the tool result,
  the activity log, the audit row, or any error message. `diagnosticConfigKey()`
  reduces free-form config subsections to a pattern, and `firstCredentialConfigKey()`
  reduces every scoped credential helper — host-only or full URL — to
  `credential.<url>.helper` while reporting the global `credential.helper` exactly.
  The publish path applies the same rule to everything it reports.
- On authentication failure the result is `PERMISSION_DENIED` with
  `details.reason: "publish-authentication-failed"`. The raw `git` stderr is
  redacted with `redactDiagnosticText()` before it is logged, and is not returned.

## 5. Approval receipt

```text
publish_approvals(
  workspace_id, remote, branch, expected_sha,
  approved_by, approved_at, expires_at, consumed_at
)
```

- Written only by the host approval surface (Desktop/STDIO broker), never by a tool call.
- Bound to the exact `expected_sha`; a new commit requires a new receipt.
- Single use: `consumed_at` is set inside the same transaction that authorizes the spawn.
- Short expiry (default 15 minutes) so a stale approval cannot publish unrelated work later.

Implemented in migration `042_publish_approvals` and
`SqlitePublishApprovalRepository` (`packages/storage`). Recording is idempotent per
exact binding and cannot widen a row that already exists; `consumePublishApproval`
spends a receipt exactly once on the caller's open transaction, so authorization and
consumption roll back together. The table rejects a non-hex or short SHA, an empty or
option-shaped branch, and `expires_at <= approved_at` at the schema level, and a
receipt may only reference a registered workspace. No tool or host surface writes or
spends a receipt outside the repository tests. `git_publish_preflight` reads the
ledger and reports `approval` as `missing`, `pending`, `expired`, or `consumed` for
the exact workspace, remote, branch and head; with no host surface writing receipts
it still reports `missing` in production.

## 6. Preflight

`git_publish` with `dryRun: true` answers "would this succeed, and if not, why"
without writing. That half is implemented as the read-only
`git_publish_preflight` tool. It returns the runtime verdict, approval state,
head, sanitized targets, default branches and `protectedBranch`:

```json
{
  "remote": "origin",
  "branch": "goal/publish",
  "head": "<sha>",
  "targets": ["https://github.com"],
  "defaultBranches": ["main"],
  "protectedBranch": false,
  "runtime": { "ready": false, "reason": "push-credential-helper", "key": "credential.<url>.helper" },
  "approval": "missing"
}
```

It does not return a `policy` field: reaching the tool already means policy allowed
the action, and the tool cannot publish anything. `approval` is read from
`publish_approvals` for the exact workspace, remote, branch and resolved head, so
`missing` means no receipt exists, `pending` means a live unconsumed receipt exists,
and `expired`/`consumed` mean a new approval is required. A lookup failure reports
`missing`, because a diagnostic must never claim an approval it could not read.
When the `ls-remote` lookup for default branches fails, `defaultBranches` is `[]`
and `protectedBranch` is not authoritative.

This is what requirement 3 of #297 asks for: a caller can tell a policy-level allow
from a runtime authentication/credential block *before* attempting to publish.

## 7. Tests that must exist before this ships

1. Unapproved publish is denied (`publish-approval-required`), and no Git child is spawned.
2. Approved publish of `origin` + `goal/*` + exact SHA succeeds against a local bare remote.
3. A receipt bound to a different SHA is rejected even when the branch name matches.
4. A protected/default branch is rejected regardless of approval.
5. `force`, `--all`, tags, deletes and `--mirror` are rejected at the schema level.
6. A credential helper configured in the repository does not run during publish.
7. Serialized results, logs and audit rows contain no token, helper path, or URL userinfo.
8. Authentication failure returns `publish-authentication-failed` and leaves the remote untouched.
9. Exact-head/tree verification and `guarded_pr_merge` still refuse a head that moved after publication.

## 8. Non-goals

- Relaxing `validatePushSafety` or adding an "ignore safety" flag to `git push`.
- Publishing from an unleased or unscheduled session.
- Automatic PR creation, CI triggering, or merge from this tool.
- Supporting arbitrary remotes, multiple push URLs, or non-GitHub forges in the first slice.
