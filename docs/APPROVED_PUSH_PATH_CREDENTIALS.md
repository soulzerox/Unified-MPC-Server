# Approved Push Path — Credential Mediation (S2 design)

Status: **proposal, not implemented.** S1 shipped in #552 and covers every
credential-free transport. This document designs the remaining slice of #297:
item 1 of the requested behavior, "supported credential-helper
mediation/approval if appropriate", for HTTP(S) targets.

S1 deliberately injects nothing and keeps asking the same question: *who is
allowed to make a credential available to a Git child, and how is that bounded?*
S2 answers it with a host-owned helper and a receipt-bound secret, and nothing
here relaxes the rule that a repository's own `credential.helper` must never run.

---

## 1. Why the obvious options are rejected

| Option | Why it does not ship |
|---|---|
| Put the token in the remote URL (`https://user:token@host/...`) | The URL is repository config: it reaches `remote get-url`, the preflight, logs and backups. Redaction would have to be perfect forever, and the value outlives the approval. |
| `GIT_ASKPASS` / `SSH_ASKPASS` pointing at a script | It is a program the model can point at, and `validatePushSafety` already denies it as an executable override (`push-environment-override`). |
| Token in the child environment | `/proc/<pid>/environ` is readable by the same user, crash dumps and shell traces record it, and the child can be a hook. The guard denies `GIT_*` overrides for the same reason. |
| Writing a temporary helper script per publish | The script is user-writable state on disk; a concurrent process can swap it between `write` and `exec`. |
| Allowing "the configured helper" when a grant exists | That is arbitrary code execution with the user's credentials behind a boolean. The denial exists precisely because the helper is a program, not a data source. |

The pattern that survives is: **one host-owned executable, at a fixed path, that
answers for exactly one approved host, reading its secret host-side.**

## 2. The seam

One new port in `packages/domain` (small interface, large implementation):

```ts
export interface PublishCredentialGrant {
  readonly workspaceId: string;
  readonly remote: string;
  readonly host: string;        // resolved from the receipt's remote, lowercased
  readonly approvalId: string;  // the S1 receipt that authorized this publish
  readonly expiresAt: number;
}

export interface PublishCredentialPort {
  /** Host-side: store the secret for an approval so the helper can read it. */
  grant(request: PublishCredentialGrant, secret: string): Promise<Result<void>>;
  /** Host-side: remove it, idempotently. Called on spend, expiry or cancel. */
  revoke(approvalId: string): Promise<Result<void>>;
  /** Host-side read used by the helper process, never by a tool handler. */
  read(approvalId: string): Promise<Result<string | null>>;
}
```

Deletion test: remove the port and every caller has to learn the SecretStore
layout, the approval key format, the expiry rule, the host normalization and the
revocation points. The complexity reappears in the application service, the
adapter, the CLI and every test. The port stays.

A grant names exactly one `host`, while `publish` resolves every push URL of
the remote (`git remote get-url --push --all`) and accepts a multi-URL remote.
One grant therefore cannot describe two targets, and a half-succeeded push
would follow an already-spent receipt. S2 refuses a remote that resolves to
more than one push URL with `push-target-ambiguous`, before any approval is
minted; multi-URL support stays a separate decision.

The Git side learns nothing new. `GitAdapter.publish` keeps its host-built
argv; the only change is a guard that accepts **one** helper and the helper's
own `-c` scope:

```text
git -c credential.helper= \
    -c credential.helper='!<runtime>/publish-credential-helper' \
    push --no-verify --no-follow-tags --porcelain <remote> <sha>:refs/heads/<branch>
```

`<runtime>` is the resolved installation directory of the running server
(`realpath` of its own entry point, which is a release under
`~/.local/share/unified-mpc/runtime/releases/<version>`), never a hand-written
path. Promotion re-points `runtime/current`, so the allowlist is compared
against the *resolved* directory: the helper's real path must equal
`<runtime>/publish-credential-helper`, live inside that same release directory,
be a regular file owned by the server's uid and not be group- or world-writable.
A symlinked helper, a path outside the running release, or a release that is
not the one this process was started from fails closed.

`-c` on the command line is not repository config, so nothing the model writes
into `.git/config` can add a second helper. The empty first assignment clears
inherited helpers for this invocation only; both assignments are host-built.

## 3. The helper

`publish-credential-helper` is a small separate entry point inside the resolved
runtime directory (§2), with no ambient state:

- Git appends exactly one operation argument (`get`, `store` or `erase`). The
  helper answers only `get`. `store` and `erase` exit `1` without writing
  anything.
- On `get` it writes the Git credential attribute block to stdout
  (`username=<host-user>` and `password=<secret>`), because stdout is the only
  channel Git reads an answer from. That is the one place the secret leaves the
  server process, and it goes to the Git child that is already receiving it.
- Everything else stays silent: the helper never writes the secret, the prompt
  or a diagnostic to a log, a file, its argv or stderr, and it never echoes the
  prompt back.
- It reads `protocol`, `host` and `path` from the prompt Git writes on stdin.
- It looks up the approval id from its own environment
  (`UNIFIED_PUBLISH_APPROVAL_ID`, set by the adapter at spawn, not by a caller)
  and asks the host process for the secret over an inherited file descriptor —
  the secret never appears in the helper's argv or environment.
- It returns the secret only when protocol is `https`, host equals the grant
  host, the grant has not expired and the inherited descriptor answers;
  otherwise it exits `1`.

A process that runs the helper directly still cannot obtain a secret. The
approval id is not itself a credential: the value lives in the host SecretStore
and is released only to a helper holding a live inherited descriptor from the
server that spawned it. Bounding the exposure is the descriptor's lifetime plus
the grant TTL, not the secrecy of the id.

## 4. Guard change

