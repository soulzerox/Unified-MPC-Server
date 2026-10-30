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
answers for exactly one approved target, reading its secret host-side.**

## 2. The seam

One new port in `packages/domain` (small interface, large implementation):

```ts
export interface PublishCredentialLease {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly remote: string;
  /** Resolved push targets at grant time: lowercase host + optional port. */
  readonly hosts: readonly string[];
  readonly username: string;   // operator-supplied, never model-supplied
  readonly expiresAt: number;
}

export interface PublishCredentialPort {
  /** Host-side: store the operator secret for one lease. */
  grant(lease: PublishCredentialLease, secret: string): Promise<Result<void>>;
  /** Host-side: read one lease, used by the helper process only. */
  read(leaseId: string): Promise<Result<PublishCredentialLease | null>>;
  /** Host-side: remove the secret, idempotently. */
  revoke(leaseId: string): Promise<Result<void>>;
}
```

Deletion test: remove the port and every caller has to learn the SecretStore
layout, the key format, the expiry rule, the host normalization and the
revocation points. The complexity reappears in the application service, the
adapter, the CLI and every test. The port stays.

The secret itself is stored through the existing `SecretStore` port
(`SecretToolSecretStore`, Linux Secret Service; never a plaintext file), under a
charset-safe key: `normalizeKey` accepts only `[A-Za-z0-9._-]{1,128}`, so the key
is `publish-<leaseId>`, not a path-shaped `publish/<leaseId>`. Lease metadata
(hosts, username, expiry, workspace) lives in the publish ledger next to the S1
receipts; no second storage engine is introduced.

**One grant names one target set.** `publish` resolves every push URL of the
remote (`git remote get-url --push --all`). A remote that resolves to more than
one push URL is refused for credential targets with `push-target-ambiguous`: the
helper answers one host, and a half-succeeded push must not follow a spent
receipt. Credential-free transports keep S1 behaviour unchanged, including
multi-URL remotes.

### The helper invocation

`GitAdapter.publish` keeps its host-built argv; the only change is a guard that
accepts **one** helper and the helper's own `-c` scope:

```text
git -c credential.helper= \
    -c credential.helper='!<deployment>/publish-credential-helper' \
    push --no-verify --no-follow-tags --porcelain <remote> <sha>:refs/heads/<branch>
```

`<deployment>` is the resolved root of the running server (the real path of its
own entry point — a promoted release under
`~/.local/share/unified-mpc/runtime/releases/<deployment-id>` or a permitted
canonical checkout), never a hand-written path. The allowlist compares the
helper's real path to `<deployment>/publish-credential-helper` and additionally
requires a regular file, owned by the server's uid, not group- or
world-writable, and still inside the deployment the process was started from. A
symlinked helper, a path outside that deployment, or a deployment that changed
under a running process fails closed.

`-c` on the command line is not repository config, so nothing the model writes
into `.git/config` can add a second helper. The empty first assignment clears
inherited helpers for this invocation only; both assignments are host-built.

The post-push verification (`remoteBranchSha`, which shells out to `ls-remote`)
and the pre-approval default-branch resolution (§5) use the same
`-c`-scoped helper, because a private HTTP(S) remote answers neither without a
credential. They never inherit the secret any other way.

## 3. The helper

`publish-credential-helper` is a small separate entry point inside the resolved
deployment directory (§2), with no ambient state:

- Git appends exactly one operation argument (`get`, `store` or `erase`). The
  helper answers only `get`. `store` and `erase` exit `1` without writing
  anything.
- On `get` it writes the Git credential attribute block to stdout
  (`username=<lease username>` and `password=<secret>`), because stdout is the
  only channel Git reads an answer from. That is the one place the secret leaves
  the server process, and it goes to the Git child that is already receiving it.
- Everything else stays silent: the helper never writes the secret, the prompt
  or a diagnostic to a log, a file, its argv or stderr, and it never echoes the
  prompt back.
- It reads `protocol`, `host` and `path` from the prompt Git writes on stdin.
- It receives the lease id in its own environment (`UNIFIED_PUBLISH_LEASE_ID`,
  set by the adapter at spawn, not by a caller) and asks the host process for
  the lease over an inherited file descriptor — the secret never appears in the
  helper's argv or environment.
- It answers only when protocol is `https`, the prompt host (lowercased, with
  the resolved port when non-default) is in the lease's host set, the lease has
  not expired and the inherited descriptor answers; otherwise it exits `1`.

A process that runs the helper directly still cannot obtain a secret. The lease
id is not itself a credential: the value lives in the host SecretStore and is
released only to a helper holding a live inherited descriptor from the server
that spawned it. Bounding the exposure is the descriptor's lifetime plus the
lease TTL, not the secrecy of the id.

## 4. Guard change

`validatePushSafety` stays the single place that decides whether a push may
spawn. Today a credential helper is denied whenever the resolved target could
use one. The S2 form is narrower, not looser:

```text
if the target may use a credential helper:
    deny unless
        the repository and global config contain no credential helper
        and the invoke-level helper is exactly <deployment>/publish-credential-helper
        and the receipt carries a live lease id whose host set equals the
            resolved push-URL host set recorded in the receipt
```

The config query keeps reading only what `git config --get-regexp` reports from the
config files (repository, global, system); a host-injected `-c credential.helper`
is not a config entry, so the guard does not trip on its own injection.

Everything else stays denied: `remote.<name>.receivepack`, `core.sshCommand`,
`push.gpgSign`, `protocol.*.allow`, `GIT_*` overrides and any helper the user
configured. A wrong path, a symlinked path, a stale lease id, a host set that no
longer matches the receipt, or a second `-c credential.helper` fails closed with
the existing reasons plus `publish-credential-unavailable` or
`publish-target-changed`.

