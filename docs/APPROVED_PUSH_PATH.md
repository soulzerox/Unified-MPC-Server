# Approved Git Push Path

`git push` is denied by Unified whenever local Git configuration could execute a
non-Git program or expose credentials. That denial is correct and stays: a
repository-local `remote.origin.receivepack`, `credential.helper`, `core.sshCommand`
or `GIT_SSH_COMMAND` must never be able to run because a model asked to publish.

This document defines the supported alternative for issue #297: a host-mediated
publish path that a Goal session can use after explicit human authorization, with
credentials that never reach the model, the transcript, or a log.

Status: **S1 implemented.** `git_publish_preflight` (read-only) ships the diagnostics
half described in section 6, migration `042_publish_approvals` ships the durable
approval ledger described in section 5, and the two-tool pair `publish_approve` +
`git_publish` ships the publish half. `publish_approve` mints one single-use receipt
for an exact workspace/remote/branch/SHA binding after `userConfirmed: true`, and
`git_publish` spends it to push that exact commit to that exact branch through
host-built argv. The credential-mediation slice (item 1 of the requested behavior)
is designed, and its first two slices are implemented: S2a (the lease port, the
SecretStore-backed ledger, the operator CLI and the expiry sweep) and S2b (the
credential helper emitted into a promoted release). Nothing installs that helper
on a Git invocation yet, so no HTTP(S) target gains a credential path in this
state: see [APPROVED_PUSH_PATH_CREDENTIALS.md](APPROVED_PUSH_PATH_CREDENTIALS.md).

Trust model B: `userConfirmed: true` is the calling model's assertion of an explicit
chat approval, not an independently verified human verdict. Every built-in profile
except Full Bypass also requires a host exact-action dialog that shows the exact
binding, and Full Bypass skips that dialog by design; the receipt then bounds exactly
what can be published (one remote, one branch, one commit, one spend, 15 minutes) but
does not add human authority on its own.

SSH, `git://`, `file://` and local paths publish without any host-supplied credential;
they are not denied by an unrelated helper because no helper can run on them (see §1).
`git push` stays denied for every HTTP(S) target that could run a credential helper,
including under Full Bypass, and this tool does not relax it.

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
| unresolvable or unsupported (`ftp`, `ext::`, unknown scheme) | unknown | reported (fail closed) |

So a host-wide `credential.helper` configured for `https://github.com` no longer
denies an SSH publish that cannot use it. Nothing is relaxed for HTTP(S): the
denial, the key redaction, and the rest of the executable-config checks are
unchanged there, and the approved path in this document is still the only way to
publish over an authenticated HTTP(S) transport.

Every argument is first resolved as a remote name through
`git remote get-url --push --all`, because Git's own remote-name grammar is
broader than the adapter's (`foo+bar` and `foo@bar` are valid names). Only an
argument Git does not resolve is treated as a positional target (`git push
file:///tmp/bare.git main`, `git push /tmp/bare.git main`), and then the target
itself is classified by the table above. An argument with no scheme and no path
separator is treated as a name, so it stays reported when it does not resolve:
that covers a bare name, a slashless local path such as `sibling.git`, and a
slashless scp-like target such as `git@host:repo.git`. Those pushes are denied
on the conservative side rather than guessed from the literal.

Two rewrites can change the transport before the table applies. `url.<base>.insteadOf`
rewrites a command-line target as well as a configured remote, so a `file://`
target that matches a rewrite can become an HTTP(S) push that runs the helper;
any matching `url.<base>.insteadOf` or `url.<base>.pushInsteadOf` prefix is
therefore reported (fail closed) instead of being trusted as the literal. An
empty prefix is legal in Git and matches every target, so it is reported too.
`git remote get-url` already returns the rewritten URL for a remote name.

