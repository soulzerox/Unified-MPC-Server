# Approved Push Path — Credential Mediation (S2 design)

Status: **S2a, S2b and S2c implemented; S2d not implemented.** S1 shipped in #552 and
covers every credential-free transport. This document designs the remaining
slice of #297:
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
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PublishCredentialPort {
  /** Host-side: store the operator secret for one lease. */
  grant(lease: PublishCredentialLease, secret: string): Promise<Result<void>>;
  /** Host-side: open one lease for the descriptor responder. Never a tool call. */
  open(leaseId: string, now: number): Promise<Result<PublishCredentialMaterial | null>>;
  /** Host-side: remove the secret, idempotently. */
  revoke(leaseId: string, now: number): Promise<Result<void>>;
}
```

`now` is a parameter rather than an ambient clock read so the expiry rule is
one testable expression: a lease answers only while `expiresAt > now`. The
ledger row keeps `createdAt` as well, so `status` can report a duration without
recomputing it from the Secret Service.

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

Credential targets additionally require a **promoted release**: a deployment
whose root is the permitted canonical checkout is the agent-writable
development tree, so a helper file living there could be rewritten by the model
and would still pass an ownership and mode check. In that deployment mode
`unified-mpc publish-credential grant` refuses with
`publish-credential-unsupported`, and consequently no credential target can
publish. Release deployments get the
helper from the promoted artifact, which the model does not write.

`-c` on the command line is not repository config, so nothing the model writes
into `.git/config` can add a second helper. The empty first assignment clears
inherited helpers for this invocation only; both assignments are host-built.

The post-push verification (`remoteBranchSha`, which shells out to `ls-remote`)
and the pre-approval default-branch resolution (§5) use the same
`-c`-scoped helper, because a private HTTP(S) remote answers neither without a
credential. They never inherit the secret any other way. The helper scope is an
explicit parameter of the publish path, not a new default: `remoteBranchSha` has
a second, unrelated caller (the guarded-rebase base refresh), and that caller
keeps today's behaviour with no helper, no lease and no `authorization`.

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

A lease whose target resolves to any scheme other than `https` is refused at
`grant` with `publish-credential-unsupported` before a secret is stored, so an
`http://` remote fails at the first step instead of later as an opaque
authentication failure.

### The artifact S2b ships

| Path | Content |
|---|---|
| `<deployment>/publish-credential-helper` | The fixed-path entry point: a `0555` `/bin/sh` launcher that `exec`s the compiled entry beside it. Written once, with the release. |
| `<deployment>/apps/cli/dist/bin/publish-credential-helper.js` | The compiled helper: argument, prompt and descriptor handling. |

`scripts/materialize-runtime-release.sh` writes both before the atomic release
rename, and refuses to materialize when the compiled entry is missing, so a
deployment either carries the helper or is never promoted. The fixed path is a
launcher rather than the compiled file itself because the release root has no
`node_modules` — only `apps/cli` carries the deployed dependency tree — and the
helper must import the same validators as the rest of the server instead of a
copy that could drift.

The host hands the helper one JSON line on an inherited pipe
(`UNIFIED_PUBLISH_CREDENTIAL_FD`, an integer `>= 3`) written before the spawn:

```json
{"version":1,"leaseId":"lease-id","username":"x-access-token","secret":"<operator-secret>","hosts":["github.com"],"expiresAt":1750000000000}
```

The helper re-checks the lease id, the expiry, the host set and the `https`
protocol against the prompt rather than trusting either side, so a host bug is
not the only thing between a forged prompt and a credential block. The wire
contract lives in `packages/domain/src/publish-credential-descriptor.ts`, which
is also where the S2c responder builds its answer. Both the prompt and the
answer are bounded (64 KiB) and the descriptor must be an inherited pipe; a
stalled or mistyped peer gets 15 seconds, so a broken host cannot hang a push
indefinitely.