`git push` remains unchanged: it never gets the `-c` treatment and keeps denying
every HTTP(S) target that could run a helper, including under Full Bypass.

## 5. Lifecycle

```text
unified-mpc publish-credential grant <workspace> <remote> --username <user> --ttl 15m
        |   secret from a no-echo TTY prompt or a pipe; hosts resolved from the remote
        |   SecretToolSecretStore: publish-<leaseId>; ledger row: hosts, username, expiry
        v
git_publish_preflight   -> resolves default branches through the same helper scope
                        -> runtime.ready stays false with publish-credential-required
                           when no live lease exists for this remote
publish_approve(userConfirmed)
                        -> receipt binds workspace, remote, branch, sha and the resolved
                           push-URL fingerprint, plus the lease id and min(receipt TTL, lease TTL)
git_publish(approvalId) -> spend receipt (S1, unchanged)
                        -> re-resolve push URLs; mismatch => publish-target-changed
                        -> spawn helper-scoped push
                        -> helper-scoped remoteBranchSha verification
                        -> revoke publish-<leaseId>   (success, failure, timeout, abort)
```

The secret enters through the operator CLI (`unified-mpc publish-credential
grant`), which reads it from a no-echo TTY prompt or a pipe, never from argv,
an environment variable or a tool argument. This is deliberately not an MCP
tool: tool arguments are serialized into the transcript and the audit row, and
a model-supplied secret would be a secret in the transcript. `revoke` and
`status` (expiry and hosts only, never the value) are the other two
subcommands; all three are host-local and require the same OS user as the
server, so the MCP surface never gains a path that accepts a credential.

The grant exists before the approval on purpose. `publish_approve` needs
`defaultBranches`, which is an authenticated `ls-remote` on a private HTTP(S)
remote, and the guard must already permit the helper for that read; a lease that
only arrived after the approval could never mint one.

Two revocation shapes were considered:

- **Revoke-before-spawn.** It applies the S1 spend rule to the secret, but the
  child needs the secret during the spawn and the post-push verification needs
  it again, so the value has to be delivered first. That reintroduces the leak
  this design removes.
- **Lease-for-the-spawn.** The secret stays in the SecretStore for the duration
  of one push plus its verification, the helper reads it over the inherited
  descriptor, and the adapter revokes in a `finally` with the receipt already
  consumed. A later publish for the same approval id is refused because the
  receipt is gone, and the lease is gone with it.

S2 adopts the second and states the residue: **a crashed publisher can leave a
secret alive until its lease TTL.** Mitigations: the TTL is minutes, the key is
the lease id, the receipt cannot be replayed, and `read` refuses an expired
lease. Reclamation does not happen in a `READ` tool: `git_publish_preflight`
stays side-effect free, and stale rows are deleted by the next `grant` or
`revoke` for the same workspace plus a startup sweep, so a preflight can never
delete the live lease of a pending approval.

## 6. Trust model

S2 does not upgrade the human gate. `userConfirmed: true` remains the caller's
assertion of a chat approval (trust model B), the host exact-action dialog stays
required in every built-in profile except Full Bypass, and Full Bypass still
skips it. The receipt continues to bound *what* can be published; the lease and
its fingerprint additionally bound *which host* may see a credential, for how
long, and through which executable.

The host binding is the receipt's resolved push-URL fingerprint, not the remote
name: `.git/config` is agent-writable, so `publish` re-resolves the URLs at
spend time and refuses when they differ from what the human approved. Rewriting
`remote.origin.url` between approve and push can therefore not redirect the
secret to an unapproved host.

## 7. Tests that must exist before S2 ships

1. A repository with its own `credential.helper` is still denied, even with a
   live lease.
2. A lease for `github.com` never answers a `gitlab.com` prompt (helper invoked
   directly with a forged prompt).
3. `store` and `erase` do nothing and exit non-zero.
4. The helper writes the secret to stdout only for a successful `get`, and
   never to stderr, a log, a file, argv or the environment; a failed `get`
   exits non-zero with empty stdout.
5. The secret is absent from the child argv, the child environment and the
   serialized tool result (assert by scanning all three).
6. An expired lease, a consumed receipt and a mismatched lease id each fail
   closed with `publish-credential-unavailable` before any push spawns.
7. `revoke` runs on success, on push failure, on timeout and on abort.
8. A helper path that is a symlink, resolves outside the running deployment, or
   belongs to another deployment than the running server is denied.
9. `git push` is still denied for the same HTTP(S) target, proving the publish
   path did not relax the general guard.
10. A credential-target remote with two push URLs is refused with
    `push-target-ambiguous`; the same remote still publishes over SSH.
11. `git_publish_preflight` performs no SecretStore write, including when a
    stale lease exists for the workspace.
12. Rewriting `remote.origin.url` after approval fails the spend with
    `publish-target-changed` and delivers no credential.
13. A private HTTP(S) fixture completes preflight, approve, push and the
    post-push verification with one lease, and the lease is gone afterwards.

## 8. Slices

| Slice | Content | Ships independently |
|---|---|---|
| S2a | `PublishCredentialPort` implemented over the existing `SecretStore` port (`SecretToolSecretStore`, Linux Secret Service; no plaintext file, no new engine) with `publish-<leaseId>` keys, the lease ledger row, the operator CLI (`grant`/`revoke`/`status`) and grant/revoke/read tests | yes, no behavior change |
| S2b | helper entry point + direct-invocation tests (no network) | yes |
| S2c | guard allowlist, `-c` argv on push and on both `ls-remote` paths, fingerprint-bound receipt, lease-for-the-spawn + revocation, end-to-end private HTTPS fixture | yes, the only slice that can publish over HTTP(S) |
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