This is a guard-level contract. The `git` tool still refuses a positional target
before it spawns: `resolveDefaultBranches` looks the argument up as a remote name
and denies with `Repository default branch could not be resolved safely` when it
does not resolve. So the change makes `push-credential-helper` stop
mis-describing a local push, it does not make `git push /tmp/bare.git main` an
accepted `git` tool form.

Two facts make a model-driven `git push` unsupportable even with approval:

1. The helper runs in the same process tree as the model's command. Approval does
   not change what that helper can read or write.
2. A bare `userConfirmed: true` inside `git push` is asserted by the caller, so it can
   never be the authority for a remote write. That is why the approval is a separate
   receipt-minting call: `publish_approve` turns one confirmed binding into a durable
   row, and `git_publish` can only spend that row, never mint one. The receipt still
   rests on the caller's assertion; what it adds is exact binding, single use and a
   short expiry, plus a host exact-action dialog wherever the active profile requires
   one.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Add a dedicated `git_publish` tool. Do not relax `git push`. | The guarded path gets its own approval class, schema and audit row. `git push` keeps failing closed for every transport that can run a credential helper (HTTP/S), including under Full Bypass; the transport scoping in §1 only stops an unrelated helper from denying a transport that never runs one. |
| D2 | The host builds and executes the Git invocation, not the caller. | The caller supplies `workspaceId`, `remote`, `branch` and an expected commit SHA — never argv, config, or environment. |
| D3 | Authority is a durable approval receipt, not a boolean. | Mirrors the `guarded_pr_merge` evidence chain: the caller cannot supply the verdict. |
| D4 | One remote, one branch, one exact SHA per approval. | No force, tags, deletes, `--all`, `--mirror`, or default/protected branches. A moved head invalidates the receipt. |
| D5 | Credentials, when a later slice supports them, are injected by the host into the child process only. S1 injects none because it publishes only credential-free transports. | Secrets stay out of argv, the model context, tool results, and logs. |
| D6 | `permission_check` stays policy-only; runtime readiness is reported separately. | It is a compatibility shim (`upgrade-catalog.ts`), not a place to grow Git probing. |
| D7 | No fallback. A failed publish never degrades to `shell`, `gh`, or a disabled helper. | The workaround in #297 (human publishes from their own terminal) stays the only manual escape. |

## 3. Flow

Two tool calls, in this order. `publish_approve` is the confirmation gate and mints the
receipt; `git_publish` spends it. Neither call can do the other's job, and a receipt
minted for one binding is useless for any other. Where the active profile requires host
exact-action approval, both calls show the remote, branch and commit in that dialog.

```text
model                    host (ToolRegistry + GitService)                git child
  |                                    |                                     |
  | git_publish{ws, remote, branch,    |                                     |
  |   expectedSha, approvalId} ------->|                                     |
  |                                    | 1 resolve workspace + cwd            |
  |                                    | 2 preflight, verify head == SHA      |
  |                                    | 3 spend receipt (approval store)     |
  |                                    | 4 re-run push safety                 |
  |                                    | 5 git push <sha>:refs/heads/<branch> ->|
  |                                    | 6 verify remote ref == SHA <-----------|
  |<---- {sha, remote, branch, targets}|                                     |
```

Steps 1–4 fail closed. A missing, expired, mismatched or already-consumed receipt
returns `PERMISSION_REQUIRED` with `details.reason: "publish-approval-required"`; it
never prompts from inside the adapter. Spending happens before the spawn, so a race
after the spend loses the receipt and refuses rather than pushing twice. Both tools sit
behind the scheduled-continuation goal-lease fence at the tool boundary, so a live
rolling-goal fence requires the current `goalLease` before a receipt can be minted or
spent. An in-path lease check, credential injection and a separate audit row are later
slices, not S1.

## 4. Credential handling