Failure is one silent exit `1`: no stdout, no stderr, no file. A reason string
would be a diagnostic derived from a prompt the helper is forbidden to
reproduce; the operator reads the reason from `unified-mpc publish-credential
status`, which never needs the prompt.

A process that runs the helper directly still cannot obtain a secret. The lease
id is not itself a credential: the value is released only through `open`, which
the descriptor responder calls inside the server process that spawned the
helper, and only while the lease is live. Bounding the exposure is the
descriptor's lifetime plus the lease TTL, not the secrecy of the id.

This is a bound against the model, not against a process that already has the
server's uid. On a single-user host, `secret-tool lookup service unified-mpc key
publish-<leaseId>` reads the same entry, exactly as `/proc/<pid>/environ` exposes
an environment token to the same user. S2 removes the transcript, argv, config
and child-environment exposures; it does not claim to defend the host against
its own login, and it keeps the TTL short because of that.

## 4. Guard change

`validatePushSafety` stays the single place that decides whether a push-capable
Git child may spawn. Today a credential helper is denied whenever the resolved
target could use one, and that denial is exactly what #297 reports when a user
has any helper configured. The S2 form is narrower, not looser, and it is
parameterized because three different Gits need the helper at three different
moments:

```text
validatePushSafety(cwd, remote, options?: { signal?, argv?, authorization? })
authorization is one of
    | { kind: 'diagnostic', leaseId }              pre-approval `ls-remote`
    | { kind: 'publish',    leaseId, approvalId }  the push itself
    | { kind: 'verify',     leaseId, approvalId, spendNonce }  post-push `ls-remote`

if the target may use a credential helper:
    deny unless
        the invocation clears the helper list and then installs exactly
            <deployment>/publish-credential-helper
        and no other -c credential.* entry, GIT_* override or core.askPass exists
        and authorization is present and matches the mode:
            diagnostic: the lease is live and its host set equals the resolved set
            publish:    the receipt was consumed by this spawn (same spendNonce
                        proof as verify), its lease id is this lease, and the
                        receipt fingerprint equals the resolved push-URL set
            verify:     this receipt was consumed by the publish that is running
                        now (not merely "was consumed"), the lease id matches the
                        receipt row, and the spendNonce matches the one minted
                        for that spawn
```

Without an `authorization` the guard behaves exactly as today: a credential
helper on an HTTP(S) target is denied with `push-credential-helper`. The `git`
tool and `git push` never pass one, so nothing on that surface relaxes.

Both `publish` and `verify` are keyed to the receipt **this spawn consumed**, not
to a live receipt: S1 commits `consumed_at` before the push spawns, so a
"live receipt" condition could never hold at guard time. The publish path mints
the `spendNonce` in the same step that consumes the receipt — that is
`GitService.publish`, which owns `PublishApprovalAuthorityPort.consume` and
hands the adapter only `{ remote, branch, expectedSha }` today. The nonce and
the lease live in a registry owned by that service; the adapter receives the
resulting one-shot `authorization` (which carries the approval id only so the
guard can match it) and nothing else from the ledger.
The nonce is never accepted from a caller, a tool argument or the environment, and
dies with the spawn. The two modes differ only in what the Git child is allowed
to do — `publish` spawns the push, `verify` performs one `ls-remote` after it
exits — so the same proof covers the whole sequence without inventing a second
credential grant after approval.

A user-configured helper does not deny the publish path any more, because it
cannot run: the host-built argv starts with an empty `-c credential.helper=`,
which clears every helper Git collected from system, global, repository and
URL-scoped config for that one invocation, and then installs the host helper.
That reset is what makes the #297 scenario work — configuration is neutralized
instead of being a permanent veto. The reset is verified from the invocation the
adapter built, not from the repository: exactly two `credential.helper`
assignments, the first empty, the second the resolved helper, and nothing else
in command scope that can execute.

Every existing denial is unchanged: the fixed `GIT_SSH`, `GIT_SSH_COMMAND`,
`GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_PROXY_COMMAND` and `GIT_EXEC_PATH` override
list (the adapter's own `GIT_TERMINAL_PROMPT=0` is not an override),
`remote.<name>.receivepack|uploadpack|proxy|vcs`, `core.sshCommand|askPass|gitProxy`,
`push.gpgSign|recurseSubmodules`, `submodule.recurse`, `gpg.*.program`,
`protocol.*.allow`, an unresolvable hook location (`push-hook-location-unresolved`)
or a configured pre-push hook (`push-pre-push-hook`), and any additional `-c`
entry. The guard also re-checks the argv it is about to spawn (`argv` above):
the two-part reset-then-install shape is verified against the actual argument
list, not against a promise from the caller.
A wrong path, a symlinked path, a stale lease id, a host set that no longer
matches the receipt, a second helper assignment, a missing reset or a missing
`authorization` fails closed with the existing reasons plus
`publish-credential-unavailable` or `publish-target-changed`.

`git push` remains unchanged: it never gets the `-c` treatment and keeps denying
every HTTP(S) target that could run a helper, including under Full Bypass.

## 5. Lifecycle

```text
unified-mpc publish-credential grant <remote> --workspace <id> --username <user> --ttl 900
        |   secret from a no-echo TTY prompt or a pipe (stdin only, never argv or env);
        |   hosts resolved from the remote's single push URL; --ttl is whole seconds
        |   SecretToolSecretStore: publish-<leaseId>; ledger row: hosts, username, expiry
        v