`validatePushSafety` stays the single place that decides whether a push may
spawn. Today a credential helper is denied whenever the resolved target could
use one. The S2 form is narrower, not looser:

```text
if the target may use a credential helper:
    deny unless
        the repository config contains no credential helper   (unchanged)
        and the invoke-level helper is exactly <runtime>/publish-credential-helper
        and its approval id matches a live, unexpired receipt for this binding
```

Everything else stays denied: `remote.<name>.receivepack`, `core.sshCommand`,
`push.gpgSign`, `protocol.*.allow`, `GIT_*` overrides and any helper the user
configured. A wrong path, a symlinked path, a stale approval id or a second
`-c credential.helper` fails closed with the existing reasons plus
`publish-credential-unavailable`.

`git push` remains unchanged: it never gets the `-c` treatment and keeps denying
every HTTP(S) target that could run a helper, including under Full Bypass.

## 5. Lifecycle

```text
publish_approve(userConfirmed)                    -> receipt (S1, unchanged)
unified-mpc publish-credential grant <approvalId> [CLI, TTY, secret on stdin]
        |
        |  SecretToolSecretStore: publish/<approvalId>, TTL == receipt TTL
        v
git_publish(approvalId)  ->  spend receipt (S1, unchanged)
                         ->  spawn helper-scoped push
                         ->  revoke publish/<approvalId>   (success, failure, timeout)
```

The secret enters through the operator CLI (`unified-mpc publish-credential
grant`), which reads it from a no-echo TTY prompt or a pipe, never from argv,
an environment variable or a tool argument. This is deliberately not an MCP
tool: tool arguments are serialized into the transcript and the audit row, and
a model-supplied secret would be a secret in the transcript. `revoke` and
`status` (expiry only, no value) are the other two subcommands; all three are
host-local and require the same OS user as the server, so the MCP surface never
gains a path that accepts a credential.

Two revocation shapes were considered:

- **Revoke-before-spawn.** It applies the S1 spend rule to the secret, but the
  child needs the secret during the spawn, so the value has to be delivered
  first. That reintroduces the leak this design removes.
- **Lease-for-the-spawn.** The secret stays in the SecretStore for the duration
  of one spawn, the helper reads it over the inherited descriptor, and the
  adapter revokes on exit with the receipt already consumed. A later publish for
  the same approval id is refused because the receipt is gone.

S2 adopts the second and states the residue: **a crashed publisher can leave a
secret alive until its TTL.** Mitigations: the TTL is minutes, the key is the
approval id, the receipt cannot be replayed, and `read` refuses an expired
grant. Reclamation does not happen in a `READ` tool: `git_publish_preflight`
stays side-effect free, and stale rows are deleted by the next `grant` or
`revoke` for the same workspace plus a startup sweep, so a preflight can never
delete the live grant of a pending approval.

## 6. Trust model

S2 does not upgrade the human gate. `userConfirmed: true` remains the caller's
assertion of a chat approval (trust model B), the host exact-action dialog stays
required in every built-in profile except Full Bypass, and Full Bypass still
skips it. The receipt continues to bound *what* can be published; the grant
additionally bounds *which host* may see a credential, for how long, and through
which executable.

## 7. Tests that must exist before S2 ships

1. A repository with its own `credential.helper` is still denied, even with a
   live grant.
2. A grant for `github.com` never answers a `gitlab.com` prompt (helper invoked
   directly with a forged prompt).
3. `store` and `erase` do nothing and exit non-zero.
4. The helper writes the secret to stdout only for a successful `get`, and
   never to stderr, a log, a file, argv or the environment; a failed `get`
   exits non-zero with empty stdout.
5. The secret is absent from the child argv, the child environment and the
   serialized tool result (assert by scanning all three).
6. An expired grant, a consumed receipt and a mismatched approval id each fail
   closed with `publish-credential-unavailable` before any push spawns.
7. `revoke` runs on success, on push failure, and on timeout.
8. A helper path that is a symlink, resolves outside the running release
   directory, or belongs to another release than the running server is denied.
9. `git push` is still denied for the same HTTP(S) target, proving the publish
   path did not relax the general guard.
10. A remote with two push URLs is refused at `publish_approve` with
    `push-target-ambiguous`.
11. `git_publish_preflight` performs no SecretStore write, including when a
    stale grant exists for the workspace.

## 8. Slices

| Slice | Content | Ships independently |
|---|---|---|
| S2a | `PublishCredentialPort` implemented over the existing `SecretStore` port (`SecretToolSecretStore`, Linux Secret Service; no plaintext file, no new engine) under the `publish/<approvalId>` key namespace, plus the operator CLI (`grant`/`revoke`/`status`) and grant/revoke/read tests | yes, no behavior change |
| S2b | helper entry point + direct-invocation tests (no network) | yes |
| S2c | guard allowlist, `-c` argv, lease-for-the-spawn + revocation, end-to-end local HTTPS fixture | yes, the only slice that can publish over HTTP(S) |
| S2d | audit row, docs, operator runbook for rotating a token | yes |

S2a reuses the port rather than adding storage: if the Secret Service is
unavailable, `grant` fails with `publish-credential-unavailable` and S2c stays
unusable for HTTP(S) remotes. It deliberately does not extend `SecretEnvelope`'s
purpose list (`checkpoint_master_key`, `tunnel_api_key`), because the credential
is a live lease with a TTL, not a long-lived encrypted envelope.

## 9. Non-goals

- A general secret broker or keyring abstraction; #141 owns that, and S2 should
  consume it rather than invent a second store.
- OAuth device flow, GitHub App installation tokens, or any interactive login.
- Storing credentials for a remote the user has not approved for this exact
  workspace, branch and commit.
- Relaxing `git push`, or making the helper reachable by `shell`/`process_start`.