S1 injected no credentials at all. S2c now injects one host-owned credential,
and only for a receipt-bound HTTP(S) lease: the publish path opens the lease the
human approved, installs the promoted helper for exactly one spawn, and revokes
the lease in a `finally` after the push and its verification. A credential-free
target (SSH, `git://`, `file://`, local path) still publishes without any
host-supplied secret. HTTP(S) is not rejected outright by name; it is denied
when a configured credential helper could run for a resolved target and no
bound lease authorizes it, and with no helper configured the push runs
credential-free and normally fails.

- The Git child runs with `GIT_TERMINAL_PROMPT=0`, so it can never stop for an
  interactive prompt.
- `validatePushSafety` runs immediately before the spawn and refuses when an ambient
  executable transport or credential override is present: `GIT_SSH`, `GIT_SSH_COMMAND`,
  `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH`, repository
  `receivepack`/`uploadpack`/`proxy`/`vcs`, `core.sshCommand`, `core.askPass`,
  `core.gitProxy`, `push.gpgSign`, `push.recurseSubmodules`, `submodule.recurse`,
  `protocol.*.allow`, and a credential helper when a resolved push target could use one.
  The denial carries `details.reason` plus the blocking key name, never a value.
- The push argv also carries `--no-follow-tags`, because `push.followTags=true` is a
  ref-selection setting rather than an executable one: without the flag, Git would push
  every annotated tag reachable from the approved commit, so the receipt would bound one
  branch while the remote also gained tags. The flag is host-built and not settable from
  a tool argument.
- HTTPS credentials are host-owned as of S2c. S2a added the credential lease and
  its operator CLI, and S2b ships the helper artifact inside a promoted release
  (see APPROVED_PUSH_PATH_CREDENTIALS.md). S2c installs that helper for one
  spawn when a live lease is bound to the approval: `publish_approve` records
  the resolved push-host fingerprint and the lease id, `git_publish` re-resolves
  the push URLs (`publish-target-changed` on a mismatch), spends the receipt,
  and revokes the lease after the push and its verification. Without a bound
  lease an HTTP(S) target that could reach a configured helper stays denied.
- No credential, token, URL userinfo, or helper path is written to the tool result,
  the activity log, the audit row, or any error message. `diagnosticConfigKey()`
  reduces free-form config subsections to a pattern, and `firstCredentialConfigKey()`
  reduces every scoped credential helper — host-only or full URL — to
  `credential.<url>.helper` while reporting the global `credential.helper` exactly.
  The publish path applies the same rule to everything it reports, and it returns no
  raw `git` stderr.
- On authentication failure the result is `PERMISSION_DENIED` with
  `details.reason: "publish-authentication-failed"`. The raw `git` stderr is redacted
  with `redactDiagnosticText()` before it is logged, and is not returned.

## 5. Approval receipt

```text
publish_approvals(
  workspace_id, remote, branch, expected_sha,
  approved_by, approved_at, expires_at, consumed_at
)
```

- Minted by `publish_approve` and only when that call carries `userConfirmed: true`.
  The handler requires the flag even under Full Bypass; it records the caller's
  assertion of the chat approval, not a host-verified human verdict.
- Bound to the exact `expected_sha`; a new commit requires a new receipt.
- Single use: `consumed_at` is committed before `git_publish` spawns the child, so a
  failed push cannot be retried with the same receipt.
- Short expiry (default 15 minutes, 30–900 s allowed) so a stale approval cannot
  publish unrelated work later.

Implemented in migration `042_publish_approvals` and
`SqlitePublishApprovalRepository` (`packages/storage`). Recording is idempotent per
exact binding and cannot widen a row that already exists; `consumePublishApproval`
spends a receipt exactly once. The standalone spend commits before the publish
spawns Git, so a failed push leaves the receipt consumed and a new approval is
required — fail-closed, never replayable.
The table rejects a non-hex or short SHA, an empty or option-shaped branch, and
`expires_at <= approved_at` at the schema level, and a receipt may only reference a
registered workspace. Only `publish_approve` writes a receipt and only `git_publish`
spends one; both go through the same repository the preflight reads.
`git_publish_preflight` reports `approval` as `missing`, `pending`, `expired`, or
`consumed` for the exact workspace, remote, branch and head.