git_publish_preflight   -> authorization 'diagnostic' for the default-branch ls-remote
                        -> runtime.ready stays false with publish-credential-required
                           when no live lease exists for this remote
publish_approve(userConfirmed)
                        -> receipt binds workspace, remote, branch, sha and the resolved
                           push-URL fingerprint, plus the lease id and min(receipt TTL, lease TTL)
git_publish(approvalId) -> spend receipt (S1, unchanged)
                        -> re-resolve push URLs; mismatch => publish-target-changed
                        -> spawn helper-scoped push                 ('publish')
                        -> helper-scoped remoteBranchSha verification ('verify' + spendNonce)
                        -> revoke publish-<leaseId>   (success, failure, timeout, abort)
```

Step by step that is `diagnostic` before the receipt, `publish` while spending
it, and `verify` for the single read that proves the ref landed; the three modes
are the parameter of §4, and no mode is reachable from a tool caller.

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
secret alive until its lease TTL, plus at most one sweep interval** (the TTL is
checked by `open`, so an expired lease answers nothing even before the sweep
deletes it). Mitigations: the TTL is minutes, the key is
the lease id, the receipt cannot be replayed, and `open` refuses an expired
lease. Reclamation does not happen in a `READ` tool: `git_publish_preflight`
stays side-effect free, and stale rows are deleted by the next `grant` or
`revoke` for the same workspace plus a sweep on server start **and on a timer**
(hourly, deleting leases whose `expiresAt` has passed), so a long-running
service cannot keep an abandoned secret past its TTL.

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

1. A repository with its own `credential.helper` still publishes through the
   host helper, and the configured helper is never executed (assert with a
   sentinel script that would create a file if it ran).
2. The same holds for a URL-scoped `credential.<url>.helper` entry, which the
   current guard special-cases.
3. A lease for `github.com` never answers a `gitlab.com` prompt (helper invoked
   directly with a forged prompt).
4. `store` and `erase` do nothing and exit non-zero.
5. The helper writes the secret to stdout only for a successful `get`, and
   never to stderr, a log, a file, argv or the environment; a failed `get`
   exits non-zero with empty stdout.
6. The secret is absent from the child argv, the child environment and the
   serialized tool result (assert by scanning all three).
7. An expired lease, a receipt consumed by an earlier publish (replay) and a
   mismatched lease id each fail closed with `publish-credential-unavailable`
   before any push spawns; a receipt consumed by the running spawn is the one
   case that proceeds.
8. `revoke` runs on success, on push failure, on timeout and on abort.
9. A helper path that is a symlink, resolves outside the running deployment, or
   belongs to another deployment than the running server is denied.
10. `git push` is still denied for the same HTTP(S) target, proving the publish
   path did not relax the general guard.
11. A credential-target remote with two push URLs is refused with
    `push-target-ambiguous`; the same remote still publishes over SSH.
12. `git_publish_preflight` performs no SecretStore write, including when a
    stale lease exists for the workspace.
13. Rewriting `remote.origin.url` after approval fails the spend with
    `publish-target-changed` and delivers no credential.
14. A private HTTP(S) fixture completes preflight, approve, push and the
    post-push verification with one lease, and the lease is gone afterwards.
15. `grant` refuses an `http://` target with `publish-credential-unsupported` and
    stores nothing.
16. The publish argv carries exactly two `credential.helper` assignments — an
    empty reset first, then the host helper — and a third assignment is denied.
17. A helper-scoped invocation with no `authorization` is denied with
    `push-credential-helper`, and a `verify` call with a `spendNonce` that the
    adapter did not mint is denied.
18. Both `publish` and `verify` are refused when the nonce belongs to a
    different spawn, and `verify` is refused before the push exits.
19. `unified-mpc publish-credential grant` refuses a canonical-checkout
    deployment with `publish-credential-unsupported`.
20. The expiry sweep deletes a lease whose TTL passed without any `revoke`,
    and asserts the `publish-<leaseId>` entry is gone from the SecretStore, not
    only that the ledger row is marked expired.

## 8. Slices

| Slice | Content | Ships independently |
|---|---|---|
| S2a | `PublishCredentialPort` implemented over the existing `SecretStore` port (`SecretToolSecretStore`, Linux Secret Service; no plaintext file, no new engine) with `publish-<leaseId>` keys, the lease ledger row, the operator CLI (`grant`/`revoke`/`status`) and grant/revoke/open tests | yes, no behavior change |
| S2b | helper entry point, emitted into the release artifact by `scripts/materialize-runtime-release.sh` so `<deployment>/publish-credential-helper` exists after promotion, + direct-invocation tests (no network) | yes |
| S2c | guard allowlist with the three authorization modes (`diagnostic`, `publish`, `verify`), `-c` argv on push and on both `ls-remote` paths, fingerprint-bound receipt, lease-for-the-spawn + revocation, end-to-end private HTTPS fixture | yes, the only slice that can publish over HTTP(S) |
| S2d | audit row, docs, operator runbook for rotating a token | yes |