## 6. Preflight

`git_publish_preflight` answers "would this succeed, and if not, why" without
writing anything. It returns the runtime verdict, approval state,
head, sanitized targets, default branches and `protectedBranch`:

```json
{
  "remote": "origin",
  "branch": "goal/publish",
  "head": "<sha>",
  "targets": ["https://github.com"],
  "defaultBranches": [],
  "protectedBranch": false,
  "runtime": { "ready": false, "reason": "push-credential-helper", "key": "credential.<url>.helper" },
  "approval": "missing"
}
```

A blocked verdict carries no branch list: the guard runs before any remote contact, so a runtime that cannot publish never triggers `ls-remote`. A ready preflight carries the resolved `defaultBranches` and the matching `protectedBranch`.

It does not return a `policy` field: reaching the tool already means policy allowed
the action, and the tool cannot publish anything. `approval` is read from
`publish_approvals` for the exact workspace, remote, branch and resolved head, so
`missing` means no receipt exists, `pending` means a live unconsumed receipt exists,
and `expired`/`consumed` mean a new approval is required. A lookup failure reports
`missing`, because a diagnostic must never claim an approval it could not read.
When the `ls-remote` lookup for default branches fails, or the preflight is blocked
before it contacts the remote, `defaultBranches` is `[]` and `protectedBranch` is not
authoritative.

This is what requirement 3 of #297 asks for: a caller can tell a policy-level allow
from a runtime authentication/credential block *before* attempting to publish.

## 7. Tests that must exist before this ships

Requirements 1–4, 6, 8 and 10 are covered by
`packages/application/src/git-service.test.ts`,
`packages/git/src/git-adapter.integration.test.ts`,
`packages/storage/src/publish-approval-repository.test.ts` and
`packages/mcp-server/src/tools/git-tools.test.ts`. Requirement 5 holds by
construction (the tool schema is `.strict()` with no force/tag/delete/all/mirror
field) and a schema test asserts option-shaped refs and unknown keys are rejected.
Requirement 7 is covered by the existing push-safety redaction tests plus the
adapter returning no stderr for publish; there is no separate publish-specific
token test. Requirement 9 is unchanged behaviour: `guarded_pr_merge` already
refuses a head that moved, and this PR does not touch it.

1. Unapproved publish is denied (`publish-approval-required`), and no Git child is spawned.
2. Approved publish of `origin` + `goal/*` + exact SHA succeeds against a local bare remote.
3. A receipt bound to a different SHA is rejected even when the branch name matches.
4. A protected/default branch is rejected regardless of approval.
5. `force`, `--all`, tags, deletes and `--mirror` are rejected at the schema level.
6. A credential helper configured in the repository does not run during publish.
7. Serialized results, logs and audit rows contain no token, helper path, or URL userinfo.
8. Authentication failure returns `publish-authentication-failed` and leaves the remote untouched.
9. Exact-head/tree verification and `guarded_pr_merge` still refuse a head that moved after publication.
10. A repository with `push.followTags=true` publishes the approved branch and no tag.

## 8. Non-goals

- Relaxing `validatePushSafety` for credential-bearing targets, or adding an "ignore safety" flag to `git push`. Scoping a check to the transports it can apply to is not a relaxation: no helper runs on the targets that skip the credential denial. The credential slice does not relax this either — it adds one host-owned helper behind an explicit `authorization` (see APPROVED_PUSH_PATH_CREDENTIALS.md §4), and `git push` itself is untouched.
- Publishing from an unleased or unscheduled session.
- Automatic PR creation, CI triggering, or merge from this tool.
- Supporting arbitrary remotes, multiple push URLs, or non-GitHub forges in the first slice.