S2c changes contracts that currently say the opposite, so it ships the wording
too: the `git_publish` description ("HTTP(S) targets that could run a credential
helper stay denied with the push safety reason"), the `git_publish_preflight`
description ("the push safety guard runs before any remote contact ... instead
of running ls-remote and a possible credential helper") in
`packages/mcp-server/src/tools/git-tools.ts`, and the paragraph in
`docs/architecture/MUTATION_SAFETY_MATRIX.md` that repeats "an HTTP(S) target
that could reach a credential helper stays denied". Those three strings are the
contract #297 is about making truthful.

S2a reuses the port rather than adding storage: if the Secret Service is
unavailable, `grant` fails with `publish-credential-unavailable` and S2c stays
unusable for HTTP(S) remotes. It deliberately does not extend `SecretEnvelope`'s
purpose list (`checkpoint_master_key`, `tunnel_api_key`), because the credential
is a live lease with a TTL, not a long-lived encrypted envelope.

What S2a actually shipped, so later slices build on the same seams:

| Concern | S2a placement |
|---|---|
| Lease, material and port | `packages/domain/src/publish-credential.ts`, re-exported from the domain index |
| Ledger row | `043_publish_credential_leases` (`publish_credential_leases`, indexed by `workspace_id, expires_at`) |
| Grant/open/revoke/sweep | `SqlitePublishCredentialRepository` over the existing `SecretStore`; the secret key is `publish-<leaseId>` |
| Operator surface | `unified-mpc publish-credential grant\|revoke\|status`; the secret is read from stdin only |
| Release gate | `resolvePublishCredentialDeployment` classifies `UNIFIED_MPC_ROOT` by its real path under `<runtimeDir>/releases/<id>`; unset, relative, unresolvable or nested paths do not prove a release, so `grant` refuses them |
| Reclamation | `startPublishCredentialSweep` in the MCP runtime: one sweep on start, then hourly, unref'd and failure-swallowing; the CLI also sweeps before each `publish-credential` command |

The gate is deliberately pure filesystem classification and deliberately not a
workspace property: the question is where the *running program* lives, because
that is the directory a helper file would have to be written into.

What S2b actually shipped, so S2c builds on the same seams:

| Concern | S2b placement |
|---|---|
| Wire contract | `packages/domain/src/publish-credential-descriptor.ts`: prompt parsing, host normalization, the one-line descriptor answer, the credential block |
| Helper logic | `apps/cli/src/runtime/publish-credential-helper.ts`: `get`-only, silent exit `1`, bounded reads with a 15 s stalled-peer guard |
| Process entry | `apps/cli/src/bin/publish-credential-helper.ts` → `dist/bin/publish-credential-helper.js` |
| Deployment artifact | `scripts/materialize-runtime-release.sh` emits `<deployment>/publish-credential-helper` (mode `0555`) and fails when the compiled entry is missing |
| Tests | Contract tests over injected I/O plus one real spawn of the built entry: success, forged host, expired lease, wrong lease id, missing descriptor, `store`/`erase`, empty stdout/stderr and a secret absent from argv and the environment |

What S2c actually shipped, so S2d builds on the same seams:

| Concern | S2c placement |
|---|---|
| Host binding | `fingerprintPublishCredentialHosts` in `packages/domain/src/publish-credential.ts`: a sorted, deduplicated `sha256:` digest of normalized hosts, never a URL |
| Receipt binding | `044_publish_approval_fingerprint` adds nullable `push_url_fingerprint` and `lease_id`; a half-bound or malformed pair is refused by `SqlitePublishApprovalRepository.record` |
| Live lease lookup | `PublishCredentialPort.findLive(workspaceId, remote, now)` returns metadata only; `open` still gates the secret |
| Preflight | `GitService.publishPreflight` opens a diagnostic lease; with none, a `push-credential-helper` block is reported as `publish-credential-required` |
| Approve | `GitService.approvePublish` resolves the push-host fingerprint, refuses `publish-target-changed` when it differs from the lease hosts, and stores the lease id with `min(receipt TTL, lease TTL)` |
| Spend | `GitService.publish` reads the receipt before contacting the remote, refuses `publish-credential-unavailable` for a consumed receipt, re-resolves the push-host fingerprint and refuses `publish-target-changed` before opening any lease, then requires the same live lease and passes its material to `adapter.publish` |
| Revocation | `GitService.publish` revokes the lease in a `finally` after success, push failure, timeout or abort; a failed revoke falls back to the TTL sweep |
| Runtime wiring | `apps/cli/src/runtime/stdio-mcp-runtime.ts` shares one `SqlitePublishCredentialRepository` between `GitService` and the expiry sweep, and injects the promoted-release classifier into `GitAdapter` |

## 9. Non-goals

- A general secret broker or keyring abstraction; #141 owns that, and S2 should
  consume it rather than invent a second store.
- OAuth device flow, GitHub App installation tokens, or any interactive login.
- Storing credentials for a remote the user has not approved for this exact
  workspace, branch and commit.
- Relaxing `git push`, or making the helper reachable by `shell`/`process_start`.
